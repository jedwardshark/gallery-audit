import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import zlib from 'zlib';
import { chromium } from 'playwright';
import { BRANDS, TARGET_BRANDS } from './config.js';

function getSegment(pathname, index) {
  const parts = pathname.split('/').filter(Boolean);
  return parts[index] || 'unknown';
}

async function fetchSitemap(url, gzipped = false) {
  const { data } = await axios.get(url, {
    timeout: 30000,
    responseType: gzipped ? 'arraybuffer' : 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  const xml = gzipped ? zlib.gunzipSync(Buffer.from(data)).toString('utf8') : data;
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemaps = [], urls = [];
  $('sitemap > loc').each((_, el) => sitemaps.push($(el).text().trim()));
  $('url > loc').each((_, el) => urls.push($(el).text().trim()));
  return { sitemaps, urls };
}

async function fetchSitemapWithBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const content = await page.content();
  await browser.close();
  const $ = cheerio.load(content, { xmlMode: true });
  const sitemaps = [], urls = [];
  $('sitemap > loc').each((_, el) => sitemaps.push($(el).text().trim()));
  $('url > loc').each((_, el) => urls.push($(el).text().trim()));
  return { sitemaps, urls };
}

async function crawlBrevilleCategories(brand) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const allProductUrls = new Set();

  for (const categoryUrl of brand.categoryPages) {
    try {
      await page.goto(categoryUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Scroll to trigger lazy loading
      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise(r => setTimeout(r, 600));
        }
      });

      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/en-us/product/"]'))
          .map(a => a.href)
      );

      links.forEach(l => allProductUrls.add(l.split('?')[0]));
      process.stdout.write(`\r   ${allProductUrls.size} URLs found...`);
    } catch (e) {
      console.warn(`\n   ⚠️  Skipped: ${categoryUrl} — ${e.message}`);
    }
  }

  await browser.close();
  return [...allProductUrls].filter(u => brand.pdpPattern.test(u));
}

async function crawlBrand(brandKey) {
  const brand = BRANDS[brandKey];
  console.log(`\n🔍 Crawling ${brand.name}...`);

  let allUrls = [];

  if (brandKey === 'breville') {
    allUrls = await crawlBrevilleCategories(brand);
  } else {
    const useBrowser = brandKey === 'dyson';
    const queue = [...brand.sitemaps];

    while (queue.length) {
      const url = queue.shift();
      const gzipped = brand.sitemapGzipped || url.endsWith('.gz');
      try {
        const { sitemaps, urls } = useBrowser
          ? await fetchSitemapWithBrowser(url)
          : await fetchSitemap(url, gzipped);
        queue.push(...sitemaps);
        allUrls.push(...urls);
        process.stdout.write(`\r   ${allUrls.length} URLs found...`);
      } catch (e) {
        console.warn(`\n   ⚠️  Skipped: ${url} — ${e.message}`);
      }
    }

    allUrls = [...new Set(allUrls.filter(u => {
      if (!brand.pdpPattern.test(u)) return false;
      if (brand.pdpKeywords && !brand.pdpKeywords.test(u)) return false;
      return true;
    }))];
  }

  if (brand.sampleSize && allUrls.length > brand.sampleSize) {
    allUrls = allUrls.sort(() => Math.random() - 0.5).slice(0, brand.sampleSize);
    console.log(`\n   ✂️  Sampled ${brand.sampleSize} of ${allUrls.length + brand.sampleSize} total`);
  }

  const pdps = allUrls.map(u => {
    const path = new URL(u).pathname;
    return {
      brand: brandKey,
      brandName: brand.name,
      url: u,
      family: getSegment(path, brand.familySegment),
      category: getSegment(path, brand.categorySegment),
    };
  });

  fs.mkdirSync('data/urls', { recursive: true });
  fs.writeFileSync(`data/urls/${brandKey}.json`, JSON.stringify(pdps, null, 2));
  console.log(`\n   ✅ ${pdps.length} PDPs found`);
  return pdps;
}

async function crawlAll() {
  const all = [];
  for (const brand of TARGET_BRANDS) {
    const pdps = await crawlBrand(brand);
    all.push(...pdps);
  }
  console.log(`\n✅ Total: ${all.length} PDPs across all brands`);
  console.log('   Saved to data/urls/');
}

crawlAll();
