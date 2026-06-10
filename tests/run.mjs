#!/usr/bin/env node
/* ===========================================================================
   קו באג — harness בדיקות-רגרסיה למנוע ההכרעה (fallbackVerdict)
   טוען את פונקציות-ההכרעה *מתוך הקוד החי* (components.jsx — מקור-אמת יחיד),
   מריץ אותן על כל מקרי הקורפוס (tests/cases/) ומשווה לסיווג הצפוי (labels.json).
   מטרה: כל שינוי עתידי במנוע חייב לשמור את כל המקרים ירוקים — אי אפשר "לתקן
   מקרה אחד ולשבור אחר" בלי שזה יצוף כאן.  הרצה:  node tests/run.mjs
   =========================================================================== */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// --- חילוץ פונקציות-ההכרעה מ-components.jsx לפי שם (בלי לטעון React/JSX) ---
const src = readFileSync(join(root, "components.jsx"), "utf8");
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("function not found: " + name);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end);
}
const FNS = [
  "geoFeatures", "pathSelfReturnKm", "geoClassify",
  "entryAxisDisqualified", "differentApproachDoubt", "differentApproachReason",
  "fallbackVerdict",
];
const fallbackVerdict = new Function(
  FNS.map(extractFn).join("\n") + "\nreturn fallbackVerdict;"
)();

// --- טעינת הקורפוס ---
const labels = JSON.parse(readFileSync(join(here, "labels.json"), "utf8")).cases;
const known = new Set(labels.map((c) => c.file));
for (const f of readdirSync(join(here, "cases"))) {
  if (f.endsWith(".json") && !known.has(f)) {
    console.log(`⚠️  ${f} קיים ב-cases/ אך חסר ב-labels.json`);
  }
}

// --- הרצה ---
let pass = 0;
const fails = [];
for (const c of labels) {
  const raw = JSON.parse(readFileSync(join(here, "cases", c.file), "utf8"));
  const d = raw.worst && raw.worst.diag;
  if (!d) { fails.push(`${c.file}: אין worst.diag`); continue; }
  let got;
  try { got = fallbackVerdict(d).verdict; }
  catch (e) { fails.push(`${c.file}: שגיאה — ${e.message}`); continue; }
  const ok = got === c.expect;
  if (ok) pass++; else fails.push(`${c.file}: קיבל "${got}", צפוי "${c.expect}"  (${c.note || ""})`);
  console.log(`${ok ? "✓" : "✗"}  ${c.file.padEnd(28)} => ${got}`);
}

console.log(`\n${pass}/${labels.length} עברו`);
if (fails.length) {
  console.log("\nכשלונות:");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("כל המקרים ירוקים ✓");
