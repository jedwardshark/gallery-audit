// One-off seed: extract Rimowa PDP galleries via stealth Playwright.
// Rimowa is behind Akamai (bare-fetch returns 403) and networkidle never quiesces,
// so we use domcontentloaded + post-wait. Gallery imagery lives at /Sites-rimowa-
// master-catalog-final/ paths under www.rimowa.com; chrome lives at
// /Library-Sites-RimowaSharedLibrary/. The path filter is what distinguishes them.

import fs from 'fs';
import { chromium as stealth } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const GALLERY_PATH = 'data/gallery_raw.json';
const URL_LIST = 'data/urls/rimowa.json';

async function main() {
  stealth.use(StealthPlugin());
  const all = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  const existingUrls = new Set(all.map(p => p.url));
  const urls = JSON.parse(fs.readFileSync(URL_LIST, 'utf8'));
  console.log('Rimowa: ' + urls.length + ' URLs');

  const browser = await stealth.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });

  let added = 0, errors = 0, done = 0;
  try {
    for (const { url } of urls) {
      if (existingUrls.has(url)) { done++; continue; }
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        await page.evaluate(async () => {
          const els = document.querySelectorAll('[class*="product-image"] img');
          for (const el of els) { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 200)); }
        });
        await page.waitForTimeout(1500);
        const imgs = await page.evaluate(() => {
          const out = [];
          const found = new Set();
          document.querySelectorAll('[class*="product-image"] img').forEach(el => found.add(el));
          let i = 0;
          for (const el of found) {
            const src = el.currentSrc || el.src || '';
            if (!src || src.startsWith('data:')) continue;
            if (!src.includes('Sites-rimowa-master-catalog-final')) continue;
            out.push({ src, alt: el.alt || '', width: el.naturalWidth || 0, height: el.naturalHeight || 0, sequencePosition: ++i });
          }
          // Dedup by clean src
          const seen = new Set();
          const dedupd = [];
          for (const im of out) {
            const k = im.src.split('?')[0];
            if (seen.has(k)) continue;
            seen.add(k);
            dedupd.push(im);
          }
          return dedupd;
        });
        const path = new URL(url).pathname.split('/').filter(Boolean);
        const result = {
          brand: 'rimowa', brandName: 'Rimowa', url,
          sku: path[path.length - 1].replace('.html', ''),
          family: path[2] || 'unknown',
          category: path[3] || 'unknown',
          productTitle: null,
          galleryImageCount: imgs.length, images: imgs,
          extractorPath: 'stealth-scrollIntoView',
          extractedAt: new Date().toISOString(),
        };
        all.push(result);
        added++; done++;
        if (done % 20 === 0) {
          console.log('  [' + done + '/' + urls.length + '] added=' + added + ' errors=' + errors);
          fs.writeFileSync(GALLERY_PATH, JSON.stringify(all, null, 2));
        }
      } catch (e) {
        errors++; done++;
        console.log('  ERR ' + url.slice(0, 70) + ': ' + e.message.slice(0, 60));
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(GALLERY_PATH, JSON.stringify(all, null, 2));
  console.log('Final added=' + added + ' errors=' + errors);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
