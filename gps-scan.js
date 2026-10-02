#!/usr/bin/env node
/* ===========================================================================
   קו באג — בדיקה לפי GPS בפועל (Node.js, בלי תלויות מלבד fflate)
   ---------------------------------------------------------------------------
   מחפש קטעים במסלול המתוכנן (shape ב-GTFS) שהאוטובוסים כמעט אף פעם לא
   נוסעים בהם בפועל, לפי נקודות ה-GPS (SIRI) שהסדנא לידע ציבורי שומרת
   ב-Open Bus Stride. כלל כללי, לילי ואוטומטי — אין תיקונים ידניים לקו מסוים.

   לכל מקטע בין שתי תחנות עוקבות: איזה חלק מהנסיעות עבר בו (במרחק ≤40 מ').
   מקטע שפחות מ-20% מהנסיעות עוברות בו (לפחות 15 נסיעות על פני 14 יום לפחות),
   והנסיעות עוקפות אותו בדרך קצרה יותר — מועמד. ואז ההכרעה:
     "חשד לקידוד מיותר"   — לא נסעו בו אף פעם בחלון הנצפה, 4 שבועות ויותר;
     "סיבה לא ידועה" אם חלון ההימנעות קצר; עבודות הן חשד רק כשיש ראיה נוספת:
        1. ההימנעות נמשכת פחות מ-4 שבועות;
        2. כמה קווים שונים הפסיקו לעבור באותו מקום באותם ימים;
        3. עד תאריך מסוים נסעו בו ואז הפסיקו (מדווח התאריך);
        4. בהיסטוריית הקו (הקו הבוחן) יש שינוי זמני שהתבטל סביב אותו זמן.

   הנתונים נאספים בהדרגה: כל לילה נמשכות נסיעות מדגמיות (כמה ביום) לקבוצה
   מתחלפת של קווים, והתוצאה נשמרת במטמון דחוס (לכל נסיעה רק "באילו מקטעים
   עברה" + מסלול בפועל לקטעים שדילגה עליהם). כך המטמון קטן וניתן ל-commit.

   שימוש:
     node gps-scan.js <gtfs.zip | תיקיית-txt> <cache-dir> <out.json> [--history <line-history/data/lines>]
   משתני סביבה:
     STRIDE_URL           (ברירת מחדל https://open-bus-stride-api.hasadna.org.il)
     GPS_FIXTURE=<dir>    במקום Stride: <dir>/<route_id>.json = [{id,date,points:[[lat,lon],…]}]
     GPS_OFFLINE=1        בלי משיכה בכלל — ניתוח המטמון בלבד
     GPS_LINES_PER_NIGHT  (60) קווים חדשים לדגימה בכל לילה
     GPS_DAYS             (35) כמה ימים אחורה לדגום
     GPS_RIDES_PER_DAY    (2)  נסיעות לכל יום
     GPS_BUDGET_MIN       (25) תקציב זמן למשיכה
     GPS_TODAY            (YYYY-MM-DD) לבדיקות
   =========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const histIdx = args.indexOf("--history");
const historyDir = histIdx >= 0 ? args[histIdx + 1] : null;
if (histIdx >= 0) args.splice(histIdx, 2);
const [gtfsPath, cacheDir, outPath] = args;
if (!gtfsPath || !cacheDir || !outPath) {
  console.error("שימוש: node gps-scan.js <gtfs.zip|dir> <cache-dir> <out.json> [--history <dir>]");
  process.exit(1);
}
const env = process.env;
const STRIDE = (env.STRIDE_URL || "https://open-bus-stride-api.hasadna.org.il").replace(/\/$/, "");
const FIXTURE = env.GPS_FIXTURE || "";
const OFFLINE = env.GPS_OFFLINE === "1";
const LINES_PER_NIGHT = +(env.GPS_LINES_PER_NIGHT || 60);
const DAYS = +(env.GPS_DAYS || 35);
const RIDES_PER_DAY = +(env.GPS_RIDES_PER_DAY || 2);
const BUDGET_MS = +(env.GPS_BUDGET_MIN || 25) * 60000;
const TODAY = env.GPS_TODAY || new Date().toISOString().slice(0, 10);

// ---- ספים (כלליים לכל הארץ) ----
const MAX_GAP_MS = 120000; // פער גדול משתי דקות אינו ראיה למסלול
const MAX_SPEED_MPS = 45; // קפיצות מיקום אינן מחברות מסלול
const NEAR_M = 40;          // "עבר במקטע" = במרחק עד 40 מ'
const LOW_SHARE = 0.2;      // פחות מ-20% מהנסיעות → מועמד
const MIN_RIDES = 15;       // לפחות 15 נסיעות
const MIN_SPAN_DAYS = 14;   // על פני שבועיים לפחות
const PERSIST_DAYS = 28;    // חשד לקידוד רק אחרי 4 שבועות רצופים
const SAME_TIME_DAYS = 4;   // "באותם ימים" בין קווים שונים
const TEMP_WINDOW = 21;     // שינוי זמני בהיסטוריה בטווח ±3 שבועות
const KEEP_DAYS = 120;      // מטמון: שומרים עד 4 חודשים אחורה

// ---------------------------------------------------------------- גאומטריה
const R = 6371000, T = (x) => x * Math.PI / 180;
function hav(a, b) { const dLat = T(b[0] - a[0]), dLng = T(b[1] - a[1]); return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(T(a[0])) * Math.cos(T(b[0])) * Math.sin(dLng / 2) ** 2)); }
function xy(p, lat0) { return [T(p[1]) * R * Math.cos(T(lat0)), T(p[0]) * R]; }
function distPtSeg(p, a, b, lat0) {
  const P = xy(p, lat0), A = xy(a, lat0), B = xy(b, lat0);
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy);
}
function distToPoly(p, poly) {
  if (poly.length === 1) return hav(p, poly[0]);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) { const d = distPtSeg(p, poly[i - 1], poly[i], p[0]); if (d < best) best = d; }
  return best;
}
function polyLen(poly) { let s = 0; for (let i = 1; i < poly.length; i++) s += hav(poly[i - 1], poly[i]); return s; }
// דגימה כל ~step מ' לאורך קו
function resample(poly, step) {
  const out = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], d = hav(a, b), n = Math.floor(d / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k * step / d, a[1] + (b[1] - a[1]) * k * step / d]);
    out.push(b);
  }
  return out;
}
const r5 = (p) => [+p[0].toFixed(5), +p[1].toFixed(5)];

// polyline מקודד (Google) — דחיסה למטמון
function encPoly(pts) {
  let out = "", pl = 0, pg = 0;
  const e = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ""; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const p of pts) { const la = Math.round(p[0] * 1e5), lg = Math.round(p[1] * 1e5); out += e(la - pl) + e(lg - pg); pl = la; pg = lg; }
  return out;
}
function decPoly(s) {
  const out = []; let i = 0, la = 0, lg = 0;
  const d = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { la += d(); lg += d(); out.push([la / 1e5, lg / 1e5]); }
  return out;
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- GTFS
function parseCSV(line) {
  if (line.indexOf('"') < 0) return line.split(",");
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}
function rowHandler(rowFn) {
  let idx = null;
  return (line) => {
    const f = parseCSV(line);
    if (idx === null) { idx = {}; f.forEach((n, i) => (idx[n.trim().replace(/^﻿/, "")] = i)); return; }
    rowFn(f, idx);
  };
}
function lineSplitter(onLine) {
  let buf = ""; const dec = new TextDecoder("utf-8");
  return (chunk, final) => {
    buf += dec.decode(chunk, { stream: !final });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { let l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.endsWith("\r")) l = l.slice(0, -1); if (l) onLine(l); }
    if (final && buf) { onLine(buf); buf = ""; }
  };
}
let zipU8 = null;
function readTables(handlers) {
  if (fs.statSync(gtfsPath).isDirectory()) {
    for (const [name, spec] of Object.entries(handlers)) {
      const p = path.join(gtfsPath, name);
      if (!fs.existsSync(p)) continue;
      const sp = lineSplitter(spec.onLine); sp(fs.readFileSync(p), true); if (spec.onEnd) spec.onEnd();
    }
    return;
  }
  let fflate;
  for (const p of ["fflate", path.join(__dirname, "node_modules", "fflate"), "/tmp/node_modules/fflate"]) { try { fflate = require(p); break; } catch (_e) { /* next */ } }
  if (!fflate) { console.error("חסר fflate (npm install fflate)"); process.exit(1); }
  if (!zipU8) zipU8 = new Uint8Array(fs.readFileSync(gtfsPath));
  const unzip = new fflate.Unzip(); unzip.register(fflate.UnzipInflate);
  unzip.onfile = (file) => {
    const key = Object.keys(handlers).find((k) => file.name.endsWith(k)); if (!key) return;
    const spec = handlers[key], sp = lineSplitter(spec.onLine);
    file.ondata = (err, chunk, final) => { if (err) throw err; if (chunk && chunk.length) sp(chunk, false); if (final) { sp(new Uint8Array(0), true); if (spec.onEnd) spec.onEnd(); } };
    file.start();
  };
  const CH = 1 << 22;
  for (let o = 0; o < zipU8.length; o += CH) { const e = Math.min(o + CH, zipU8.length); unzip.push(zipU8.subarray(o, e), e >= zipU8.length); }
}

function loadLines() {
  const stops = new Map(), agencies = new Map(), routes = new Map();
  readTables({
    "stops.txt": { onLine: rowHandler((f, ix) => {
      const lat = +f[ix.stop_lat], lng = +f[ix.stop_lon]; if (!isFinite(lat) || !isFinite(lng)) return;
      const desc = ix.stop_desc != null ? (f[ix.stop_desc] || "") : ""; const cm = desc.match(/עיר:\s*([^:]*?)\s*רציף/);
      stops.set(f[ix.stop_id], { name: (f[ix.stop_name] || "").trim(), lat, lng, city: cm ? cm[1].trim() : "" });
    }) },
    "agency.txt": { onLine: rowHandler((f, ix) => agencies.set(f[ix.agency_id], (f[ix.agency_name] || "").trim())) },
    "routes.txt": { onLine: rowHandler((f, ix) => {
      const type = ix.route_type != null ? +f[ix.route_type] : 3;
      if (type !== 3) return; // אוטובוסים בלבד
      routes.set(f[ix.route_id], { number: (f[ix.route_short_name] || "").trim(), name: (f[ix.route_long_name] || "").trim(), desc: (f[ix.route_desc] || "").trim(), agencyId: f[ix.agency_id] });
    }) },
  });
  // trips: נסיעה מייצגת אחת לכל route (עם shape)
  const repTrip = new Map(), tripShape = new Map(), tripsPerRoute = new Map(), routeShapes = new Map();
  readTables({ "trips.txt": { onLine: rowHandler((f, ix) => {
    const rid = f[ix.route_id]; if (!routes.has(rid)) return;
    tripsPerRoute.set(rid, (tripsPerRoute.get(rid) || 0) + 1);
    const sid = ix.shape_id != null ? (f[ix.shape_id] || "").trim() : "";
    if (!sid) return;
    if (!routeShapes.has(rid)) routeShapes.set(rid, new Set());
    routeShapes.get(rid).add(sid);
    const t = f[ix.trip_id];
    if (!repTrip.has(rid)) repTrip.set(rid, []);
    const arr = repTrip.get(rid); if (arr.length < 3) { arr.push(t); tripShape.set(t, sid); }
  }) } });
  const wanted = new Map(); // trip -> rid
  for (const [rid, ts] of repTrip) for (const t of ts) wanted.set(t, rid);
  const tripStops = new Map();
  readTables({ "stop_times.txt": { onLine: rowHandler((f, ix) => {
    const t = f[ix.trip_id]; if (!wanted.has(t)) return;
    let a = tripStops.get(t); if (!a) { a = []; tripStops.set(t, a); }
    a.push([+f[ix.stop_sequence], f[ix.stop_id]]);
  }) } });
  const best = new Map(); // rid -> trip עם הכי הרבה תחנות
  for (const [t, a] of tripStops) { const rid = wanted.get(t), cur = best.get(rid); if (!cur || tripStops.get(cur).length < a.length) best.set(rid, t); }
  const needShapes = new Set(); for (const t of best.values()) needShapes.add(tripShape.get(t));
  const shapeRaw = new Map();
  readTables({ "shapes.txt": { onLine: rowHandler((f, ix) => {
    const sid = f[ix.shape_id]; if (!needShapes.has(sid)) return;
    let a = shapeRaw.get(sid); if (!a) { a = []; shapeRaw.set(sid, a); }
    a.push([+f[ix.shape_pt_sequence], +f[ix.shape_pt_lat], +f[ix.shape_pt_lon]]);
  }) } });
  const lines = [];
  for (const [rid, t] of best) {
    const info = routes.get(rid), raw = shapeRaw.get(tripShape.get(t)); if (!raw || raw.length < 2) continue;
    raw.sort((a, b) => a[0] - b[0]);
    const st = tripStops.get(t).sort((a, b) => a[0] - b[0]).map((r) => ({ id: r[1], ...stops.get(r[1]) })).filter((s) => s.lat != null);
    if (st.length < 3) continue;
    lines.push({ rid, number: info.number, operator: agencies.get(info.agencyId) || "", name: info.name, rd: info.desc,
      ambiguousShape: routeShapes.get(rid).size > 1, stops: st, shape: raw.map((r) => r5([r[1], r[2]])), tripsDay: tripsPerRoute.get(rid) || 0 });
  }
  return lines;
}

// חלוקת ה-shape למקטעים בין תחנות עוקבות (התאמה מונוטונית לאורך ה-shape)
function sections(line) {
  const sh = line.shape, idx = []; let from = 0;
  for (const s of line.stops) {
    let bi = from, bd = Infinity;
    for (let i = from; i < sh.length; i++) { const d = hav([s.lat, s.lng], sh[i]); if (d < bd) { bd = d; bi = i; } if (d > bd + 3000 && bd < 200) break; }
    idx.push(bi); from = bi;
  }
  const secs = [];
  for (let k = 1; k < idx.length; k++) {
    const poly = sh.slice(idx[k - 1], idx[k] + 1);
    secs.push(poly.length >= 2 ? poly : [[line.stops[k - 1].lat, line.stops[k - 1].lng], [line.stops[k].lat, line.stops[k].lng]]);
  }
  return secs;
}

// ---------------------------------------------------------------- נסיעה → מקטעים
// מקטע נספר רק אם יש תצפיות בשני קצותיו ורצף זמנים תקין ביניהן.
// "?" פירושו שאין מספיק מידע; הוא אינו נכלל במכנה של אחוז המעבר.
// כל נקודה שומרת זמן. אין חיבור על פני אובדן קליטה או קפיצת מיקום.
function validLink(a, b) {
  const dt = b[2] - a[2];
  return Number.isFinite(dt) && dt > 0 && dt <= MAX_GAP_MS && hav(a, b) / (dt / 1000) <= MAX_SPEED_MPS;
}
function sectionWindow(sec, pts) {
  const a = sec[0], b = sec[sec.length - 1];
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    if (hav(pts[i], a) > 100) continue;
    for (let j = i + 1; j < pts.length; j++) {
      if (!validLink(pts[j - 1], pts[j])) break;
      if (hav(pts[j], b) <= 100) {
        const score = hav(pts[i], a) + hav(pts[j], b);
        if (!best || score < best.score) best = { i, j, score };
        break;
      }
    }
  }
  return best;
}
function evalRide(secs, pts) {
  return secs.map((sec) => {
    const win = sectionWindow(sec, pts);
    if (!win) return "?"; // לא נצפה כל המקטע: לא נחשב דילוג
    const observed = pts.slice(win.i, win.j + 1);
    const samp = resample(sec, 25);
    const near = samp.filter((p) => distToPoly(p, observed) <= NEAR_M).length;
    return near / samp.length >= 0.8 ? 1 : 0;
  });
}
function altPath(secs, i, j, pts) {
  const sec = [].concat(...secs.slice(i, j + 1).map((p, k) => k ? p.slice(1) : p));
  const win = sectionWindow(sec, pts);
  if (!win) return null;
  return [sec[0]].concat(pts.slice(win.i, win.j + 1)).concat([sec[sec.length - 1]]).map(r5);
}

// ---------------------------------------------------------------- Stride
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * (a + 1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}
// מחזיר [{id,date,points}] לקו ביום אחד
async function fetchDay(line, date) {
  if (FIXTURE) {
    const p = path.join(FIXTURE, line.rid + ".json");
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8")).filter((r) => r.date === date).slice(0, RIDES_PER_DAY);
  }
  // חלונות נפרדים מונעים הגבלה ל-40 הנסיעות הראשונות בבוקר.
  const windows = [[0, 6], [6, 12], [12, 18], [18, 24]];
  const candidates = [];
  for (const [start, end] of windows) {
    // offset של ישראל בתאריך הנבדק, כולל שעון חורף.
    const noon = new Date(date + "T12:00:00Z");
    const hour = +new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "numeric", hourCycle: "h23" }).format(noon);
    const offset = hour - 12;
    const local = (h) => new Date(Date.parse(date + "T00:00:00Z") + (h - offset) * 3600000).toISOString();
    const q = new URLSearchParams({ siri_route__line_refs: line.rid, scheduled_start_time_from: local(start),
      scheduled_start_time_to: local(end), limit: "40", order_by: "scheduled_start_time asc" });
    const rides = await getJSON(STRIDE + "/siri_rides/list?" + q) || [];
    if (rides.length) candidates.push(rides[Math.floor(rides.length / 2)]);
    await sleep(250);
  }
  const unique = [...new Map(candidates.map((r) => [String(r.id), r])).values()];
  // מחליפים חלונות בין ימים, גם כשמכסת הדגימה היא שתי נסיעות בלבד.
  const rotation = Math.floor(Date.parse(date) / 86400000) % Math.max(1, unique.length);
  const pick = unique.slice(rotation).concat(unique.slice(0, rotation)).slice(0, RIDES_PER_DAY);
  const out = [];
  for (const rd of pick) {
    const q2 = new URLSearchParams({ siri_rides__ids: String(rd.id), limit: "1000", order_by: "recorded_at_time asc" });
    const locs = await getJSON(STRIDE + "/siri_vehicle_locations/list?" + q2) || [];
    await sleep(250);
    const points = locs.map((l) => [+l.lat, +l.lon, Date.parse(l.recorded_at_time)])
      .filter((p) => p.every(Number.isFinite) && p[0] >= 29 && p[0] <= 34 && p[1] >= 34 && p[1] <= 36.5)
      .sort((a, b) => a[2] - b[2]);
    out.push({ id: rd.id, date, points });
  }
  return out;
}

// ---------------------------------------------------------------- מטמון
const cacheFile = (rid) => path.join(cacheDir, String(rid).replace(/[^\w-]/g, "_") + ".json");
function loadCache(line, sig) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(line.rid), "utf8"));
    if (c.sig === sig) return c;
  } catch (_e) { /* חדש */ }
  return { rid: line.rid, rd: line.rd, sig, days: {}, rides: [], alt: {} };
}
function saveCache(c) {
  const lim = addDays(TODAY, -KEEP_DAYS);
  c.rides = c.rides.filter((r) => r.d >= lim);
  for (const d of Object.keys(c.days)) if (d < lim) delete c.days[d];
  fs.writeFileSync(cacheFile(c.rid), JSON.stringify(c));
}

// ---------------------------------------------------------------- היסטוריית הקו
function tempChanges(rd) {
  if (!historyDir || !rd) return [];
  const p = path.join(historyDir, rd.replace(/#/g, "H").replace(/\//g, "_") + ".json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return (j.versions || []).filter((v) => v.rv != null || v.rvb || /זמני|עבודות|הסטה/.test(v.note || "")).map((v) => v.d).filter(Boolean);
  } catch (_e) { return []; }
}

// ---------------------------------------------------------------- ניתוח
function analyzeLine(line, secs, cache) {
  const rides = cache.rides.slice().sort((a, b) => (a.d < b.d ? -1 : 1));
  if (rides.length < MIN_RIDES) return [];
  const span = dayDiff(rides[0].d, rides[rides.length - 1].d);
  if (span < MIN_SPAN_DAYS) return [];
  const n = secs.length;
  const recentFrom = addDays(rides[rides.length - 1].d, -MIN_SPAN_DAYS);
  const low = [];
  for (let s = 0; s < n; s++) {
    const rec = rides.filter((r) => r.d >= recentFrom && r.b[s] !== "?");
    const share = rec.length ? rec.filter((r) => r.b[s] === "1").length / rec.length : 1;
    low.push(rec.length >= MIN_RIDES && new Set(rec.map((r) => r.d)).size >= 7 && share < LOW_SHARE);
  }
  const out = [];
  for (let s = 0; s < n; s++) {
    if (!low[s]) continue;
    let e = s; while (e + 1 < n && low[e + 1]) e++;
    const segPoly = [].concat(...secs.slice(s, e + 1).map((p, k) => (k ? p.slice(1) : p)));
    const drove = (r) => { for (let k = s; k <= e; k++) if (r.b[k] === "1") return true; return false; };
    const eligible = rides.filter((r) => r.b.slice(s, e + 1).indexOf("?") < 0);
    if (eligible.length < MIN_RIDES || dayDiff(eligible[0].d, eligible[eligible.length - 1].d) < MIN_SPAN_DAYS) continue;
    const allShare = eligible.filter(drove).length / eligible.length;
    // מתי הפסיקו: אחרי הנסיעה האחרונה שעברה במקטע
    let lastDrove = null; for (const r of eligible) if (drove(r)) lastDrove = r.d;
    const firstMiss = eligible.find((r) => !drove(r) && (!lastDrove || r.d > lastDrove));
    const drovenBefore = lastDrove ? eligible.filter((r) => r.d <= lastDrove && drove(r)).length : 0;
    const since = firstMiss ? firstMiss.d : rides[0].d;
    const missSpan = dayDiff(since, rides[rides.length - 1].d);
    // המסלול בפועל: מסלול באורך החציוני מראיות חוזרות על פני שלושה ימים לפחות
    let gpsRoute = null;
    const evidence = cache.alt[s + ":" + e] || [];
    const recentEvidence = evidence.filter((x) => x.d >= recentFrom);
    if (new Set(recentEvidence.map((x) => x.d)).size < 3) continue;
    const paths = recentEvidence.map((x) => decPoly(x.p)).sort((a, b) => polyLen(a) - polyLen(b));
    gpsRoute = paths[Math.floor(paths.length / 2)];
    const segM = polyLen(segPoly), gpsM = gpsRoute ? polyLen(gpsRoute) : null;
    // "הנסיעות לוקחות דרך קצרה יותר" — אחרת זה לא קידוד מיותר (אולי GPS חסר)
    if (gpsM == null || gpsM > segM * 0.95) continue;
    out.push({ s, e, segPoly, gpsRoute, segM, gpsM, allShare, since, missSpan, drovenBefore, lastDrove,
      ridesChecked: eligible.length, evidenceDays: new Set(recentEvidence.map((x) => x.d)).size, firstDate: eligible[0].d, lastDate: eligible[eligible.length - 1].d });
    s = e;
  }
  return out;
}

(async function main() {
  const t0 = Date.now();
  fs.mkdirSync(cacheDir, { recursive: true });
  console.error("טוען GTFS…");
  const allLines = loadLines();
  const ambiguousLines = allLines.filter((l) => l.ambiguousShape).length;
  const lines = allLines.filter((l) => !l.ambiguousShape);
  console.error("  קווי אוטובוס עם shape:", lines.length);
  const byRid = new Map(lines.map((l) => [l.rid, l]));
  const secsOf = new Map(), sigOf = new Map();
  const getSecs = (l) => { if (!secsOf.has(l.rid)) { const s = sections(l); secsOf.set(l.rid, s); sigOf.set(l.rid, hashStr("gps-v2|" + encPoly(l.shape) + "|" + l.stops.map((x) => x.id).join(","))); } return secsOf.get(l.rid); };

  // ---- משיכה ----
  let fetched = 0, reqFail = 0;
  if (!OFFLINE) {
    // שילוב קווים חדשים ועדכון הקווים שהמידע שלהם הכי ישן
    const cached = new Set(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
    const inCache = lines.filter((l) => cached.has(String(l.rid).replace(/[^\w-]/g, "_")));
    const fresh = lines.filter((l) => !cached.has(String(l.rid).replace(/[^\w-]/g, "_")))
      .sort((a, b) => (b.tripsDay - a.tripsDay) || (hashStr(a.rid + TODAY) < hashStr(b.rid + TODAY) ? -1 : 1));
    const lastChecked = new Map(inCache.map((l) => { getSecs(l); return [l.rid, Object.keys(loadCache(l, sigOf.get(l.rid)).days).sort().pop() || ""]; }));
    inCache.sort((a, b) => lastChecked.get(a.rid).localeCompare(lastChecked.get(b.rid)) || String(a.rid).localeCompare(String(b.rid)));
    const additions = fresh.slice(0, LINES_PER_NIGHT);
    const order = [];
    for (let i = 0; i < Math.max(inCache.length, additions.length); i++) {
      if (additions[i]) order.push(additions[i]);
      if (inCache[i]) order.push(inCache[i]);
    }
    const dates = []; for (let k = DAYS; k >= 1; k--) dates.push(addDays(TODAY, -k));
    outer: for (let round = 0; round < DAYS; round++) for (const l of order) {
      const secs = getSecs(l), c = loadCache(l, sigOf.get(l.rid));
      // משלימים ימים חסרים, כולל בקשות שנכשלו בריצה קודמת.
      const last = Object.keys(c.days).sort().pop();
      const need = dates.filter((d, k) => c.days[d] == null && (last ? true : (DAYS - 1 - k) % 2 === 0));
      // יום אחד לכל קו בכל סבב, כדי שקו אחד לא יצרוך את כל התקציב.
      const spread = [];
      for (let i = 0, j = need.length - 1; i <= j; i++, j--) { spread.push(need[i]); if (i < j) spread.push(need[j]); }
      for (const d of spread.slice(0, 1)) {
        if (Date.now() - t0 > BUDGET_MS) { saveCache(c); console.error("  תקציב הזמן נגמר"); break outer; }
        let rs;
        try { rs = await fetchDay(l, d); } catch (e) { reqFail++; if (reqFail > 30) { saveCache(c); console.error("  יותר מדי כשלים ב-Stride — עוצר:", e.message); break outer; } continue; }
        c.days[d] = rs.length;
        for (const r of rs) {
          if (r.points.length < 5) continue;
          const bits = evalRide(secs, r.points);
          const drivenFrac = bits.filter((b) => b === 1).length / bits.length;
          if (drivenFrac < 0.5) continue; // נסיעה חלקית / GPS חסר — לא נספרת
          if (c.rides.some((x) => x.id === String(r.id))) continue;
          c.rides.push({ id: String(r.id), d, b: bits.join("") });
          fetched++;
          for (let i = 0; i < bits.length; i++) {
            if (bits[i] !== 0) continue;
            let j = i; while (j + 1 < bits.length && bits[j + 1] === 0) j++;
            const ap = altPath(secs, i, j, r.points);
            if (ap) {
              const key = i + ":" + j;
              if (!c.alt[key]) c.alt[key] = [];
              c.alt[key].push({ d, p: encPoly(ap) });
              c.alt[key] = c.alt[key].filter((x) => x.d >= addDays(TODAY, -DAYS)).slice(-100);
            }
            i = j;
          }
        }
      }
      saveCache(c);
    }
  }
  console.error("  נסיעות חדשות:", fetched, "| כשלי בקשה:", reqFail);

  // ---- ניתוח ----
  const cands = [];
  let linesChecked = 0, ridesChecked = 0;
  for (const f of fs.readdirSync(cacheDir)) {
    if (!f.endsWith(".json")) continue;
    let c; try { c = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf8")); } catch (_e) { continue; }
    const l = byRid.get(c.rid); if (!l) continue;
    const secs = getSecs(l); if (c.sig !== sigOf.get(l.rid)) continue; // הקו שונה ב-GTFS — המטמון לא תקף
    linesChecked++; ridesChecked += c.rides.length;
    for (const k of analyzeLine(l, secs, c)) cands.push({ l, ...k });
  }
  // כלל 2: כמה קווים שונים הפסיקו באותו מקום באותם ימים
  const mid = (p) => p[Math.floor(p.length / 2)];
  for (const a of cands) {
    a.others = new Set();
    for (const b of cands) {
      if (b === a || b.l.number === a.l.number) continue;
      const near = distToPoly(mid(a.segPoly), b.segPoly) <= NEAR_M * 2 || distToPoly(mid(b.segPoly), a.segPoly) <= NEAR_M * 2;
      if (near && b.lastDrove && a.lastDrove && Math.abs(dayDiff(a.since, b.since)) <= SAME_TIME_DAYS) a.others.add(b.l.number);
    }
  }
  const fmtD = (d) => d.split("-").reverse().join(".");
  const issues = cands.map((c) => {
    const L = c.l, from = L.stops[c.s], to = L.stops[c.e + 1];
    const temps = tempChanges(L.rd).filter((d) => Math.abs(dayDiff(d, c.since)) <= TEMP_WINDOW || (d >= c.firstDate && d <= c.lastDate));
    const pct = Math.round(c.allShare * 100);
    let verdict = "סיבה לא ידועה", reason;
    if (c.others.size) { verdict = "כנראה עבודות תשתית"; reason = `גם ${c.others.size > 1 ? "קווים" : "קו"} ${[...c.others].slice(0, 5).join(", ")} ${c.others.size > 1 ? "הפסיקו" : "הפסיק"} לעבור כאן החל מאותם ימים (סביב ${fmtD(c.since)}) — כנראה סגירת כביש או עבודות.`; }
    else if (c.lastDrove && c.drovenBefore >= 3) { verdict = "כנראה עבודות תשתית"; reason = `האוטובוסים עברו כאן עד ${fmtD(c.lastDrove)} והפסיקו מ-${fmtD(c.since)} — כנראה עבודות או סגירה זמנית.`; }
    else if (temps.length) { verdict = "כנראה עבודות תשתית"; reason = `בהיסטוריית הקו יש שינוי זמני שהתבטל (${fmtD(temps[0])}) סביב אותו זמן — כנראה הסטה בגלל עבודות.`; }
    else if (c.missSpan < PERSIST_DAYS) reason = `האוטובוסים לא עוברים כאן כבר ${c.missSpan} ימים — פחות מ-4 שבועות, מוקדם לקבוע שזו טעות קידוד.`;
    else {
      verdict = "חשד לקידוד מיותר";
      reason = `רק ${pct}% מ-${c.ridesChecked} הנסיעות שנבדקו (${fmtD(c.firstDate)}–${fmtD(c.lastDate)}) עוברות במקטע הזה; השאר נוסעות בדרך קצרה ב-${Math.round(c.segM - c.gpsM)} מ'. ייתכן שהמקטע מקודד במסלול בלי שהאוטובוס באמת נוסע בו.`;
    }
    // הקשר: חלק ממסלול הקו סביב המקטע
    const ctx = [].concat(...getSecs(L).slice(Math.max(0, c.s - 2), Math.min(getSecs(L).length, c.e + 3)).map((p, k) => (k ? p.slice(1) : p)));
    return {
      type: "gps", line: L.number, operator: L.operator, dir: L.name, rd: L.rd,
      from: from.name, to: to.name, city: from.city || to.city || "",
      lat: from.lat, lng: from.lng,
      seg: c.segPoly.map(r5), gpsRoute: c.gpsRoute, lineShape: ctx.map(r5),
      segKm: +(c.segM / 1000).toFixed(3), gpsKm: +(c.gpsM / 1000).toFixed(3), excessKm: +((c.segM - c.gpsM) / 1000).toFixed(3),
      tripsDay: L.tripsDay, wasteDayKm: +(((c.segM - c.gpsM) / 1000) * L.tripsDay).toFixed(1),
      evidenceDays: c.evidenceDays, confidence: c.evidenceDays >= 7 && c.ridesChecked >= 30 ? "גבוהה" : "בינונית", ridesChecked: c.ridesChecked, share: +c.allShare.toFixed(2), since: c.since,
      firstDate: c.firstDate, lastDate: c.lastDate, verdict, reason,
    };
  }).sort((a, b) => (a.verdict === b.verdict ? b.wasteDayKm - a.wasteDayKm : a.verdict === "חשד לקידוד מיותר" ? -1 : 1));
  const report = { generatedAt: new Date().toISOString(), today: TODAY, methodVersion: 2, totalLines: allLines.length, ambiguousLines, linesChecked, ridesChecked, requestFailures: reqFail, totalIssues: issues.length,
    byVerdict: issues.reduce((m, i) => ((m[i.verdict] = (m[i.verdict] || 0) + 1), m), {}), issues };
  fs.writeFileSync(outPath, JSON.stringify(report));
  console.error("נכתב:", outPath, "| קווים עם GPS:", linesChecked, "| נסיעות:", ridesChecked, "| ממצאים:", issues.length, JSON.stringify(report.byVerdict), "|", Math.round((Date.now() - t0) / 1000) + "s");
})().catch((e) => { console.error("שגיאה:", e); process.exit(1); });
