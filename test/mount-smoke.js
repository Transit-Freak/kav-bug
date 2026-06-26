// בדיקת-mount אוטומטית (jsdom) — מרימה את רכיבי-ה-React האמיתיים, *מריצה את
// ה-effects*, ומוודאת שאין קריסת "דף לבן". זה התרחיש שבדיקת-SSR פספסה: ה-effects
// רצים רק בדפדפן, והבאג ב-4.2 (initialCity שאינו מחרוזת → קריסה ב-useEffect) לא
// נתפס. הבדיקה מדמה דפדפן עם jsdom, מזריקה fetch מזויף (country-scan.json),
// ומרנדרת את CountryModal/TopBar עם props קיצוניים — כולל ה-props ששברו את הדף.
//
// הרצה:  NODE_PATH=<deps> node test/mount-smoke.js
//   deps נדרשים: jsdom, react@18, react-dom@18, @babel/core, @babel/preset-react
//
// יוצא עם קוד 0 אם הכל עבר, 1 אם בדיקה כלשהי נכשלה (מתאים ל-CI).

const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

// ---------- 1) סביבת-דפדפן מזויפת ----------
const dom = new JSDOM("<!DOCTYPE html><html lang='he'><body><div id='root'></div></body></html>", {
  url: "https://example.org/", pretendToBeVisual: true,
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.Event = window.Event;
global.getComputedStyle = window.getComputedStyle.bind(window);
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
window.matchMedia = window.matchMedia || (() => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
window.KAVBUG_BUILD = "test";

// ---------- 2) React גלובלי (components.jsx משתמש ב-React הגלובלי) ----------
const React = require("react");
const ReactDOM = require("react-dom");
const { createRoot } = require("react-dom/client");
const { act } = require("react-dom/test-utils");
global.React = window.React = React;
global.ReactDOM = window.ReactDOM = ReactDOM;

// ---------- 3) fetch מזויף ----------
const report = JSON.parse(fs.readFileSync(path.join(ROOT, "country-scan.json"), "utf8"));
const fetchLog = [];
const fakeFetch = async (url) => {
  fetchLog.push(String(url));
  if (String(url).includes("country-scan.json"))
    return { ok: true, status: 200, json: async () => report };
  // geocode (nominatim) — מחזיר bbox מזויף
  return { ok: true, status: 200, json: async () => ([{ boundingbox: ["32.00", "32.10", "34.80", "34.90"], lat: "32.05", lon: "34.85", display_name: "עיר-בדיקה" }]) };
};
global.fetch = window.fetch = fakeFetch;

// ---------- 4) טעינת components.jsx האמיתי (כמו באתר) ----------
// runtime classic = React.createElement (כמו באתר החי שטוען React כגלובל) — לא
// "automatic" שמזריק import ל-react/jsx-runtime ושובר את ה-eval כאן.
const REACT_PRESET = ["@babel/preset-react", { runtime: "classic" }];
const src = babel.transformFileSync(path.join(ROOT, "components.jsx"), { presets: [REACT_PRESET] }).code;
try { (0, eval)(src); } catch (e) { console.error("✗ components.jsx לא נטען:", e.message); process.exit(1); }
const { CountryModal, TopBar } = window;
if (!CountryModal || !TopBar) { console.error("✗ CountryModal/TopBar לא נחשפו על window"); process.exit(1); }

// CountryIssuePanel חי ב-app.jsx (שלא ניתן לטעון כולו — הוא מבצע mount עם Leaflet).
// חולצים *רק* את הפונקציה (פרזנטציה טהורה, משתמשת ב-fmt הגלובלי) ומריצים אותה.
let CountryIssuePanel = null;
try {
  const appSrc = fs.readFileSync(path.join(ROOT, "app.jsx"), "utf8");
  const s = appSrc.indexOf("function CountryIssuePanel");
  const e = appSrc.indexOf("\nfunction KavBug", s);
  if (s >= 0 && e > s) {
    const fnJsx = appSrc.slice(s, e);
    const fnCode = babel.transformSync(fnJsx, { presets: [REACT_PRESET] }).code;
    CountryIssuePanel = (0, eval)("(function(){ " + fnCode + "; return CountryIssuePanel; })()");
  }
} catch (e) { console.error("אזהרה: CountryIssuePanel לא חולץ —", e.message); }

// ---------- עזרי-mount ----------
const flush = () => new Promise((r) => setTimeout(r, 0));
async function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let thrown = null;
  const origErr = console.error;
  const errs = [];
  console.error = (...a) => { errs.push(a.join(" ")); };
  try {
    await act(async () => { root.render(element); });
    await act(async () => { await flush(); await flush(); }); // הרצת ה-effects + flush ל-fetch
  } catch (e) { thrown = e; }
  console.error = origErr;
  const text = host.textContent || "";
  return { host, root, thrown, text, errs };
}

// ---------- 5) הבדיקות ----------
(async () => {
  console.log("בדיקת-mount (jsdom, effects חיים):\n");

  // (א) CountryModal נפתח וטוען את הדוח — חייב להציג תוכן (לא דף-לבן)
  {
    const { thrown, text, errs } = await mount(React.createElement(CountryModal, { open: true, onClose: () => {}, onPick: () => {} }));
    if (thrown) bad("CountryModal(open) זרק חריגה: " + thrown.message);
    else if (!text || text.length < 20) bad("CountryModal(open) רינדר ריק (דף-לבן)");
    else if (!/עיקופים|הכרעה|קו/.test(text)) bad("CountryModal(open) ללא תוכן-דוח צפוי");
    else ok("CountryModal(open) נטען, הריץ fetch, והציג את הדוח");
    if (errs.some((e) => /Cannot read|undefined|trim/.test(e))) bad("CountryModal(open) — שגיאת-effect ב-console: " + errs.find((e) => /Cannot read|undefined|trim/.test(e)));
  }

  // (ב) regression לקריסת-הדף-הלבן: initialCity שאינו מחרוזת (כמו ה-event שדלף
  //     ב-4.2). עם ה-guard — חייב לרנדר בלי לקרוס. בלי ה-guard — היה קורס כאן.
  for (const badCity of [{ nativeEvent: {}, type: "click" }, 42, {}, []]) {
    const { thrown, text, errs } = await mount(React.createElement(CountryModal, { open: true, onClose: () => {}, onPick: () => {}, initialCity: badCity }));
    const label = "initialCity=" + (Array.isArray(badCity) ? "[]" : typeof badCity === "object" ? "object" : JSON.stringify(badCity));
    if (thrown) bad("דף-לבן! CountryModal עם " + label + " זרק: " + thrown.message);
    else if (!text || text.length < 20) bad("דף-לבן! CountryModal עם " + label + " רינדר ריק");
    else if (errs.some((e) => /trim|Cannot read|is not a function/.test(e))) bad("דף-לבן! שגיאת-effect עם " + label);
    else ok("עמיד לקריסה: CountryModal עם " + label);
  }

  // (ג) initialCity תקין (מחרוזת) — מפעיל את חיפוש-העיר (lookupCity)
  {
    const { thrown, text } = await mount(React.createElement(CountryModal, { open: true, onClose: () => {}, onPick: () => {}, initialCity: "תל אביב" }));
    if (thrown) bad("CountryModal(initialCity='תל אביב') זרק: " + thrown.message);
    else if (!text) bad("CountryModal(initialCity='תל אביב') ריק");
    else ok("CountryModal עם שם-עיר תקין נטען וחיפש עיר");
  }

  // (ד) CountryModal inline — הדוח הארצי *ישר בפאנל* (בלי חלון/overlay). חייב
  //     לטעון את הדוח ולהציג תוכן, ולרנדר כ-<aside class="panel"> ולא כ-modal.
  {
    const { thrown, text, host } = await mount(React.createElement(CountryModal, { inline: true, onPick: () => {} }));
    if (thrown) bad("CountryModal(inline) זרק: " + thrown.message);
    else if (!text || !/עיקופים|הכרעה|קו/.test(text)) bad("CountryModal(inline) לא הציג את הדוח");
    else if (host.querySelector(".modal-overlay")) bad("CountryModal(inline) רינדר חלון (overlay) במקום פאנל");
    else if (!host.querySelector(".country-panel")) bad("CountryModal(inline) לא רינדר כ-.country-panel");
    else ok("CountryModal(inline) — הדוח ישר בפאנל (בלי חלון)");
  }

  // (ד2) TopBar — נטען בלי להתרסק (הכפתור 'כל הארץ' הוסר; החיפוש דרך onCountry)
  {
    const { thrown } = await mount(React.createElement(TopBar, {
      query: "", setQuery: () => {}, onSelect: () => {}, cityNames: [],
      onUpload: () => {}, onInfo: () => {}, onReport: () => {}, onCountry: () => {},
    }));
    if (thrown) bad("TopBar זרק: " + thrown.message);
    else ok("TopBar נטען (בלי כפתור 'כל הארץ')");
  }

  // (ה) CountryIssuePanel — לחיצה על קו ב"כל הארץ" מציגה את פרטי-העיקוף בפאנל
  //     (במקום מסך "בחרו עיר / העלו קובץ" שבלבל). חייב להציג מספר-קו והכרעה.
  if (CountryIssuePanel) {
    const issue = { line: "6", operator: "דן בדרום", from: "תחנה א", to: "תחנה ב",
      ref: "17", excessKm: 0.75, wasteDayKm: 42, verdict: "אמיתי",
      reason: "סטייה של 0.75 ק\"מ מול קו 17 — עיקוף אמיתי." };
    const { thrown, text } = await mount(React.createElement(CountryIssuePanel, { issue, onBack: () => {}, onClose: () => {} }));
    if (thrown) bad("CountryIssuePanel זרק: " + thrown.message);
    else if (!/קו 6/.test(text)) bad("CountryIssuePanel לא הציג את מספר-הקו");
    else if (!/אמיתי/.test(text)) bad("CountryIssuePanel לא הציג את ההכרעה");
    else if (/בחרו עיר|העלו קובץ/.test(text)) bad("CountryIssuePanel הציג בטעות מסך 'בחרו עיר'");
    else ok("CountryIssuePanel מציג פרטי-עיקוף (קו 6, הכרעה) — לא מסך 'בחרו עיר'");
  } else bad("CountryIssuePanel לא חולץ מ-app.jsx");

  // ---------- סיכום ----------
  console.log("\nfetch שנקראו:", fetchLog.filter((u) => u.includes("country-scan")).length, "× country-scan.json");
  if (failures) { console.log("\n✗ " + failures + " בדיקות נכשלו"); process.exit(1); }
  console.log("\n✓ כל בדיקות-ה-mount עברו");
  process.exit(0);
})();
