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

// Tuning notes: an earlier run fired ~100 PDPs at Rimowa in quick succession and tripped
// Akamai's bot detection (HTTP 403 "Access Denied" with reference #18.99292117...). The
// pacing below is the cooled-down version: ~4-6s between PDPs (randomized to look less
// scripted), fresh browser context every 25 PDPs (so cookies + connection state reset),
// and the broader selector list captures imgs whether or not the gallery container uses
// "product-image" class naming.
const PER_PDP_DELAY_MIN_MS = 4000;
const PER_PDP_DELAY_MAX_MS = 6000;
const RESTART_EVERY = 25;
const COOLDOWN_BETWEEN_BROWSERS_MS = 8000;

async function launchBrowser() {
  const browser = await stealth.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  return { browser, page };
}

async function main() {
  stealth.use(StealthPlugin());
  const all = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  const existingUrls = new Set(all.map(p => p.url));
  const urls = JSON.parse(fs.readFileSync(URL_LIST, 'utf8'));
  console.log('Rimowa: ' + urls.length + ' URLs · per-PDP delay ' + PER_PDP_DELAY_MIN_MS + '-' + PER_PDP_DELAY_MAX_MS + 'ms · browser restart every ' + RESTART_EVERY);

  let { browser, page } = await launchBrowser();
  let processedThisBrowser = 0;
  let added = 0, errors = 0, done = 0, akamaiBlocks = 0;

  try {
    for (const { url } of urls) {
      if (existingUrls.has(url)) { done++; continue; }

      // Restart browser context periodically so cookies + connection state reset.
      if (processedThisBrowser >= RESTART_EVERY) {
        console.log('  [browser-restart] processed=' + processedThisBrowser + ' · cooling ' + COOLDOWN_BETWEEN_BROWSERS_MS + 'ms');
        await browser.close();
        await new Promise(r => setTimeout(r, COOLDOWN_BETWEEN_BROWSERS_MS));
        ({ browser, page } = await launchBrowser());
        processedThisBrowser = 0;
      }

      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3500);

        // Detect Akamai block early — if title says "Access Denied", record and back off.
        const title = await page.title();
        if (/Access Denied/i.test(title) || resp.status() === 403) {
          akamaiBlocks++;
          console.log('  [akamai-block] ' + url.slice(0, 70) + ' · cooling 60s');
          await new Promise(r => setTimeout(r, 60000));
          // Force browser restart on next iteration
          processedThisBrowser = RESTART_EVERY;
          done++;
          continue;
        }

        // Broader selector list — earlier run found `[class*="product-image"]` matched
        // 0 elements on actual PDPs (only the homepage probe had it). Try several
        // common Demandware/SFCC gallery class patterns.
        await page.evaluate(async () => {
          const sels = ['[class*="product-image"] img', '[class*="primary-images"] img', '[class*="image-container"] img', '[class*="carousel"] img', 'img'];
          const allImgs = new Set();
          for (const sel of sels) document.querySelectorAll(sel).forEach(el => allImgs.add(el));
          for (const el of allImgs) { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 100)); }
        });
        await page.waitForTimeout(2000);
        const imgs = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('img').forEach((el, i) => {
            const src = el.currentSrc || el.src || '';
            if (!src || src.startsWith('data:')) return;
            if (!src.includes('Sites-rimowa-master-catalog-final')) return;
            out.push({ src, alt: el.alt || '', width: el.naturalWidth || 0, height: el.naturalHeight || 0, sequencePosition: i + 1 });
          });
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
        added++; done++; processedThisBrowser++;
        if (done % 10 === 0) {
          console.log('  [' + done + '/' + urls.length + '] added=' + added + ' errors=' + errors + ' akamai=' + akamaiBlocks);
          fs.writeFileSync(GALLERY_PATH, JSON.stringify(all, null, 2));
        }
        // Randomized inter-PDP delay
        const delay = PER_PDP_DELAY_MIN_MS + Math.random() * (PER_PDP_DELAY_MAX_MS - PER_PDP_DELAY_MIN_MS);
        await new Promise(r => setTimeout(r, delay));
      } catch (e) {
        errors++; done++; processedThisBrowser++;
        console.log('  ERR ' + url.slice(0, 70) + ': ' + e.message.slice(0, 60));
        // Brief back-off after errors too
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }
  fs.writeFileSync(GALLERY_PATH, JSON.stringify(all, null, 2));
  console.log('Final added=' + added + ' errors=' + errors + ' akamai-blocks=' + akamaiBlocks);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
