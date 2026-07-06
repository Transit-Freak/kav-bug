#!/usr/bin/env node
/* ===========================================================================
   קו באג — סריקת כל הארץ (Node.js)
   ---------------------------------------------------------------------------
   קורא את קובץ ה-GTFS הארצי המלא (israel-public-transportation.zip) בריצה אחת,
   מריץ את אותו מנוע-זיהוי כמו האתר (data.js) ואת אותה הכרעה דטרמיניסטית
   (components.jsx), ומפיק דוח של *כל* העיקופים/לולאות בארץ — בלי מגבלות הדפדפן.

   שימוש:
     npm install fflate
     node --max-old-space-size=4096 scan-country.js <path-to.zip> [out-prefix]

   פלט:
     <out-prefix>.json  — דוח מלא
     <out-prefix>.csv   — טבלה לגיליון אלקטרוני
   (ברירת-מחדל ל-out-prefix: "kavbug-country")
   =========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

// ---- fflate (לפענוח ה-ZIP בזרימה) ----
let fflate;
for (const p of ["fflate", path.join(__dirname, "node_modules", "fflate"), "/tmp/node_modules/fflate"]) {
  try { fflate = require(p); break; } catch (_e) { /* keep trying */ }
}
if (!fflate) {
  console.error('חסר המודול fflate. התקן עם:  npm install fflate');
  process.exit(1);
}

// ---- ארגומנטים ----
const zipPath = process.argv[2];
const outPrefix = process.argv[3] || "kavbug-country";
if (!zipPath) {
  console.error("שימוש: node scan-country.js <israel-public-transportation.zip> [out-prefix]");
  process.exit(1);
}

const MIN_STOPS = 3;       // כמו באתר (minStops)
const MIN_EXCESS = 0.05;   // כמו באתר (minExcess)
const DEFAULT_COLOR = "#5b6470"; // הצבע אינו משפיע על הזיהוי

// מרחק (מ') בין שתי נקודות [lat,lng]
function havM(a, b) { const R = 6371000, T = x => x * Math.PI / 180; const dLat = T(b[0] - a[0]), dLng = T(b[1] - a[1]), la1 = T(a[0]), la2 = T(b[0]); return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2)); }
// מרחק (מ') מנקודה לפוליגון (לכל הקטעים) — קירוב מישורי מקומי
function distToPath(p, path) {
  if (!path || path.length < 2) return Infinity;
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110570;
  const PX = p[1] * kx, PY = p[0] * ky; let min = Infinity;
  for (let i = 1; i < path.length; i++) {
    const ax = path[i - 1][1] * kx, ay = path[i - 1][0] * ky, bx = path[i][1] * kx, by = path[i][0] * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    let t = ((PX - ax) * dx + (PY - ay) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(PX - (ax + t * dx), PY - (ay + t * dy));
    if (d < min) min = d;
  }
  return min;
}

// ניווט אובייקטיבי: הדרך הקצרה-בכביש בין שתי נקודות, דרך OSRM (OpenStreetMap).
// מחזיר { km, route:[[lat,lng]...] } או null. שרת-ההדגמה הציבורי חינמי אך משותף —
// לשימוש כבד כדאי לארח OSRM עצמאי. (זהו "חסם-תחתון": מסלול רכב פרטי; אוטובוס עשוי
// להיות ארוך יותר לגיטימית, לכן משתמשים בזה עם סף נדיב + בדיקת-תחנות.)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// שרת-ההדגמה הציבורי לפעמים מחזיר 503 חולף (עומס-רגע/backend מתחלף בין כמה
// שרתים) — לא חסימה קבועה. עם retries+backoff סביר זה חולף תוך שניות בודדות.
async function osrmFetch(url, retries) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "kavbug" } });
      if (r.ok) return await r.json();
    } catch (e) { /* ניסיון הבא */ }
    await sleep(1500 * (attempt + 1));
  }
  return null;
}
// מחזיר { km, route:[[lat,lng]...]|null } או null. route עלול לחסור גם כשה-km
// תקין (הבקשה עם geometries נכשלת בנפרד מזו של המרחק) — עדיין שימושי לפתרון
// "ספק" גם בלי לצייר קו. לשימוש כבד כדאי לארח OSRM עצמאי, לא את שרת-ההדגמה.
async function osrmRoute(A, B) {
  const base = `https://router.project-osrm.org/route/v1/driving/${A[1]},${A[0]};${B[1]},${B[0]}`;
  const distJ = await osrmFetch(`${base}?overview=false`, 4);
  if (!distJ || distJ.code !== "Ok" || !distJ.routes || !distJ.routes[0]) return null;
  const km = distJ.routes[0].distance / 1000;
  const geoJ = await osrmFetch(`${base}?overview=full&geometries=geojson`, 3);
  const rt = geoJ && geoJ.code === "Ok" && geoJ.routes && geoJ.routes[0];
  const route = rt && rt.geometry ? rt.geometry.coordinates.map((c) => [c[1], c[0]]) : null;
  return { km, route };
}

// =====================  פענוח CSV/ZIP (מותאם מ-gtfs-worker.js)  =============
function parseCSV(line) {
  if (line.indexOf('"') < 0) return line.split(",");
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  }
  out.push(cur); return out;
}
function lineSplitter(onLine) {
  let buf = ""; const dec = new TextDecoder("utf-8");
  return function (chunk, final) {
    buf += dec.decode(chunk, { stream: !final });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line) onLine(line);
    }
    if (final && buf.length) { onLine(buf); buf = ""; }
  };
}
function rowHandler(rowFn) {
  let idx = null;
  return function (line) {
    const f = parseCSV(line);
    if (idx === null) { idx = {}; f.forEach((name, i) => (idx[name.trim().replace(/^﻿/, "")] = i)); return; }
    rowFn(f, idx);
  };
}
// מעבר זרימה סינכרוני על ה-ZIP (ב-Node אין UI לחסום, אז בלי setTimeout).
function runUnzip(u8, handlers) {
  const unzip = new fflate.Unzip();
  unzip.register(fflate.UnzipInflate);
  unzip.onfile = (file) => {
    const key = Object.keys(handlers).find((k) => file.name.endsWith(k));
    if (!key) return; // קובץ לא-נדרש — לא מפענחים (חיסכון)
    const spec = handlers[key];
    const split = lineSplitter(spec.onLine);
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      if (chunk && chunk.length) split(chunk, false);
      if (final) { split(new Uint8Array(0), true); if (spec.onEnd) spec.onEnd(); }
    };
    file.start();
  };
  const CHUNK = 1 << 22; // 4MB
  for (let off = 0; off < u8.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, u8.length);
    unzip.push(u8.subarray(off, end), end >= u8.length);
  }
}

// =====================  טעינת מנוע-הזיהוי (data.js) עם shim ל-window  =======
global.window = {};
require("./data.js");
const D = global.window.KavBugData;
if (!D || !D.analyzeCity) { console.error("טעינת data.js נכשלה"); process.exit(1); }

// =====================  טעינת ההכרעה הדטרמיניסטית (components.jsx)  =========
// פונקציות-ההכרעה הן JavaScript טהור (ללא JSX), אז חותכים את הבלוק לפי שמות
// ומריצים אותו — בלי צורך ב-Babel.
function loadVerdict() {
  const c = fs.readFileSync(path.join(__dirname, "components.jsx"), "utf8");
  const start = c.indexOf("function entryAxisDisqualified");
  const end = c.indexOf("async function runAIVerdict");
  if (start < 0 || end < 0) throw new Error("לא נמצא בלוק-ההכרעה ב-components.jsx");
  const src = c.slice(start, end);
  return new Function(src + "; return { fallbackVerdict, entryAxisDisqualified, selfBacktrackLoop };")();
}
const V = loadVerdict();

// משקף את מסלול-ההכרעה של runAIVerdict *ללא* AI (כפי שרץ באתר כשאין שרת-AI).
function verdictOf(d) {
  try {
    if (d.kind === "selfloop") return V.fallbackVerdict(d);
    const loop = V.selfBacktrackLoop(d);
    if (loop) return loop;
    const eax = V.entryAxisDisqualified(d);
    if (eax.bad) return { verdict: eax.verdict || "לא ניתן להשוואה", reason: eax.reason };
    return V.fallbackVerdict(d);
  } catch (e) { return { verdict: "(שגיאת-הכרעה)", reason: String(e && e.message) }; }
}

// =====================  הריצה  =============================================
function tnow() { return Date.now(); }
function secs(ms) { return (ms / 1000).toFixed(1) + "ש'"; }

(async function main() {
  const t0 = tnow();
  console.error("קורא את הקובץ:", zipPath);
  const u8 = new Uint8Array(fs.readFileSync(zipPath));
  console.error("גודל:", (u8.length / 1048576).toFixed(0), "MB");

  // ---- מעבר 1: תחנות / מפעילים / קווים ----
  const stops = new Map(), agencies = new Map(), routes = new Map();
  console.error("מעבר 1/4: תחנות, מפעילים, קווים…");
  runUnzip(u8, {
    "stops.txt": { onLine: rowHandler((f, ix) => {
      const lat = +f[ix["stop_lat"]], lng = +f[ix["stop_lon"]];
      if (!isFinite(lat) || !isFinite(lng)) return;
      stops.set(f[ix["stop_id"]], { name: (f[ix["stop_name"]] || "").trim(), lat, lng });
    }) },
    "agency.txt": { onLine: rowHandler((f, ix) => {
      agencies.set(f[ix["agency_id"]], (f[ix["agency_name"]] || "").trim());
    }) },
    "routes.txt": { onLine: rowHandler((f, ix) => {
      routes.set(f[ix["route_id"]], {
        number: (f[ix["route_short_name"]] || "").trim(),
        name: (f[ix["route_long_name"]] || "").trim(),
        agencyId: f[ix["agency_id"]],
      });
    }) },
  });
  console.error("  תחנות:", stops.size, "| קווים (routes):", routes.size);

  // ---- מעבר 2: stop_times — דדופ לנציג אחד לכל חתימת-מסלול (כל הארץ, ללא תיבה) ----
  console.error("מעבר 2/4: stop_times (החלק הארוך)…");
  const bySig = new Map();
  let curTrip = null, curRows = null;
  const flush = () => {
    if (!curRows || !curRows.length) return;
    if (curRows.length >= MIN_STOPS) {
      curRows.sort((a, b) => a[0] - b[0]);
      const ids = curRows.map((r) => r[1]);
      const sig = ids[0] + "|" + ids[ids.length - 1] + "|" + ids.length;
      const ex = bySig.get(sig);
      if (!ex || curRows.length > ex.hits) bySig.set(sig, { trip: curTrip, hits: curRows.length, ids });
    }
  };
  runUnzip(u8, {
    "stop_times.txt": {
      onLine: rowHandler((f, ix) => {
        const t = f[ix["trip_id"]];
        if (t !== curTrip) { flush(); curTrip = t; curRows = []; }
        curRows.push([+f[ix["stop_sequence"]], f[ix["stop_id"]]]);
      }),
      onEnd: flush,
    },
  });
  console.error("  נציגי-מסלול ייחודיים:", bySig.size);

  // ---- מעבר 3: trips של הנציגים -> route_id + shape_id ----
  console.error("מעבר 3/4: trips…");
  const repTrips = new Set();
  for (const v of bySig.values()) repTrips.add(v.trip);
  const tripRoute = new Map(), tripShape = new Map();
  // ספירת נסיעות לכל קו לפי service_id — כדי לאמוד "יום עמוס" (ה-service עם הכי
  // הרבה נסיעות, בקירוב יום חול עמוס). משמש לחישוב ק"מ-מבוזבזים ביום.
  const routeSvc = new Map(); // route_id -> Map(service_id -> count)
  runUnzip(u8, {
    "trips.txt": { onLine: rowHandler((f, ix) => {
      const t = f[ix["trip_id"]];
      const rid = f[ix["route_id"]], svc = ix["service_id"] != null ? f[ix["service_id"]] : "";
      if (rid) { let m = routeSvc.get(rid); if (!m) { m = new Map(); routeSvc.set(rid, m); } m.set(svc, (m.get(svc) || 0) + 1); }
      if (!repTrips.has(t)) return;
      tripRoute.set(t, rid);
      if (ix["shape_id"] != null) { const sid = (f[ix["shape_id"]] || "").trim(); if (sid) tripShape.set(t, sid); }
    }) },
  });
  const tripsBusiest = new Map(); // route_id -> נסיעות ביום העמוס (max על פני services)
  for (const [rid, m] of routeSvc) { let mx = 0; for (const c of m.values()) if (c > mx) mx = c; tripsBusiest.set(rid, mx); }

  // נציג אחד לכל route (עדיפות: יש shape, ואז הכי הרבה תחנות)
  const bestPerRoute = new Map();
  for (const entry of bySig.values()) {
    const rid = tripRoute.get(entry.trip);
    if (!rid) continue;
    const cur = bestPerRoute.get(rid);
    if (!cur) { bestPerRoute.set(rid, entry); continue; }
    const eS = tripShape.has(entry.trip) ? 1 : 0, cS = tripShape.has(cur.trip) ? 1 : 0;
    if (eS > cS || (eS === cS && entry.hits > cur.hits)) bestPerRoute.set(rid, entry);
  }
  console.error("  קווים (נציג לכל route):", bestPerRoute.size);

  // רצף-התחנות *המסודר* של כל וריאנט לכל קו (לפי מספר). משמש לזהות "כיסוי שכונה":
  // וריאנט שעוצר בתחנת-ביניים *בין* שתי תחנות-הקצה של המקטע. חשוב שהבדיקה תהיה
  // לפי רצף-הנסיעה ולא רק קרבה-גיאוגרפית: קו עלול לעבור *ליד* תחנה שהוא כבר שירת
  // קודם (חפיפת-מסלול) — וזה אינו כיסוי של המקטע הזה.
  const lineVariants = new Map(); // number -> [ [ [lat,lng], ... ] ]
  for (const v of bySig.values()) {
    const rid = tripRoute.get(v.trip); if (!rid) continue;
    const info = routes.get(rid); if (!info) continue;
    const seq = [];
    for (const id of v.ids) { const s = stops.get(id); if (s) seq.push([s.lat, s.lng]); }
    if (seq.length < 2) continue;
    let arr = lineVariants.get(info.number); if (!arr) { arr = []; lineVariants.set(info.number, arr); }
    arr.push(seq);
  }

  // ---- מעבר 4: shapes של הנציגים ----
  console.error("מעבר 4/4: shapes (מסלולים מדויקים)…");
  const neededShapes = new Set();
  for (const entry of bestPerRoute.values()) { const sid = tripShape.get(entry.trip); if (sid) neededShapes.add(sid); }
  const shapeRaw = new Map();
  if (neededShapes.size) {
    runUnzip(u8, {
      "shapes.txt": { onLine: rowHandler((f, ix) => {
        const sid = f[ix["shape_id"]];
        if (!neededShapes.has(sid)) return;
        const lat = +f[ix["shape_pt_lat"]], lng = +f[ix["shape_pt_lon"]];
        if (!isFinite(lat) || !isFinite(lng)) return;
        let arr = shapeRaw.get(sid); if (!arr) { arr = []; shapeRaw.set(sid, arr); }
        arr.push([+f[ix["shape_pt_sequence"]], lat, lng]);
      }) },
    });
  }
  const shapePoly = new Map();
  for (const [sid, arr] of shapeRaw) { arr.sort((a, b) => a[0] - b[0]); shapePoly.set(sid, arr.map((r) => [+r[1].toFixed(5), +r[2].toFixed(5)])); }

  // ---- בניית הקווים (אותו מבנה כמו פלט ה-worker) ----
  const lines = [];
  for (const [rid, entry] of bestPerRoute) {
    const info = routes.get(rid); if (!info) continue;
    const pts = [];
    for (const id of entry.ids) { const s = stops.get(id); if (s) pts.push({ id, name: s.name, lat: +s.lat.toFixed(5), lng: +s.lng.toFixed(5) }); }
    if (pts.length < 2) continue;
    const sid = tripShape.get(entry.trip);
    lines.push({
      number: info.number, operator: agencies.get(info.agencyId) || "", color: DEFAULT_COLOR,
      name: info.name || ("קו " + info.number), stops: pts, shape: sid ? (shapePoly.get(sid) || null) : null,
      _rid: rid, _tripsDay: tripsBusiest.get(rid) || 0,
    });
  }
  console.error("  קווים שנבנו:", lines.length, "| זמן עד כה:", secs(tnow() - t0));

  // ---- ניתוח (אותו מנוע כמו האתר) ----
  console.error("מנתח (זיהוי עיקופים + לולאות)…");
  D.addCity("כל הארץ", { key: "כל הארץ", center: { lat: 31.5, lng: 35 }, zoom: 8, lines });
  const analyzed = D.analyzeCity("כל הארץ", { minExcess: MIN_EXCESS });
  console.error("  הניתוח הסתיים. זמן עד כה:", secs(tnow() - t0));

  // ---- איסוף תוצאות + הכרעה דטרמיניסטית ----
  const issues = [];
  const byVerdict = {};
  for (const L of analyzed.lines) {
    if (!L.issues || !L.issues.length) continue;
    for (const it of L.issues) {
      const d = it.diag || {};
      const vr = d.kind ? verdictOf(d) : { verdict: "(אין-אבחון)", reason: "" };
      // גאומטריה לציור על המפה: seg = מקטע הקו הנבדק (הכתום/העיקוף), ref = מסלול
      // קו-ההשוואה (הירוק). מעוגל ל-5 ספרות. round5 משאיר את הקובץ קומפקטי.
      const round5 = (g) => g && g.map((p) => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)]);
      const round4 = (g) => g && g.map((p) => [+(+p[0]).toFixed(4), +(+p[1]).toFixed(4)]); // ~11 מ' — מספיק לרקע
      // דילול-נקודות: משמיט נקודות קרובות (m2 = מרחק² בק"מ²-בקירוב) לחיסכון נפח
      // בלי לפגוע בצורת הכביש. שומר תמיד ראשונה ואחרונה.
      const thin = (g, m2) => {
        if (!g || g.length < 3) return g;
        const out = [g[0]]; let last = g[0];
        for (let k = 1; k < g.length - 1; k++) {
          const dy = (g[k][0] - last[0]) * 111, dx = (g[k][1] - last[1]) * 89;
          if (dy * dy + dx * dx >= m2) { out.push(g[k]); last = g[k]; }
        }
        out.push(g[g.length - 1]); return out;
      };
      // חיתוך *צפוף* של ה-shape הגולמי בין שתי תחנות (לפי נקודות-ההצמדה) — עוקב
      // אחר הכביש בפועל בלי קפיצות. (diag.lineGeometry מדולל ל-40 נק' עבור ה-AI
      // וגורם ל"ריחוף"; כאן בונים מהמקור הצפוף.) מטפל גם בלולאה (along עולה).
      const sliceDense = (LL, a, b) => {
        if (!LL.shape || LL.shape.length < 2 || !LL._snap) return null;
        let A = LL._snap[a], B = LL._snap[b];
        if (!A || !B) return null;
        if (B.along < A.along) { const t = A; A = B; B = t; }
        const out = [A.proj];
        for (let k = A.seg + 1; k <= B.seg; k++) {
          const pt = [LL.shape[k][0], LL.shape[k][1]];
          const lp = out[out.length - 1];
          if (!lp || lp[0] !== pt[0] || lp[1] !== pt[1]) out.push(pt);
        }
        const lp = out[out.length - 1];
        if (!lp || lp[0] !== B.proj[0] || lp[1] !== B.proj[1]) out.push(B.proj);
        return out.length > 1 ? out : null;
      };
      const segIdx = it.segIdx && it.segIdx[0];
      let seg = (segIdx != null) ? sliceDense(L, segIdx, segIdx + 1) : null;
      if (!(seg && seg.length > 1)) seg = (d.lineGeometry && d.lineGeometry.length > 1) ? d.lineGeometry : ((L._geom && segIdx != null && L._geom[segIdx]) || null);
      seg = thin(seg, 0.00003);             // ~5 מ' — צפוף, עוקב אחר הכביש
      // קו-הרקע (כחול): *חלון צפוף* סביב העיקוף (3 תחנות לפני/אחרי) במקום כל הקו
      // הארוך — כך הוא צפוף ועוקב אחר הכביש (לא "מרחף") ונשאר קטן. נותן הקשר: רואים
      // את הקו נכנס ויוצא מאזור העיקוף.
      let lineShape = null;
      if (segIdx != null && L.stops) {
        const a = Math.max(0, segIdx - 3), b = Math.min(L.stops.length - 1, segIdx + 4);
        lineShape = thin(sliceDense(L, a, b), 0.00003);
      }
      if (!(lineShape && lineShape.length > 1)) lineShape = thin(L.shape, 0.0013);
      // "כיסוי שכונה": מסווגים עיקוף מחדש כ"כיסוי לגיטימי" *רק* אם קיים וריאנט של
      // אותו קו שעוצר בתחנת-ביניים *ברצף-הנסיעה* בין שתי תחנות-הקצה של המקטע,
      // והתחנה יושבת על מסלול-העיקוף. כך מבדילים בין שירות-שכונה אמיתי (קו 31: 4
      // תחנות ב-שדרות האורנים בין "אכזיב/מולר" ל-"צומת גשר הזיו") לבין קו שסתם עובר
      // *ליד* תחנות ששירת קודם (חפיפת-מסלול) — שזה לא כיסוי של המקטע.
      let vr2 = vr;
      if (vr.verdict === "אמיתי" && seg && seg.length > 1) {
        const e0 = seg[0], e1 = seg[seg.length - 1];
        let covered = false;
        for (const seq of (lineVariants.get(L.number) || [])) {
          // אינדקס התחנה הקרובה ביותר לכל קצה (עד 60 מ') — מזהים את המקטע ברצף
          let i0 = -1, d0 = 60, i1 = -1, d1 = 60;
          for (let k = 0; k < seq.length; k++) {
            const a = havM(seq[k], e0); if (a < d0) { d0 = a; i0 = k; }
            const b = havM(seq[k], e1); if (b < d1) { d1 = b; i1 = k; }
          }
          if (i0 < 0 || i1 < 0) continue;
          const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
          for (let k = lo + 1; k < hi; k++) {
            const s = seq[k];
            // תחנת-ביניים אמיתית: רחוקה משתי הקצוות *ויושבת על* מסלול-העיקוף
            if (havM(s, e0) > 45 && havM(s, e1) > 45 && distToPath(s, seg) < 40) { covered = true; break; }
          }
          if (covered) break;
        }
        if (covered) vr2 = { verdict: "כיסוי לגיטימי", reason: "וריאנט של הקו עוצר בתחנות-ביניים בתוך המקטע (כיסוי שכונה) — לא עיקוף מיותר, אלא בחירת מסלול שמשרתת נוסעים." };
      }
      byVerdict[vr2.verdict] = (byVerdict[vr2.verdict] || 0) + 1;
      const excessKm = +(it.km || d.excessKm || 0).toFixed(3);
      const tripsDay = L._tripsDay || 0;
      issues.push({
        line: L.number, operator: L.operator, type: it.type,
        from: it.from && it.from.name, to: it.to && it.to.name,
        lat: it.from && it.from.lat, lng: it.from && it.from.lng,
        ref: it.refNumber, excessKm,
        tripsDay, wasteDayKm: +(excessKm * tripsDay).toFixed(1),
        ratio: d.ratio != null ? +d.ratio.toFixed(2) : null,
        verdict: vr2.verdict, reason: vr2.reason || "",
        seg: round5(seg), refGeom: round5(it.refGeom), lineShape: round5(lineShape),
      });
    }
  }
  issues.sort((a, b) => b.excessKm - a.excessKm);

  // ---- העשרת OSRM: על *כל* המקטעים עם גאומטריה (לא רק "ספק") ----
  // הרצה קודמת על כל 280 המקטעים בקצב מהיר (300ms) הפעילה הגבלת-קצב זמנית
  // בשרת-ההדגמה הציבורי ונכשלה לגמרי (0/280). עכשיו רצים על כולם, אבל בקצב
  // *איטי ומכובד בהרבה* (2 שנ' בין בקשות) כדי לא לחזור על אותה תקלה — ריצה
  // מלאה לוקחת ~10-15 דקות, לא קורסת, פשוט לוקחת זמן.
  //
  // חשוב: לשאר-הכרעות (לא "ספק") *לא* משנים את הפסק על סמך OSRM בלבד — רק
  // מוסיפים אנוטציה (optKm/optRatio/optRoute) למידע/לציור. הסיבה: OSRM הוא
  // ניווט-רכב-פרטי, ואוטובוס עשוי לנסוע ארוך יותר *לגיטימית* (נתיבי-תח"צ,
  // איסורי-פנייה, מסופים) — זה חסם-תחתון/אינדיקציה, לא פסק-דין. במקום זאת
  // מסמנים osrmFlag על "אמיתי" שה-OSRM חושב שהוא כבר קרוב-לאופטימלי (ratio
  // נמוך), כדי שאפשר יהיה לראות את אלה בנפרד ולבדוק אנושית — בלי לדרוס הכרעה
  // שכבר אומתה ידנית על קווים רבים בעבר. ל"ספק" (מעטים, לרוב 0-2) ממשיכים
  // לפתור אוטומטית כמו קודם — שם אין הכרעה קיימת לדרוס.
  console.error("מעשיר עם ניווט אובייקטיבי (OSRM) — כל המקטעים…");
  const osrmIssues = issues.filter((it) => it.seg && it.seg.length > 1);
  console.error("  מקטעים שיועשרו:", osrmIssues.length, "(מתוך", issues.length, ")");
  const r5 = (g) => g && g.map((p) => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)]);
  const thinP = (g, m2) => {
    if (!g || g.length < 3) return g;
    const out = [g[0]]; let last = g[0];
    for (let k = 1; k < g.length - 1; k++) { const dy = (g[k][0] - last[0]) * 111, dx = (g[k][1] - last[1]) * 89; if (dy * dy + dx * dx >= m2) { out.push(g[k]); last = g[k]; } }
    out.push(g[g.length - 1]); return out;
  };
  const segKm = (g) => { let s = 0; for (let k = 1; k < g.length; k++) s += havM(g[k - 1], g[k]) / 1000; return s; };
  let osrmOk = 0;
  for (let idx = 0; idx < osrmIssues.length; idx++) {
    const it = osrmIssues[idx];
    const seg = it.seg;
    const o = await osrmRoute(seg[0], seg[seg.length - 1]);
    await sleep(2000); // קצב מכובד ובטוח לשרת-ההדגמה הציבורי — כל המקטעים, לא רק "ספק"
    if ((idx + 1) % 20 === 0 || idx === osrmIssues.length - 1) console.error("  OSRM התקדמות:", idx + 1, "/", osrmIssues.length, "| הצליחו:", osrmOk);
    if (!o || !(o.km > 0)) continue;
    osrmOk++;
    it.optKm = +o.km.toFixed(3);
    it.optRatio = +(segKm(seg) / o.km).toFixed(2);
    it.optRoute = r5(thinP(o.route, 0.00003));
    if (it.verdict === "ספק") {
      // פתרון "ספק" לפי היחס לאופטימום האובייקטיבי — אין הכרעה קיימת לדרוס
      if (it.optRatio >= 1.5) { it.verdict = "אמיתי"; it.reason = `הקו נוסע פי ${it.optRatio} מהדרך הקצרה בכביש (ניווט OSRM: ${Math.round(o.km * 1000)} מ') — עיקוף אמיתי לפי אמת אובייקטיבית.`; }
      else if (it.optRatio <= 1.2) { it.verdict = "לא ניתן להשוואה"; it.reason = `הקו נוסע במסלול קרוב-לאופטימלי (פי ${it.optRatio} מהדרך הקצרה בכביש) — אין עיקוף מיותר בפועל.`; }
      // 1.2–1.5: גבולי — נשאר "ספק"
    } else if (it.verdict === "אמיתי" && it.optRatio >= 1.0 && it.optRatio <= 1.2) {
      // דגל (לא שינוי-הכרעה): OSRM חושב שהמסלול כבר קרוב-לאופטימלי, למרות
      // שההכרעה הראשית קבעה "אמיתי". *חייב* optRatio>=1.0 — אם ratio<1 המסלול
      // המסומן קצר מהאופטימום-לרכב, וזה *לא* עדות-נגד: זה קורה כשלאוטובוס יש
      // גישה לרחוב שרכב פרטי לא יכול (נתיב-תח"צ/רחוב-סגור-לרכב/מדרחוב) — נבדק
      // בפועל בקו 28 (יחס 0.36): המקטע המסומן אורכו 432 מ' וקו-אווירי רק 244
      // מ', בעוד OSRM הלך 1197 מ' כי הרחוב הישיר כנראה סגור לרכב. במקרה כזה
      // ratio-נמוך *לא* סותר "אמיתי" ואסור לסמן worth-review. רק ratio בטווח
      // 1.0–1.2 (המסלול לא קצר מרכב, ולכן אין "אליבי" של תשתית-תח"צ) הוא באמת
      // ראוי-לבדיקה-אנושית.
      it.osrmFlag = "worth-review";
    }
  }
  console.error("  OSRM ענה עבור", osrmOk, "מתוך", osrmIssues.length, "מקטעים.");

  // ---- "רק לפי רכב": מקטעים בלי קו-ייחוס תקף (data.js אספה ל-L._carCands) ----
  // אלה מקטעים *בלתי-נראים לגמרי* לגלאי הרגיל (אין אף קו אחר שמוכיח דרך קצרה
  // יותר), אבל המרחק המצויר גדול הרבה יותר מהקו-האווירי בין שתי התחנות. נבדקים
  // בנפרד מול ניווט-רכב אובייקטיבי — ומאושרים כ"חשד" *רק* אם גם ה-OSRM (שאינו
  // יודע כלום על נתיבי-תח"צ) רואה פער גדול. זו קטגוריה נפרדת מ"אמיתי" — אין כאן
  // הוכחת-קו, רק פער-גיאומטרי + אישור-רכב-אחד, ולכן פחות ודאית מהעיקוף הרגיל.
  console.error("\nאוסף מועמדי 'רק לפי רכב' (בלי קו-ייחוס תקף)…");
  const round5v = (g) => g && g.map((p) => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)]);
  const thinv = (g, m2) => {
    if (!g || g.length < 3) return g;
    const out = [g[0]]; let last = g[0];
    for (let k = 1; k < g.length - 1; k++) { const dy = (g[k][0] - last[0]) * 111, dx = (g[k][1] - last[1]) * 89; if (dy * dy + dx * dx >= m2) { out.push(g[k]); last = g[k]; } }
    out.push(g[g.length - 1]); return out;
  };
  const sliceDenseV = (LL, a, b) => {
    if (!LL.shape || LL.shape.length < 2 || !LL._snap) return null;
    let A = LL._snap[a], B = LL._snap[b];
    if (!A || !B) return null;
    if (B.along < A.along) { const t = A; A = B; B = t; }
    const out = [A.proj];
    for (let k = A.seg + 1; k <= B.seg; k++) {
      const pt = [LL.shape[k][0], LL.shape[k][1]];
      const lp = out[out.length - 1];
      if (!lp || lp[0] !== pt[0] || lp[1] !== pt[1]) out.push(pt);
    }
    const lp = out[out.length - 1];
    if (!lp || lp[0] !== B.proj[0] || lp[1] !== B.proj[1]) out.push(B.proj);
    return out.length > 1 ? out : null;
  };
  const carRaw = [];
  for (const L of analyzed.lines) {
    if (!L._carCands || !L._carCands.length) continue;
    for (const c of L._carCands) {
      const X = L.stops[c.i], Y = L.stops[c.i + 1];
      let seg = thinv(sliceDenseV(L, c.i, c.i + 1), 0.00003);
      if (!(seg && seg.length > 1)) continue;
      // קו-הרקע (כחול): *חלון צפוף* סביב המקטע (3 תחנות לפני/אחרי) — בדיוק כמו
      // במקטעים הרגילים — כדי שהקו הכחול (הקשר-המסלול) יופיע גם כאן. בלעדיו
      // המפה מציגה רק כתום+סגול, בלי שום הקשר לאיפה הקו נוסע בפועל.
      let lineShape = null;
      if (L.stops) {
        const a = Math.max(0, c.i - 3), b = Math.min(L.stops.length - 1, c.i + 4);
        lineShape = thinv(sliceDenseV(L, a, b), 0.00003);
      }
      if (!(lineShape && lineShape.length > 1)) lineShape = thinv(L.shape, 0.0013);
      carRaw.push({
        line: L.number, operator: L.operator, from: X.name, to: Y.name,
        lat: X.lat, lng: X.lng, roadA: c.roadA, tripsDay: L._tripsDay || 0,
        seg: round5v(seg), lineShape: round5v(lineShape),
      });
    }
  }
  console.error("  מועמדים גולמיים:", carRaw.length);
  // דה-דופליקציה: מפתח לפי קואורדינטות-קצה מעוגלות (~11מ') — כמה קווים
  // שחולקים פיזית את אותו מקטע (בלי לדעת זה על זה) נבדקים מול OSRM פעם אחת.
  const roundKey = (n) => Math.round(n * 9000) / 9000;
  const groups = new Map();
  for (const c of carRaw) {
    const seg = c.seg, a = seg[0], b = seg[seg.length - 1];
    const key = [roundKey(a[0]), roundKey(a[1]), roundKey(b[0]), roundKey(b[1])].join(",");
    let g = groups.get(key);
    if (!g) { g = { members: [], seg: c.seg }; groups.set(key, g); }
    g.members.push(c);
  }
  const groupArr = [...groups.values()];
  console.error("  אחרי דה-דופליקציה (מקטעים פיזיים ייחודיים):", groupArr.length);
  console.error("  בודק מול ניווט-רכב אובייקטיבי (OSRM)…");
  let carOk = 0, carConfirmed = 0;
  for (let idx = 0; idx < groupArr.length; idx++) {
    const g = groupArr[idx];
    const seg = g.seg;
    const o = await osrmRoute(seg[0], seg[seg.length - 1]);
    await sleep(2000); // אותו קצב מכובד/בטוח כמו העשרת-ה-OSRM הרגילה
    if ((idx + 1) % 50 === 0 || idx === groupArr.length - 1) console.error("    התקדמות:", idx + 1, "/", groupArr.length, "| הצליחו:", carOk, "| אושרו:", carConfirmed);
    if (!o || !(o.km > 0)) continue;
    carOk++;
    // שער דיוק-הגעה: אם ה-route של OSRM לא באמת מגיע לתחנה (למשל תחנת-מוצא/
    // מסוף עם גישה פרטית/מוגבלת ש-OSRM לא רואה, ומצמיד לכביש ציבורי קרוב אבל
    // לא זהה) — ההשוואה לא אמינה: ה"מרחק-הקצר-לרכב" לא באמת מגיע לאותה נקודה
    // שהקו נבדק בה. נבדק אמפירית: קו 301 לאשקלון ("מסוף קסטינה-מלאכי") — פער
    // 50מ' בקצה המוצא, בעוד רוב המקטעים התקינים ≤22מ'. סף 40מ' מפריד ביניהם.
    if (!o.route || !o.route.length) continue;
    const endGapKm = Math.max(havM(seg[0], o.route[0]), havM(seg[seg.length - 1], o.route[o.route.length - 1])) / 1000;
    if (endGapKm > 0.04) continue;
    // חשוב: קווים ששולחים לאותה קבוצה (אותן קואורדינטות-קצה מעוגלות) לא בהכרח
    // עוברים באותו מסלול *בין* הקצוות — לכן מחשבים יחס בנפרד לכל קו-חבר (לפי
    // ה-roadA *שלו*, מול אותו o.km משותף), ולא לפי חבר-אחד מייצג לכל הקבוצה.
    // אחרת קו עם roadA קצר-במיוחד "נגרר" לאישור בזכות קו אחר בקבוצה שכן חורג.
    const optRoute = round5v(thinv(o.route, 0.00003));
    let groupConfirmed = false;
    for (const m of g.members) {
      const optRatio = +(m.roadA / o.km).toFixed(2);
      if (optRatio < 1.5) continue; // לא מספיק שונה מהאופטימום-לרכב — לא מאשרים כחשד
      groupConfirmed = true;
      issues.push({
        line: m.line, operator: m.operator, type: "detour",
        from: m.from, to: m.to, ref: null,
        excessKm: +(m.roadA - o.km).toFixed(3),
        tripsDay: m.tripsDay, wasteDayKm: +((m.roadA - o.km) * m.tripsDay).toFixed(1),
        ratio: null, verdict: "חשד עיקוף (רק לפי רכב)",
        reason: `אין קו-אוטובוס אחר שמוכיח דרך קצרה יותר, אבל המקטע (${m.roadA.toFixed(2)} ק"מ) ארוך פי ${optRatio} מהדרך הקצרה בכביש לפי ניווט-רכב אובייקטיבי (${o.km.toFixed(2)} ק"מ) — כדאי לבדוק ידנית אם זהו עיקוף מיותר, או הסבר לגיטימי (כניסה למתחם, או מסדרון-תח"צ ייעודי כמו נתיב-BRT/מטרונית שרכב פרטי לא יכול לנסוע בו, ולכן ה-OSRM לא ראה אותו).`,
        seg: m.seg, refGeom: null, lineShape: m.lineShape,
        lat: m.lat, lng: m.lng,
        optKm: +o.km.toFixed(3), optRatio, optRoute,
      });
    }
    if (groupConfirmed) carConfirmed++;
  }
  console.error("  OSRM ענה עבור", carOk, "מתוך", groupArr.length, "מקטעים ייחודיים | אושרו כ'חשד':", carConfirmed,
    "(", issues.filter((i) => i.verdict === "חשד עיקוף (רק לפי רכב)").length, "רשומות-קו בסך-הכול)");

  // בונים מחדש את הפילוח + הבזבוז אחרי הסיווג-מחדש
  for (const k of Object.keys(byVerdict)) delete byVerdict[k];
  for (const it of issues) byVerdict[it.verdict] = (byVerdict[it.verdict] || 0) + 1;

  // ---- כתיבה ----
  const real = issues.filter((i) => i.verdict === "אמיתי");
  const totalWasteDayKm = +real.reduce((s, i) => s + (i.wasteDayKm || 0), 0).toFixed(0);
  const report = {
    generatedAt: new Date().toISOString(),
    sourceZip: path.basename(zipPath),
    totalLines: analyzed.lines.length,
    totalIssues: issues.length,
    realCount: real.length,
    totalWasteDayKm, // סה"כ ק"מ מבוזבזים ביום עמוס (עיקופים אמיתיים × נסיעות/יום)
    byVerdict,
    issues,
  };
  fs.writeFileSync(outPrefix + ".json", JSON.stringify(report, null, 2));

  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const header = ["verdict", "line", "operator", "type", "from", "to", "ref", "excessKm", "tripsDay", "wasteDayKm", "ratio", "lat", "lng", "reason"];
  const csv = [header.join(",")].concat(
    issues.map((i) => [i.verdict, i.line, i.operator, i.type, i.from, i.to, i.ref, i.excessKm, i.tripsDay, i.wasteDayKm, i.ratio, i.lat, i.lng, i.reason].map(esc).join(","))
  ).join("\n");
  fs.writeFileSync(outPrefix + ".csv", "﻿" + csv); // BOM כדי שעברית תיפתח נכון באקסל

  // ---- סיכום ----
  console.error("\n========== סיכום ==========");
  console.error("קווים שנסרקו:", analyzed.lines.length);
  console.error('סה"כ מקטעים מסומנים:', issues.length);
  console.error("פילוח לפי הכרעה:");
  for (const [k, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) console.error("   " + k + ": " + n);
  console.error("עיקופים *אמיתיים*:", real.length);
  console.error('ק"מ מבוזבזים ביום עמוס (אמיתיים):', totalWasteDayKm.toLocaleString("en-US"));
  console.error("זמן כולל:", secs(tnow() - t0));
  console.error("נכתב: " + outPrefix + ".json , " + outPrefix + ".csv");
})();
