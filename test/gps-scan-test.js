// בדיקת gps-scan.js על נתונים סינתטיים (GTFS קטן + נסיעות GPS מדומות, בלי רשת).
// ארבעה קווים עם אותו סוג "לולאה" מתוכננת שהאוטובוסים לא נוסעים בה:
//   10 — אף פעם לא נוסעים בה, 35 יום        → חשד לקידוד מיותר
//   20+30 — נסעו בה עד לפני 20 יום, ושניהם הפסיקו יחד → עבודות (כלל 2/3)
//   40 — לא נוסעים בה, אבל רק 20 יום נצפו       → עבודות (כלל 1)
//   50 — לא נוסעים 35 יום, אבל בהיסטוריה שינוי זמני שהתבטל → עבודות (כלל 4)
// שימוש: node test/gps-scan-test.js [out-dir]
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "gpsscan-"));
const g = path.join(dir, "gtfs"), fx = path.join(dir, "fx"), cache = path.join(dir, "cache"), hist = path.join(dir, "hist");
for (const d of [g, fx, cache, hist]) fs.mkdirSync(d, { recursive: true });
const TODAY = "2026-09-29";
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const lines = [
  { rid: "1", num: "10", lat: 32.00, mode: "never", days: 35 },
  { rid: "2", num: "20", lat: 32.02, mode: "stopped", days: 35 },
  { rid: "3", num: "30", lat: 32.02, mode: "stopped", days: 35 },
  { rid: "4", num: "40", lat: 32.04, mode: "never", days: 20 },
  { rid: "5", num: "50", lat: 32.06, mode: "never", days: 35 },
];
const stopsTxt = ["stop_id,stop_name,stop_lat,stop_lon,stop_desc"], routes = ["route_id,agency_id,route_short_name,route_long_name,route_desc,route_type"];
const trips = ["route_id,service_id,trip_id,shape_id"], st = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"], shapes = ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence"];
const LNG = [34.800, 34.805, 34.810, 34.815, 34.820];
for (const L of lines) {
  LNG.forEach((x, k) => stopsTxt.push(`${L.rid}${k},תחנה ${L.num}-${k + 1},${L.lat},${x},רחוב: א עיר: בדיקה רציף:`));
  routes.push(`${L.rid},1,${L.num},א<->ב-1#,${L.rid}000-1-0,3`);
  trips.push(`${L.rid},s1,t${L.rid},sh${L.rid}`);
  LNG.forEach((x, k) => st.push(`t${L.rid},0${6 + k}:00:00,0${6 + k}:00:00,${L.rid}${k},${k + 1}`));
  const pts = [];
  for (let x = 34.800; x <= 34.8051; x += 0.001) pts.push([L.lat, x]);
  pts.push([L.lat + 0.001, 34.8055], [L.lat + 0.004, 34.806], [L.lat + 0.004, 34.8075], [L.lat + 0.004, 34.809], [L.lat + 0.001, 34.8095]);
  for (let x = 34.810; x <= 34.8201; x += 0.001) pts.push([L.lat, x]);
  pts.forEach((p, k) => shapes.push(`sh${L.rid},${p[0].toFixed(6)},${p[1].toFixed(6)},${k + 1}`));
  L.shape = pts;
  const rides = [];
  for (let d = L.days; d >= 1; d--) {
    const date = addDays(TODAY, -d);
    const driveLoop = L.mode === "stopped" && d > 20;
    const src = driveLoop ? pts : [];
    if (!driveLoop) for (let x = 34.800; x <= 34.8201; x += 0.0015) src.push([L.lat, x]);
    // נקודת GPS כל ~140 מ' + רעש של כמה מטרים
    const gps = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[i + 1] || a;
      for (let t = 0; t < 1; t += 0.5) gps.push([a[0] + (b[0] - a[0]) * t + (Math.random() - 0.5) * 0.00008, a[1] + (b[1] - a[1]) * t + (Math.random() - 0.5) * 0.00008]);
    }
    rides.push({ id: L.rid + d, date, points: gps });
    if (L.rid === "4") rides.push({ id: L.rid + d + "b", date, points: gps }); // שתי נסיעות ביום — 20 נסיעות ב-20 יום
  }
  fs.writeFileSync(path.join(fx, L.rid + ".json"), JSON.stringify(rides));
}
fs.writeFileSync(path.join(g, "stops.txt"), stopsTxt.join("\n"));
fs.writeFileSync(path.join(g, "routes.txt"), routes.join("\n"));
fs.writeFileSync(path.join(g, "agency.txt"), "agency_id,agency_name\n1,מפעיל בדיקה");
fs.writeFileSync(path.join(g, "trips.txt"), trips.join("\n"));
fs.writeFileSync(path.join(g, "stop_times.txt"), st.join("\n"));
fs.writeFileSync(path.join(g, "shapes.txt"), shapes.join("\n"));
fs.writeFileSync(path.join(hist, "5000-1-0.json"), JSON.stringify({ rd: "5000-1-0", versions: [
  { d: "2026-08-10", k: "reroute", note: "שינוי מסלול", rv: 9 }, { d: "2026-08-19", k: "reroute", rvb: 1 }] }));
const out = path.join(dir, "gps-scan.json");
cp.execFileSync("node", [path.join(__dirname, "..", "gps-scan.js"), g, cache, out, "--history", hist],
  { env: { ...process.env, GPS_FIXTURE: fx, GPS_TODAY: TODAY, GPS_RIDES_PER_DAY: "2" }, stdio: "inherit" });
const r = JSON.parse(fs.readFileSync(out, "utf8"));
const v = (n) => (r.issues.find((i) => i.line === n) || {}).verdict;
const expect = { 10: "חשד לקידוד מיותר", 20: "כנראה עבודות תשתית", 30: "כנראה עבודות תשתית", 40: "כנראה עבודות תשתית", 50: "כנראה עבודות תשתית" };
let ok = true;
for (const [n, want] of Object.entries(expect)) { const got = v(n); console.log((got === want ? "✓" : "✗"), "קו", n, got, "|", (r.issues.find((i) => i.line === n) || {}).reason); if (got !== want) ok = false; }
if (r.issues.length !== 5) { console.log("✗ מספר ממצאים", r.issues.length); ok = false; }
// ריצה שנייה: המטמון מלא — לא אמורה להוסיף נסיעות
cp.execFileSync("node", [path.join(__dirname, "..", "gps-scan.js"), g, cache, out, "--history", hist],
  { env: { ...process.env, GPS_FIXTURE: fx, GPS_TODAY: TODAY, GPS_RIDES_PER_DAY: "2" }, stdio: "inherit" });
const r2 = JSON.parse(fs.readFileSync(out, "utf8"));
if (r2.ridesChecked !== r.ridesChecked) { console.log("✗ ריצה חוזרת שינתה את מספר הנסיעות"); ok = false; }
console.log(ok ? "gps-scan OK (" + out + ")" : "gps-scan FAILED");
process.exit(ok ? 0 : 1);
