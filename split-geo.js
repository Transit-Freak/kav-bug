// פיצול country-scan.json לשני קבצים לטובת הדפדפן:
//   country-scan-lite.json — השדות הטבלאיים בלבד (~100KB, נטען מיד)
//   country-geo.json       — הגאומטריות (~1MB, נטען רק כשפותחים מפה)
//
// אותה לוגיקה קיימת גם בתוך scan-country.js (שרץ בצינור של "הקו הבוחן"
// כקובץ בודד ולכן לא יכול לעשות require לכאן) — אם משנים שדה, לשנות
// בשני המקומות. הסקריפט הזה משמש את הסנכרון היומי (weekly-scan.yml),
// שמייצר את הפיצול מקומית אחרי משיכת country-scan.json — כך שלושת
// הקבצים תמיד עקביים זה עם זה, בלי תלות במה שהצינור המרוחק הספיק לכתוב.
//
// שימוש: node split-geo.js [country-scan.json]
"use strict";
const fs = require("fs");

const src = process.argv[2] || "country-scan.json";
const report = JSON.parse(fs.readFileSync(src, "utf8"));
const issues = report.issues || [];

// _k: אותה טביעה בשני הקבצים — הדפדפן בודק שהגאומטריה שייכת לאותה רשומה (שלמה 29.10: המפה הציגה
// קו אחר כשהקובץ הרזה והגאומטריות הגיעו מסנכרונים שונים — מטמון או סנכרון באמצע)
const keyOf = (i) => { const t = [i.type, i.line, i.operator, i.dir, i.from, i.to, i.lat, i.lng].map((x) => (x == null ? "" : String(x))).join("|"); let h = 5381; for (let k = 0; k < t.length; k++) h = ((h << 5) + h + t.charCodeAt(k)) | 0; return (h >>> 0).toString(36); };
const GEO_FIELDS = ["seg", "refGeom", "lineShape", "optRoute", "optSteps", "gpsRoute"];
const liteIssues = issues.map((i, idx) => {
  const o = { _g: idx, _k: keyOf(i) };   // מפתח הגאומטריה בקובץ הנלווה + טביעה
  for (const k of Object.keys(i)) if (!GEO_FIELDS.includes(k)) o[k] = i[k];
  o.hasGeo = !!((i.seg && i.seg.length > 1) || (i.refGeom && i.refGeom.length > 1));
  return o;
});
const litePath = src.replace(/\.json$/, "-lite.json");
fs.writeFileSync(litePath, JSON.stringify({ ...report, issues: liteIssues }));

const geo = issues.map((i) => {
  const g = { _k: keyOf(i) };
  for (const k of GEO_FIELDS) if (i[k] != null) g[k] = i[k];
  return g;
});
const geoPath = src.replace(/country-scan\.json$/, "country-geo.json");
fs.writeFileSync(geoPath, JSON.stringify(geo));

console.error("נכתב: " + litePath + " (" + Math.round(fs.statSync(litePath).size / 1024) + "KB) + " +
  geoPath + " (" + Math.round(fs.statSync(geoPath).size / 1024) + "KB), " + issues.length + " רשומות");
