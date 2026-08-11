// בדיקת-עשן בדפדפן אמיתי (Playwright) — הרצה ידנית/מקומית, לא ב-CI.
//
// משלימה את mount-smoke.js: שם נבדקים הרכיבים ב-jsdom; כאן נבדק הצינור
// המלא של index.html — טעינת vendor/React, קומפילציית Babel עם מטמון,
// המסלול הרזה (country-scan-lite.json) והגאומטריה העצלה (country-geo.json).
//
// הרצה:  node test/check-ui.mjs [ספריית-אתר]
//   דרישות: playwright-core (נגיש דרך PW_MODULES או node_modules), כרומיום
//   ב-CHROMIUM_PATH (ברירת-מחדל /opt/pw-browsers/chromium). אם הרשת חסומה,
//   BABEL_LOCAL יכול להצביע על עותק מקומי של babel.min.js.
import fs from 'fs'; import http from 'http'; import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = process.argv[2] || path.join(HERE, '..');
const require_ = createRequire(path.join(process.env.PW_MODULES || SITE, 'noop.js'));
const { chromium } = require_('playwright-core');
const MIME = { '.html':'text/html','.js':'text/javascript','.jsx':'text/javascript','.css':'text/css','.json':'application/json' };
const srv = http.createServer((req,res)=>{
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
  try{ const p=path.join(SITE,rel); let b=fs.readFileSync(p);
    // חתימות SRI נכשלות בכוונה כשהסטאב מחליף קובצי CDN — מסירים אותן כאן
    if(p.endsWith('index.html')) b=Buffer.from(b.toString().replace(/\s(integrity|crossorigin)="[^"]*"/g,''));
    res.writeHead(200,{'content-type':MIME[path.extname(p)]||'application/octet-stream'}); res.end(b);
  }catch{ res.writeHead(404); res.end(); }
});
await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));
const port=srv.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/opt/pw-browsers/chromium',args:['--no-sandbox']});
const page=await browser.newPage();
const errs=[]; const reqs=[];
page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
page.on('request',r=>{ const u=r.url(); if(u.includes('country-')) reqs.push(u.split('/').pop().split('?')[0]); });
await page.route('**://unpkg.com/**', r=>{
  const u=r.request().url();
  if(u.endsWith('.css')) return r.fulfill({contentType:'text/css',body:''});
  if(u.includes('babel') && process.env.BABEL_LOCAL)
    return r.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.env.BABEL_LOCAL)});
  if(u.includes('babel')) return r.continue();
  // סטאב Proxy ללפלט: כל שרשרת קריאות מחזירה את עצמה — עמיד לכל API
  return r.fulfill({contentType:'text/javascript',body:`(function(){var P=new Proxy(function(){},{get:function(t,k){if(k===Symbol.toPrimitive||k==='toString')return function(){return ''};return P;},apply:function(){return P;},construct:function(){return P;}});window.L=P;})();`});
});
await page.route('**://fonts.g**/**', r=>r.fulfill({contentType:'text/css',body:''}));
await page.route('**://*.tile.openstreetmap.org/**', r=>r.fulfill({body:Buffer.from([])}));
await page.goto('http://127.0.0.1:'+port+'/index.html',{waitUntil:'domcontentloaded'});
await page.waitForSelector('.country-table table tbody tr, table tbody tr',{timeout:90000})
  .catch(async()=>{ console.log('גוף:',(await page.innerText('body').catch(()=>'')).slice(0,200)); console.log('שגיאות:',errs.slice(0,4)); console.log('❌ הטבלה לא עלתה'); process.exit(1); });
const rows=await page.locator('table tbody tr').count();
const usedLite=reqs.includes('country-scan-lite.json');
const spark=await page.locator('.kb-spark').count();
const share=await page.locator('button[title="העתקת קישור ישיר לעיקוף הזה"]').count();
// לחיצה על שורה — טעינת הגאומטריה העצלה
await page.locator('table tbody tr.clickable').first().click().catch(()=>{});
await page.waitForTimeout(1500);
const geoLoaded=reqs.includes('country-geo.json');
console.log('✓ טבלה: '+rows+' שורות · נטען lite: '+(usedLite?'כן':'לא')+' · גרף מגמה: '+(spark?'כן':'לא')+' · כפתורי שיתוף: '+share+' · גאומטריה עצלה: '+(geoLoaded?'כן':'לא'));
if(errs.length){ console.log('❌ שגיאות JS:',errs.slice(0,4)); process.exit(1); }
if(!usedLite||!rows){ console.log('❌ מסלול ה-lite לא עבד'); process.exit(1); }
console.log('✅ קו באג עובר');
await browser.close(); srv.close(); process.exit(0);
