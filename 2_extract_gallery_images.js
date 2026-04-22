import { chromium } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import fs from 'fs';
import pLimit from 'p-limit';
import { BRANDS, TARGET_BRANDS } from './config.js';

chromiumExtra.use(StealthPlugin());

const CONCURRENCY = 4;
const limit = pLimit(CONCURRENCY);

// SharkNinja: fetch gallery directly from Cloudinary list API
async function extractSharkNinjaGallery(pdp) {
  const productId = pdp.url.split('/').pop().replace('.html', '');
  const apiUrl = `https://sharkninja-sfcc-prod-res.cloudinary.com/image/list/${productId}.json`;
  const { data } = await axios.get(apiUrl, { timeout: 15000 });

  const images = (data.resources || []).map((r, i) => {
    const viewType = r.metadata?.find(m => m.external_id === 'sfcc-view-type')?.value || '';
    const src = `https://sharkninja-sfcc-prod-res.cloudinary.com/image/upload/f_auto,q_auto,w_800/${r.public_id}`;
    return {
      src,
      alt: r.context?.custom?.alt || '',
      width: r.width,
      height: r.height,
      viewType,
      sequencePosition: i + 1,
    };
  });

  return {
    ...pdp,
    galleryImageCount: images.length,
    images,
    extractedAt: new Date().toISOString(),
  };
}

// All other brands: scrape via Playwright
async function extractGallery(page, pdp) {
  const brand = BRANDS[pdp.brand];
  if (brand.useStealthBrowser) {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  }
  const waitUntil = pdp.brand === 'bissell' ? 'networkidle' : 'domcontentloaded';
  const extraWait = pdp.brand === 'bissell' ? 5000 : 2500;
  await page.goto(pdp.url, { waitUntil, timeout: 45000 });
  await page.waitForTimeout(extraWait);

  // Scroll to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(1000);

  const images = await page.evaluate((selectors) => {
    const imgs = [];
    const seen = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(img => {
        const src = img.src
          || img.dataset?.src
          || img.getAttribute('data-lazy-src')
          || img.getAttribute('srcset')?.split(' ')[0];
        if (src && !src.startsWith('data:') && !seen.has(src)) {
          seen.add(src);
          imgs.push({
            src,
            alt: img.alt || '',
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0,
          });
        }
      });
    }
    return imgs;
  }, brand.gallerySelectors);

  // Filter out icons/tiny images (< 200px wide)
  const filtered = images.filter(img => img.width === 0 || img.width >= 200);

  return {
    ...pdp,
    galleryImageCount: filtered.length,
    images: filtered.map((img, i) => ({ ...img, sequencePosition: i + 1 })),
    extractedAt: new Date().toISOString(),
  };
}

async function extractAll() {
  const allPdps = TARGET_BRANDS.flatMap(b => {
    const path = `data/urls/${b}.json`;
    return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : [];
  });

  console.log(`🖼️  Extracting galleries from ${allPdps.length} PDPs...`);

  const browser = await chromium.launch({ headless: true });
  const stealthBrowser = await chromiumExtra.launch({ headless: true });
  const results = [];
  let done = 0;

  await Promise.all(allPdps.map(pdp => limit(async () => {
    try {
      let result;
      if (pdp.brand === 'sharkninja') {
        result = await extractSharkNinjaGallery(pdp);
      } else {
        const useStealth = pdp.brand === 'bissell' || BRANDS[pdp.brand].useStealthBrowser;
        const activeBrowser = useStealth ? stealthBrowser : browser;
        const page = await activeBrowser.newPage();
        try {
          result = await extractGallery(page, pdp);
        } finally {
          await page.close();
        }
      }
      results.push(result);
    } catch (e) {
      results.push({ ...pdp, images: [], galleryImageCount: 0, error: e.message });
      console.warn(`\n  ❌ ${pdp.url} — ${e.message}`);
    } finally {
      done++;
      process.stdout.write(`\r  ${done}/${allPdps.length} PDPs processed...`);
    }
  })));

  await browser.close();
  await stealthBrowser.close();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/gallery_raw.json', JSON.stringify(results, null, 2));
  console.log(`\n✅ Gallery extraction complete. Saved to data/gallery_raw.json`);
}

extractAll();
