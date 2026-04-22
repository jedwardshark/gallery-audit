import express from 'express';
import { chromium } from 'playwright';
import { chromium as chromiumStealth } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import * as cheerio from 'cheerio';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import cron from 'node-cron';

chromiumStealth.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8081;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
};

const app = express();
app.use(express.json());
// express.static registered last so API routes always take priority over file serving

// ── SSE registry ────────────────────────────────────────────────────────────
const streams = new Map();

function emit(id, type, data) {
  const res = streams.get(id);
  if (res) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

app.get('/api/stream/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  streams.set(req.params.id, res);
  req.on('close', () => streams.delete(req.params.id));
});

// ── Realistic browser layer ──────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
];

async function setupPage(page) {
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
  await page.setViewportSize(viewport);
  await page.setExtraHTTPHeaders({
    ...HEADERS,
    'Accept-Language': 'en-US,en;q=0.9',
  });
  // Spoof navigator.languages and screen to match the chosen viewport
  await page.addInitScript(({ vw, vh }) => {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    Object.defineProperty(screen, 'width', { get: () => vw });
    Object.defineProperty(screen, 'height', { get: () => vh });
    Object.defineProperty(screen, 'availWidth', { get: () => vw });
    Object.defineProperty(screen, 'availHeight', { get: () => vh });
  }, { vw: viewport.width, vh: viewport.height });
}

async function dismissCookieConsent(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyButtonAccept',
    '.qc-cmp2-accept-all',
    '.osano-cm-accept-all',
    '.iubenda-cs-accept-btn',
    'button[id*="accept-all"]',
    'button[class*="accept-all"]',
    '[data-testid*="accept"]',
    'button[aria-label*="Accept"]',
  ];
  for (const selector of selectors) {
    try {
      await page.click(selector, { timeout: 1500 });
    } catch {
      // silent — not all banners exist on every site
    }
  }
}

function detectBlocked(title, currentUrl, bodyText) {
  const haystack = `${title} ${bodyText}`;
  if (/just a moment|cloudflare/i.test(haystack)) {
    return { blocked: true, reason: 'Cloudflare challenge' };
  }
  if (/access denied|403 forbidden/i.test(haystack)) {
    return { blocked: true, reason: 'Access denied (403)' };
  }
  if (/bot detected|security check|verify you are human/i.test(haystack)) {
    return { blocked: true, reason: 'Bot detection triggered' };
  }
  if (/too many requests|rate limit/i.test(haystack)) {
    return { blocked: true, reason: 'Rate limited' };
  }
  if (/please enable javascript/i.test(haystack)) {
    return { blocked: true, reason: 'JS disabled page (use stealth)' };
  }
  if (bodyText.trim().length < 800) {
    return { blocked: true, reason: 'Empty page' };
  }
  return { blocked: false };
}

function randJitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.4);
}

// ── Sitemap XML helpers ─────────────────────────────────────────────────────
async function fetchXml(url, timeoutMs = 45000) {
  const gzipped = url.endsWith('.gz');
  const { data } = await axios.get(url, {
    timeout: timeoutMs,
    responseType: gzipped ? 'arraybuffer' : 'text',
    headers: HEADERS,
    maxRedirects: 5,
  });
  const text = gzipped ? zlib.gunzipSync(Buffer.from(data)).toString('utf8') : data;
  return text;
}

function parseSitemapXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const subSitemaps = [];
  const urls = [];
  $('sitemap > loc').each((_, el) => subSitemaps.push($(el).text().trim()));
  $('url > loc').each((_, el) => urls.push($(el).text().trim()));
  return { subSitemaps, urls };
}

// ── Discover: robots.txt → common paths → URL pattern analysis ──────────────
app.post('/api/discover', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let origin;
  try { origin = new URL(url).origin; }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const sitemaps = [];
  const log = [];

  // 1. robots.txt
  try {
    const { data: txt } = await axios.get(`${origin}/robots.txt`, { timeout: 10000, headers: HEADERS });
    txt.split('\n').forEach(line => {
      const m = line.match(/^sitemap:\s*(.+)/i);
      if (m) sitemaps.push(m[1].trim());
    });
    log.push(sitemaps.length
      ? `robots.txt → found ${sitemaps.length} sitemap(s)`
      : 'robots.txt → no Sitemap: directives');
  } catch (e) {
    log.push(`robots.txt → ${e.code || e.message}`);
  }

  // 2. Common paths fallback
  if (!sitemaps.length) {
    const candidates = [
      '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
      '/sitemaps/sitemap.xml', '/sitemap/sitemap.xml',
      '/sitemap.xml.gz', '/sitemap_index.xml.gz',
    ];
    for (const p of candidates) {
      try {
        const r = await axios.head(`${origin}${p}`, { timeout: 8000, headers: HEADERS, maxRedirects: 3 });
        if (r.status < 400) { sitemaps.push(`${origin}${p}`); log.push(`Found at ${p}`); break; }
      } catch {}
    }
  }

  if (!sitemaps.length) {
    return res.json({ sitemaps: [], patterns: [], sampleUrls: [], log,
      warning: 'No sitemaps found automatically. Enter the sitemap URL manually.' });
  }

  // 3. Sample URLs from first sitemap to suggest PDP patterns
  const sampleUrls = [];
  try {
    const xml = await fetchXml(sitemaps[0]);
    const { subSitemaps, urls } = parseSitemapXml(xml);

    if (urls.length) {
      sampleUrls.push(...urls.slice(0, 30));
      log.push(`Sitemap has ${urls.length} direct URLs`);
    } else if (subSitemaps.length) {
      log.push(`Sitemap index with ${subSitemaps.length} sub-sitemaps — peeking into first one`);
      const peekPromises = subSitemaps.slice(0, 3).map(async s => {
        try {
          const subXml = await fetchXml(s, 15000);
          const { urls: subUrls } = parseSitemapXml(subXml);
          return subUrls;
        } catch { return []; }
      });
      const results = await Promise.race([
        Promise.all(peekPromises),
        new Promise(r => setTimeout(() => r([[]]), 18000)),
      ]);
      const subUrls = results.flat();
      if (subUrls.length) {
        sampleUrls.push(...subUrls.slice(0, 30));
        log.push(`Sampled ${subUrls.length} URLs from sub-sitemap(s)`);
      } else {
        log.push(`Sub-sitemaps timed out or empty — sitemap URL was still found above`);
      }
    }
  } catch (e) {
    log.push(`Sitemap read failed: ${e.message}`);
  }

  const patterns = detectPdpPatterns(sampleUrls, origin);
  res.json({ sitemaps, patterns, sampleUrls: sampleUrls.slice(0, 10), log });
});

// ── Detect likely PDP URL patterns from a sample of sitemap URLs ────────────
const PDP_KEYWORDS = new Set([
  'product', 'products', 'pdp', 'shop', 'buy', 'item', 'items',
  'p', 'en-us', 'en-gb', 'us', 'catalog',
]);

function detectPdpPatterns(urls, origin) {
  if (!urls.length) return [];

  const counts = {};
  for (const url of urls) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
        const key = '/' + parts.slice(0, depth).join('/') + '/';
        const boost = PDP_KEYWORDS.has(parts[depth - 1].toLowerCase()) ? 2 : 1;
        counts[key] = (counts[key] || 0) + boost;
      }
    } catch {}
  }

  const threshold = Math.max(2, urls.length * 0.2);
  const meaningful = Object.entries(counts)
    .filter(([, score]) => score >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([pattern, score]) => ({ pattern, score: Math.round(score) }));

  return meaningful;
}

// ── Probe: visit a sample PDP and discover gallery image groups ─────────────
app.post('/api/probe', async (req, res) => {
  const { url, useStealth } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let browser;
  try {
    browser = useStealth
      ? await chromiumStealth.launch({ headless: true })
      : await chromium.launch({ headless: true });

    const page = await browser.newPage();
    await setupPage(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await progressiveScroll(page);

    const rawImages = await extractAllImageSrcs(page, '');
    const groups = groupByHost(rawImages);

    res.json({ groups, usedStealth: !!useStealth });
  } catch (e) {
    if (!useStealth) {
      res.json({ retry: true, error: e.message });
    } else {
      res.status(500).json({ error: e.message });
    }
  } finally {
    await browser?.close();
  }
});

// ── Category-page crawler ────────────────────────────────────────────────────

const CAT_POSITIVE = new Set([
  'shop', 'products', 'product', 'catalog', 'collection', 'browse',
  'buy', 'store', 'explore', 'range', 'appliances', 'vacuum', 'blender', 'coffee',
]);
const CAT_NEGATIVE = new Set([
  'about', 'contact', 'support', 'faq', 'help', 'login', 'account',
  'cart', 'wishlist', 'blog', 'news', 'press', 'careers', 'accessibility',
  'privacy', 'terms', 'sitemap', 'search', 'register',
]);

const PDP_POSITIVE = new Set(['product', 'pdp', 'item', '/p/']);
const PDP_NEGATIVE = new Set([
  'category', 'collection', 'brand', 'search', 'filter', 'page', 'blog', 'faq', 'support',
]);

function scoreCategoryLink(href, origin) {
  let parsed;
  try { parsed = new URL(href, origin); } catch { return -Infinity; }
  if (parsed.origin !== origin) return -Infinity;
  if (!parsed.pathname || parsed.pathname === '/') return -Infinity;

  const segments = parsed.pathname.split('/').filter(Boolean);
  let score = 0;
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (CAT_POSITIVE.has(lower)) score += 3;
    if (CAT_NEGATIVE.has(lower)) score -= 5;
  }
  if (segments.length <= 2) score += 1;
  if (segments.length >= 4) score -= 1;
  return score;
}

function scorePdpLink(href, origin, categoryUrls = []) {
  let parsed;
  try { parsed = new URL(href, origin); } catch { return -Infinity; }
  if (parsed.origin !== origin) return -Infinity;

  const pathname = parsed.pathname.toLowerCase();
  let score = 0;

  for (const word of PDP_POSITIVE) {
    if (pathname.includes(word)) score += 3;
  }
  for (const word of PDP_NEGATIVE) {
    if (pathname.includes(word)) score -= 4;
  }

  // Product ID patterns
  if (/[-_]\w{2,10}\.html$/i.test(pathname)) score += 2;
  if (/\/\d{4,}$/.test(pathname)) score += 2;
  if (/\.html$/.test(pathname)) score += 2;

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && segments.length <= 4) score += 1;

  // Penalise category pages we already visited
  if (categoryUrls.includes(parsed.href) || categoryUrls.includes(href)) score -= 3;

  return score;
}

function collectSameOriginLinks(html, origin) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const abs = new URL(href, origin).href;
      if (new URL(abs).origin === origin) links.add(abs);
    } catch {}
  });
  return [...links];
}

async function crawlCategories({ url, useStealth, brandKey, brandName, streamId }) {
  let origin;
  try { origin = new URL(url).origin; } catch {
    emit(streamId, 'error', { message: 'Invalid URL' });
    return;
  }

  const progress = (pct, message) => emit(streamId, 'progress', { pct, message });

  progress(5, 'Loading homepage…');

  const browser = useStealth
    ? await chromiumStealth.launch({ headless: true })
    : await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await setupPage(page);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      emit(streamId, 'error', { message: `Failed to load homepage: ${e.message}` });
      return;
    }

    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const blockCheck = detectBlocked(await page.title(), page.url(), bodyText);
    if (blockCheck.blocked) {
      emit(streamId, 'error', { message: `Homepage blocked: ${blockCheck.reason}` });
      return;
    }

    await dismissCookieConsent(page);

    const homeHtml = await page.content();
    const homeLinks = collectSameOriginLinks(homeHtml, origin);

    progress(15, `Found ${homeLinks.length} nav links, scoring…`);

    // Score and filter links as category candidates
    const scored = homeLinks
      .map(href => ({ href, score: scoreCategoryLink(href, origin) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score);

    // Deduplicate by pathname
    const seen = new Set();
    const topLinks = [];
    for (const { href } of scored) {
      try {
        const pn = new URL(href).pathname;
        if (!seen.has(pn)) { seen.add(pn); topLinks.push(href); }
      } catch {}
      if (topLinks.length >= 8) break;
    }

    progress(20, 'Visiting category pages…');

    const allProductLinks = new Set();
    const limit = pLimit(2);
    let crawledCount = 0;

    await Promise.all(topLinks.map((catUrl, i) => limit(async () => {
      await new Promise(r => setTimeout(r, randJitter(1500)));
      try {
        const catPage = await browser.newPage();
        await setupPage(catPage);
        await catPage.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await dismissCookieConsent(catPage);
        await progressiveScroll(catPage);
        const catHtml = await catPage.content();
        await catPage.close();

        const links = collectSameOriginLinks(catHtml, origin);
        links.forEach(l => allProductLinks.add(l));

        crawledCount++;
        progress(
          20 + Math.round((crawledCount / topLinks.length) * 50),
          `Crawled category ${crawledCount}/${topLinks.length}, found ${allProductLinks.size} product URLs…`
        );
      } catch (e) {
        crawledCount++;
        console.warn(`Category page failed (${catUrl}): ${e.message}`);
      }
    })));

    // Score all collected links as PDPs
    const pdpScored = [...allProductLinks]
      .map(href => ({ href, score: scorePdpLink(href, origin, topLinks) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    // Deduplicate by pathname and take up to 500
    const pdpSeen = new Set();
    const finalUrls = [];
    for (const { href } of pdpScored) {
      try {
        const pn = new URL(href).pathname;
        if (!pdpSeen.has(pn)) { pdpSeen.add(pn); finalUrls.push(href); }
      } catch {}
      if (finalUrls.length >= 500) break;
    }

    progress(90, `Analyzing ${finalUrls.length} product URLs…`);

    const urlsDir = path.join(__dirname, 'data/urls');
    if (!fs.existsSync(urlsDir)) fs.mkdirSync(urlsDir, { recursive: true });

    const outPath = path.join(urlsDir, `${brandKey}_discovered.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      brand: brandKey,
      brandName,
      urls: finalUrls,
      discoveredAt: new Date().toISOString(),
      method: 'category-crawl',
    }, null, 2));

    emit(streamId, 'done', { count: finalUrls.length, method: 'category-crawl' });
  } finally {
    await browser.close();
  }
}

app.post('/api/crawl-categories', (req, res) => {
  const { url, useStealth = false, brandKey, brandName, streamId } = req.body;
  res.json({ ok: true });
  crawlCategories({ url, useStealth, brandKey, brandName, streamId }).catch(e =>
    emit(streamId, 'error', { message: e.message })
  );
});

// ── Web search bypass: Shopify API → WooCommerce sitemap → Browser Google ────

async function probeShopify(origin) {
  const found = [];
  let page = 1;
  while (found.length < 500) {
    try {
      const { data } = await axios.get(
        `${origin}/products.json?limit=250&page=${page}`,
        { timeout: 12000, headers: HEADERS }
      );
      if (!Array.isArray(data?.products) || !data.products.length) break;
      for (const p of data.products) {
        if (p.handle) found.push(`${origin}/products/${p.handle}`);
      }
      if (data.products.length < 250) break;
      page++;
    } catch {
      break;
    }
  }
  return found;
}

async function probeWooCommerce(origin) {
  // WooCommerce generates /wp-sitemap-posts-product-1.xml, -2.xml, …
  const found = [];
  for (let pg = 1; pg <= 5; pg++) {
    const sitemapUrl = `${origin}/wp-sitemap-posts-product-${pg}.xml`;
    try {
      const xml = await fetchXml(sitemapUrl, 10000);
      const { urls } = parseSitemapXml(xml);
      if (!urls.length) break;
      found.push(...urls);
    } catch {
      if (pg === 1) {
        // Also try /wp-sitemap.xml → find product sub-sitemaps in it
        try {
          const rootXml = await fetchXml(`${origin}/wp-sitemap.xml`, 10000);
          const { subSitemaps } = parseSitemapXml(rootXml);
          const productSitemaps = subSitemaps.filter(s => s.includes('product'));
          for (const s of productSitemaps.slice(0, 5)) {
            try {
              const sub = await fetchXml(s, 10000);
              found.push(...parseSitemapXml(sub).urls);
            } catch {}
          }
        } catch {}
      }
      break;
    }
  }
  return found;
}

async function browserGoogleSearch(domain, origin, useStealth, progress) {
  const browser = useStealth
    ? await chromiumStealth.launch({ headless: true })
    : await chromium.launch({ headless: true });

  const allLinks = new Set();

  try {
    const queries = [
      `site:${domain} product`,
      `site:${domain} "add to cart"`,
    ];

    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      // 3 SERP pages per query
      for (let pg = 0; pg < 3; pg++) {
        const searchUrl =
          `https://www.google.com/search?q=${encodeURIComponent(q)}&start=${pg * 10}&num=10`;
        try {
          const page = await browser.newPage();
          await setupPage(page);
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(randJitter(1200));

          const links = await page.evaluate((targetDomain) => {
            const anchors = [...document.querySelectorAll('a[href]')];
            return anchors
              .map(a => a.href)
              .filter(href => {
                try {
                  const h = new URL(href).hostname.replace(/^www\./, '');
                  return h === targetDomain;
                } catch { return false; }
              });
          }, domain);

          for (const l of links) allLinks.add(l);
          await page.close();

          progress(
            35 + Math.round(((qi * 3 + pg + 1) / (queries.length * 3)) * 45),
            `Google SERP page ${pg + 1}, query ${qi + 1}/${queries.length} — ${allLinks.size} links…`
          );

          if (links.length === 0) break; // no results on this page
        } catch (e) {
          console.warn(`Google search page failed: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  return [...allLinks];
}

function saveDiscoveredUrlsToFile(brandKey, brandName, urls, method) {
  const urlsDir = path.join(__dirname, 'data/urls');
  if (!fs.existsSync(urlsDir)) fs.mkdirSync(urlsDir, { recursive: true });
  const outPath = path.join(urlsDir, `${brandKey}_discovered.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    brand: brandKey,
    brandName,
    urls,
    discoveredAt: new Date().toISOString(),
    method,
  }, null, 2));
}

async function searchUrls({ url, useStealth = false, brandKey, brandName, streamId }) {
  const progress = (pct, message) => emit(streamId, 'progress', { pct, message });

  let domain, origin;
  try {
    const u = new URL(url);
    domain = u.hostname.replace(/^www\./, '');
    origin = u.origin;
  } catch {
    emit(streamId, 'error', { message: 'Invalid URL' });
    return;
  }

  // ── Strategy 1: Shopify /products.json API ─────────────────────────────────
  progress(5, `Probing Shopify API for ${domain}…`);
  const shopifyUrls = await probeShopify(origin);
  if (shopifyUrls.length) {
    const scored = dedupeUrls(shopifyUrls, origin, 500);
    progress(90, `Shopify API: found ${scored.length} products`);
    saveDiscoveredUrlsToFile(brandKey, brandName, scored, 'shopify-api');
    emit(streamId, 'done', { count: scored.length, method: 'shopify-api' });
    return;
  }
  progress(15, 'Not a Shopify store — trying WooCommerce…');

  // ── Strategy 2: WooCommerce product sitemaps ───────────────────────────────
  const wooUrls = await probeWooCommerce(origin);
  if (wooUrls.length) {
    const scored = dedupeUrls(wooUrls, origin, 500);
    progress(90, `WooCommerce sitemap: found ${scored.length} products`);
    saveDiscoveredUrlsToFile(brandKey, brandName, scored, 'woocommerce-sitemap');
    emit(streamId, 'done', { count: scored.length, method: 'woocommerce-sitemap' });
    return;
  }
  progress(25, 'No WooCommerce sitemaps — launching browser search…');

  // ── Strategy 3: Browser-based Google SERP ─────────────────────────────────
  const rawLinks = await browserGoogleSearch(domain, origin, useStealth, progress);
  const scored = dedupeUrls(rawLinks.filter(l => scorePdpLink(l, origin) > 0), origin, 200);

  if (scored.length) {
    progress(90, `Google search: found ${scored.length} product URLs`);
    saveDiscoveredUrlsToFile(brandKey, brandName, scored, 'search');
    emit(streamId, 'done', { count: scored.length, method: 'search' });
  } else {
    emit(streamId, 'done', {
      count: 0,
      method: 'search',
      warning: 'No product URLs found via any method. Try the Category Crawler instead.',
    });
  }
}

function dedupeUrls(urls, origin, max) {
  const seen = new Set();
  const out = [];
  for (const href of urls) {
    try {
      const pn = new URL(href).pathname;
      if (!seen.has(pn)) { seen.add(pn); out.push(href); }
    } catch {}
    if (out.length >= max) break;
  }
  return out;
}

app.post('/api/search-urls', (req, res) => {
  const { url, useStealth = false, brandKey, brandName, streamId } = req.body;
  res.json({ ok: true });
  searchUrls({ url, useStealth, brandKey, brandName, streamId }).catch(e =>
    emit(streamId, 'error', { message: e.message })
  );
});

// ── Add Brand pipeline ──────────────────────────────────────────────────────
app.post('/api/add-brand', (req, res) => {
  const config = req.body;
  const streamId = Date.now().toString();
  res.json({ streamId });
  runPipeline(config, streamId).catch(e => {
    console.error('Pipeline error:', e);
    emit(streamId, 'error', { message: e.message });
  });
});

async function runPipeline(config, streamId) {
  const {
    brandKey,
    brandName,
    sitemapUrl,
    pdpFilter,
    imageHost,
    sampleSize = 50,
    useStealth = false,
    customUrls,
  } = config;

  let unique = [];

  // ─ Step 1: resolve URL list ─
  if (customUrls && customUrls.length > 0) {
    // Use pre-discovered URLs directly — skip sitemap entirely
    unique = [...new Set(customUrls)];
    emit(streamId, 'progress', {
      step: 'crawl',
      message: `Using ${unique.length} pre-discovered product URLs`,
      pct: 22,
    });
  } else {
    // Try sitemap if provided, otherwise fall back to saved discovered file
    let resolvedSitemapUrl = sitemapUrl;

    if (!resolvedSitemapUrl) {
      const discoveredPath = path.join(__dirname, 'data/urls', `${brandKey}_discovered.json`);
      if (fs.existsSync(discoveredPath)) {
        try {
          const saved = JSON.parse(fs.readFileSync(discoveredPath, 'utf8'));
          if (Array.isArray(saved.urls) && saved.urls.length > 0) {
            unique = [...new Set(saved.urls)];
            emit(streamId, 'progress', {
              step: 'crawl',
              message: `Loaded ${unique.length} URLs from previous discovery`,
              pct: 22,
            });
          }
        } catch (e) {
          console.warn(`Could not read discovered URLs: ${e.message}`);
        }
      }
    }

    if (!unique.length && resolvedSitemapUrl) {
      emit(streamId, 'progress', { step: 'crawl', message: 'Crawling sitemap…', pct: 5 });

      const allUrls = [];
      const queue = [resolvedSitemapUrl];
      const visited = new Set();
      const filterFn = pdpFilter ? u => u.includes(pdpFilter) : () => true;
      let subSitemapCount = 0;

      while (queue.length) {
        const next = queue.shift();
        if (visited.has(next) || visited.size > 200) continue;
        visited.add(next);

        try {
          const xml = await fetchXml(next);
          const { subSitemaps, urls } = parseSitemapXml(xml);
          subSitemaps.forEach(s => queue.push(s));
          subSitemapCount += subSitemaps.length;
          urls.filter(filterFn).forEach(u => allUrls.push(u));

          emit(streamId, 'progress', {
            step: 'crawl',
            message: `Scanning sitemaps… ${allUrls.length} product URLs found`,
            pct: 5 + Math.min(15, subSitemapCount),
          });
        } catch (e) {
          console.warn(`Skipped ${next}: ${e.message}`);
        }
      }

      unique = [...new Set(allUrls)];
      emit(streamId, 'progress', { step: 'crawl', message: `Found ${unique.length} product URLs`, pct: 22 });
    }

    if (!unique.length) {
      emit(streamId, 'error', { message: 'No product URLs found. Check the sitemap URL, PDP filter, or run a discovery first.' });
      return;
    }
  }

  const sampled = unique.length > sampleSize
    ? [...unique].sort(() => Math.random() - 0.5).slice(0, sampleSize)
    : unique;

  emit(streamId, 'progress', {
    step: 'crawl',
    message: `Processing ${sampled.length} PDPs${unique.length > sampleSize ? ` (sampled from ${unique.length})` : ''}`,
    pct: 25,
  });

  // ─ Step 2: extract galleries ─
  const results = [];
  let done = 0;
  let failures = 0;
  let totalImages = 0;
  const limit = pLimit(3);

  const needsBrowser = brandKey !== 'sharkninja';
  const stdBrowser     = needsBrowser ? await chromium.launch({ headless: true }) : null;
  const stealthBrowser = needsBrowser ? await chromiumStealth.launch({ headless: true }) : null;

  await Promise.all(sampled.map(url => limit(async () => {
    const result = await extractOnePdp(url, brandKey, brandName, imageHost, stdBrowser, stealthBrowser, useStealth);
    results.push(result);
    if (result.error) failures++;
    totalImages += result.galleryImageCount || 0;

    done++;
    emit(streamId, 'progress', {
      step: 'extract',
      message: `Extracting galleries… ${done} / ${sampled.length}${failures ? ` (${failures} errors)` : ''}`,
      pct: 25 + Math.round((done / sampled.length) * 62),
      done,
      total: sampled.length,
      errors: failures,
      images: totalImages,
    });
  })));

  await stdBrowser?.close();
  await stealthBrowser?.close();

  // ─ Step 3: merge ─
  emit(streamId, 'progress', { step: 'merge', message: 'Merging into dataset…', pct: 90 });
  const rawPath = path.join(__dirname, 'data/gallery_raw.json');
  const existing = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const merged = [...existing.filter(p => p.brand !== brandKey), ...results];
  fs.writeFileSync(rawPath, JSON.stringify(merged, null, 2));

  saveBrandConfig(brandKey, { brandName, imageHost: imageHost || '', useStealth: !!useStealth });

  const successCount = results.filter(r => !r.error).length;
  emit(streamId, 'done', { added: results.length, successCount, failures, total: merged.length, brandName });
  console.log(`Done — ${brandName}: ${successCount} succeeded, ${failures} failed. Total dataset: ${merged.length}`);
}

// ── SharkNinja: pull gallery via Cloudinary list API (no browser needed) ─────
async function extractSharkNinjaViaCloudinary(url, brandName) {
  const pathParts = new URL(url).pathname.split('/').filter(Boolean);
  const base = {
    brand: 'sharkninja',
    brandName,
    url,
    family: pathParts[0] || 'unknown',
    category: pathParts[1] || pathParts[0] || 'unknown',
  };

  // Product ID is the last path segment without .html
  const productId = pathParts[pathParts.length - 1].replace(/\.html$/i, '');
  const apiUrl = `https://sharkninja-sfcc-prod-res.cloudinary.com/image/list/${productId}.json`;

  try {
    const { data } = await axios.get(apiUrl, { timeout: 15000, headers: HEADERS });
    const images = (data.resources || []).map((r, i) => {
      const viewType = r.metadata?.find(m => m.external_id === 'sfcc-view-type')?.value || '';
      return {
        src: `https://sharkninja-sfcc-prod-res.cloudinary.com/image/upload/f_auto,q_auto,w_800/${r.public_id}`,
        alt: r.context?.custom?.alt || '',
        width: r.width,
        height: r.height,
        viewType,
        sequencePosition: i + 1,
      };
    });
    return { ...base, galleryImageCount: images.length, images, extractedAt: new Date().toISOString() };
  } catch (e) {
    return { ...base, images: [], galleryImageCount: 0, error: e.message, extractedAt: new Date().toISOString() };
  }
}

// ── Extract one PDP: standard browser first, stealth retry on error ─────────
async function extractOnePdp(url, brandKey, brandName, imageHost, stdBrowser, stealthBrowser, preferStealth) {
  // SharkNinja uses Cloudinary API — no browser needed
  if (brandKey === 'sharkninja') {
    return extractSharkNinjaViaCloudinary(url, brandName);
  }

  const pathParts = new URL(url).pathname.split('/').filter(Boolean);
  const base = {
    brand: brandKey,
    brandName,
    url,
    family: pathParts[0] || 'unknown',
    category: pathParts[1] || pathParts[0] || 'unknown',
  };

  for (const [attempt, browser] of [[1, preferStealth ? stealthBrowser : stdBrowser], [2, stealthBrowser]]) {
    try {
      const page = await browser.newPage();
      await setupPage(page);

      const waitUntil = attempt === 2 ? 'networkidle' : 'domcontentloaded';
      const extraWait = attempt === 2 ? 4000 : 2000;

      try {
        await page.goto(url, { waitUntil, timeout: 45000 });
      } catch {
        await page.waitForTimeout(extraWait);
      }

      // Block detection after page load
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const blockResult = detectBlocked(await page.title(), page.url(), bodyText);

      if (blockResult.blocked) {
        await page.close();
        // On attempt 1: skip straight to stealth but mark it; on attempt 2: return blocked result
        if (attempt === 2) {
          return {
            ...base,
            images: [],
            galleryImageCount: 0,
            blocked: true,
            blockReason: blockResult.reason,
            extractedAt: new Date().toISOString(),
          };
        }
        // Let the loop continue to attempt 2
        continue;
      }

      await progressiveScroll(page, extraWait);
      const images = await extractAllImageSrcs(page, imageHost || '');
      await page.close();

      return {
        ...base,
        galleryImageCount: images.length,
        images: images.map((img, i) => ({ ...img, sequencePosition: i + 1 })),
        extractedAt: new Date().toISOString(),
        usedStealth: browser === stealthBrowser,
      };
    } catch (e) {
      if (attempt === 2) {
        return { ...base, images: [], galleryImageCount: 0, error: e.message, extractedAt: new Date().toISOString() };
      }
      // Will retry with stealth on next iteration
    }
  }
}

// ── Progressive scroll: step through page to trigger lazy-loading ────────────
async function progressiveScroll(page, baseWait = 2000) {
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    const steps = Math.min(8, Math.ceil(h / 400));
    for (let i = 1; i <= steps; i++) {
      window.scrollTo(0, (h * i) / steps);
      await new Promise(r => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 400));
  });
  await page.waitForTimeout(Math.max(500, baseWait - 2000));
}

// ── Extract all gallery-candidate image URLs from the page ──────────────────
// Reads: img[src], img[data-src/*], srcset, picture>source, background-image inline styles
async function extractAllImageSrcs(page, imageHost) {
  return page.evaluate((host) => {
    const seen = new Set();
    const results = [];

    function add(src, meta = {}) {
      if (!src || src.startsWith('data:') || seen.has(src)) return;
      if (host && !src.includes(host)) return;
      seen.add(src);
      results.push({ src, alt: meta.alt || '', width: meta.width || 0, height: meta.height || 0 });
    }

    function bestFromSrcset(srcset) {
      if (!srcset) return null;
      const parts = srcset.split(',').map(s => s.trim().split(/\s+/));
      parts.sort((a, b) => parseInt(b[1] || 0) - parseInt(a[1] || 0));
      return parts[0]?.[0] || null;
    }

    // img tags
    document.querySelectorAll('img').forEach(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const meta = { alt: img.alt || '', width: w, height: h };

      const candidates = [
        img.currentSrc,
        img.src,
        img.dataset?.src,
        img.dataset?.lazySrc,
        img.dataset?.original,
        img.dataset?.fullImage,
        img.dataset?.zoomImage,
        img.getAttribute('data-lazy-src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-zoom-image'),
        img.getAttribute('data-hi-res-src'),
        bestFromSrcset(img.getAttribute('srcset')),
        bestFromSrcset(img.getAttribute('data-srcset')),
      ];

      for (const src of candidates) { if (src) { add(src, meta); break; } }
    });

    // picture > source (responsive images)
    document.querySelectorAll('picture source').forEach(el => {
      const src = bestFromSrcset(el.getAttribute('srcset') || el.getAttribute('data-srcset'));
      if (src) add(src);
    });

    return results.filter(img => !img.width || img.width >= (host ? 150 : 300));
  }, imageHost);
}

// ── Group images by CDN hostname ─────────────────────────────────────────────
function groupByHost(images) {
  const groups = {};
  for (const img of images) {
    try {
      const host = new URL(img.src).hostname;
      if (!groups[host]) groups[host] = { host, images: [] };
      groups[host].images.push(img);
    } catch {}
  }
  return Object.values(groups)
    .sort((a, b) => b.images.length - a.images.length)
    .slice(0, 6)
    .map(g => ({
      host: g.host,
      count: g.images.length,
      previews: g.images.slice(0, 5).map(i => ({ src: i.src, w: i.width, h: i.height })),
    }));
}

// ── Brand config persistence (imageHost, useStealth per brand) ───────────────
function loadBrandConfigs() {
  const p = path.join(__dirname, 'data/brand_configs.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}
function saveBrandConfig(brandKey, update) {
  const p = path.join(__dirname, 'data/brand_configs.json');
  const configs = loadBrandConfigs();
  configs[brandKey] = { ...configs[brandKey], ...update };
  fs.writeFileSync(p, JSON.stringify(configs, null, 2));
}

// ── Remove Brand ─────────────────────────────────────────────────────────────
app.delete('/api/brands/:key', (req, res) => {
  const rawPath = path.join(__dirname, 'data/gallery_raw.json');
  const existing = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const filtered = existing.filter(p => p.brand !== req.params.key);
  if (filtered.length === existing.length) return res.status(404).json({ error: 'Brand not found' });
  fs.writeFileSync(rawPath, JSON.stringify(filtered, null, 2));
  res.json({ removed: existing.length - filtered.length, total: filtered.length });
});

// ── Weekly refresh: re-extract all brands and diff against previous data ──────

async function reExtractBrand(brandKey, brandName, urls, imageHost, useStealth, onProgress) {
  const limit = pLimit(3);
  const results = [];
  let done = 0;

  if (brandKey === 'sharkninja') {
    await Promise.all(urls.map(url => limit(async () => {
      results.push(await extractSharkNinjaViaCloudinary(url, brandName));
      onProgress?.(++done, urls.length);
    })));
    return results;
  }

  const stdBrowser = await chromium.launch({ headless: true });
  const stealthBrowser = await chromiumStealth.launch({ headless: true });
  try {
    await Promise.all(urls.map(url => limit(async () => {
      results.push(await extractOnePdp(url, brandKey, brandName, imageHost, stdBrowser, stealthBrowser, useStealth));
      onProgress?.(++done, urls.length);
    })));
  } finally {
    await stdBrowser.close();
    await stealthBrowser.close();
  }
  return results;
}

function diffBrand(brandKey, previousByUrl, newResults) {
  const diff = {
    added: 0, removed: 0, changed: 0, unchanged: 0, errors: 0,
    details: { added: [], removed: [], changed: [] },
  };
  const newByUrl = new Map(newResults.map(p => [p.url, p]));

  for (const [url, p] of newByUrl) {
    if (p.error || p.blocked) { diff.errors++; continue; }
    const prev = previousByUrl.get(url);
    if (!prev) {
      diff.added++;
      diff.details.added.push({ url, count: p.galleryImageCount });
    } else if (prev.galleryImageCount !== p.galleryImageCount) {
      diff.changed++;
      diff.details.changed.push({
        url, prevCount: prev.galleryImageCount,
        newCount: p.galleryImageCount,
        delta: p.galleryImageCount - prev.galleryImageCount,
      });
    } else {
      diff.unchanged++;
    }
  }

  for (const [url, prev] of previousByUrl) {
    if (prev.brand === brandKey && !newByUrl.has(url)) {
      diff.removed++;
      diff.details.removed.push({ url, prevCount: prev.galleryImageCount });
    }
  }
  return diff;
}

function computeNextRun(cronExpression) {
  const parts = cronExpression.split(' ');
  if (parts.length !== 5) return null;
  const minute  = parseInt(parts[0]);
  const hour    = parseInt(parts[1]);
  const weekday = parseInt(parts[4]);
  if ([minute, hour, weekday].some(isNaN)) return null;

  const now = new Date();
  let daysUntil = (weekday - now.getDay() + 7) % 7;
  if (daysUntil === 0) {
    const passedToday = now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
    if (passedToday) daysUntil = 7;
  }
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntil);
  next.setHours(hour, minute, 0, 0);
  return next.toISOString();
}

async function runFullRefresh(streamId = null) {
  const rawPath     = path.join(__dirname, 'data/gallery_raw.json');
  const historyPath = path.join(__dirname, 'data/refresh_history.json');
  const configPath  = path.join(__dirname, 'data/refresh_config.json');

  const log = (msg) => {
    if (streamId) emit(streamId, 'log', { message: msg });
    console.log(`[Refresh] ${msg}`);
  };
  const progress = (pct, message, extra = {}) => {
    if (streamId) emit(streamId, 'progress', { pct, message, ...extra });
  };

  if (!fs.existsSync(rawPath)) {
    emit(streamId, 'error', { message: 'No dataset found — run an initial brand crawl first.' });
    return null;
  }

  const previousData  = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const previousByUrl = new Map(previousData.map(p => [p.url, p]));

  const brandMap = {};
  previousData.forEach(p => {
    if (!brandMap[p.brand]) brandMap[p.brand] = { brandKey: p.brand, brandName: p.brandName, urls: new Set() };
    brandMap[p.brand].urls.add(p.url);
  });

  const brandConfigs = loadBrandConfigs();
  const brands = Object.values(brandMap).map(b => ({
    ...b,
    urls: [...b.urls],
    imageHost:  brandConfigs[b.brandKey]?.imageHost  || '',
    useStealth: brandConfigs[b.brandKey]?.useStealth || false,
  }));

  const refreshRecord = {
    id: Date.now().toString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    brands: {},
    totals: { added: 0, removed: 0, changed: 0, unchanged: 0, errors: 0 },
  };

  const allNewResults = [];

  for (let i = 0; i < brands.length; i++) {
    const { brandKey, brandName, urls, imageHost, useStealth } = brands[i];
    const pctBase = Math.round((i / brands.length) * 84);
    log(`Starting ${brandName} — ${urls.length} PDPs`);
    progress(5 + pctBase, `Refreshing ${brandName} — ${urls.length} PDPs…`);

    try {
      const brandResults = await reExtractBrand(brandKey, brandName, urls, imageHost, useStealth, (done, total) => {
        const inner = Math.round((done / total) * (84 / brands.length));
        progress(5 + pctBase + inner, `${brandName}: ${done} / ${total}`, { brand: brandKey, done, total });
      });

      allNewResults.push(...brandResults);
      const diff = diffBrand(brandKey, previousByUrl, brandResults);
      refreshRecord.brands[brandKey] = { brandName, ...diff };
      refreshRecord.totals.added     += diff.added;
      refreshRecord.totals.removed   += diff.removed;
      refreshRecord.totals.changed   += diff.changed;
      refreshRecord.totals.unchanged += diff.unchanged;
      refreshRecord.totals.errors    += diff.errors;
      log(`${brandName}: +${diff.added} new · ${diff.changed} updated · ${diff.removed} removed`);
    } catch (e) {
      log(`${brandName} FAILED: ${e.message}`);
      allNewResults.push(...previousData.filter(p => p.brand === brandKey));
    }
  }

  progress(93, 'Saving updated dataset…');
  fs.writeFileSync(rawPath, JSON.stringify(allNewResults, null, 2));

  refreshRecord.completedAt = new Date().toISOString();

  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : [];
  history.unshift(refreshRecord);
  fs.writeFileSync(historyPath, JSON.stringify(history.slice(0, 52), null, 2));

  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { enabled: true, schedule: '0 2 * * 0' };
  config.lastRun = refreshRecord.completedAt;
  config.nextRun = computeNextRun(config.schedule);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const t = refreshRecord.totals;
  progress(100, `Done — ${t.added} new · ${t.changed} updated · ${t.removed} removed`);
  if (streamId) emit(streamId, 'done', { record: refreshRecord });
  console.log(`[Refresh] Complete — added:${t.added} changed:${t.changed} removed:${t.removed}`);
  return refreshRecord;
}

// ── Cron management ───────────────────────────────────────────────────────────
let cronTask = null;

function startCronSchedule(cronExpression) {
  cronTask?.stop();
  cronTask = null;
  if (!cron.validate(cronExpression)) { console.warn(`[Refresh] Invalid cron: ${cronExpression}`); return; }
  cronTask = cron.schedule(cronExpression, () => {
    console.log('[Refresh] Weekly scheduled refresh starting…');
    runFullRefresh().catch(e => console.error('[Refresh] Scheduled refresh failed:', e));
  });
  console.log(`[Refresh] Schedule active: ${cronExpression}`);
}

// ── Refresh endpoints ─────────────────────────────────────────────────────────
app.get('/api/refresh/status', (req, res) => {
  const configPath  = path.join(__dirname, 'data/refresh_config.json');
  const historyPath = path.join(__dirname, 'data/refresh_history.json');
  const config  = fs.existsSync(configPath)  ? JSON.parse(fs.readFileSync(configPath,  'utf8')) : { enabled: true, schedule: '0 2 * * 0' };
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : [];
  res.json({
    enabled:       config.enabled !== false,
    schedule:      config.schedule || '0 2 * * 0',
    lastRun:       config.lastRun  || null,
    nextRun:       config.nextRun  || computeNextRun(config.schedule || '0 2 * * 0'),
    recentHistory: history.slice(0, 8),
  });
});

app.post('/api/refresh/trigger', (req, res) => {
  const streamId = Date.now().toString();
  res.json({ streamId });
  runFullRefresh(streamId).catch(e => {
    console.error('[Refresh] Manual trigger failed:', e);
    emit(streamId, 'error', { message: e.message });
  });
});

app.post('/api/refresh/config', (req, res) => {
  const { enabled, schedule } = req.body;
  const configPath = path.join(__dirname, 'data/refresh_config.json');
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { schedule: '0 2 * * 0' };
  const updated = { ...existing };
  if (typeof enabled === 'boolean') updated.enabled = enabled;
  if (schedule && cron.validate(schedule)) { updated.schedule = schedule; }
  updated.nextRun = computeNextRun(updated.schedule);
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
  if (updated.enabled !== false) startCronSchedule(updated.schedule);
  else { cronTask?.stop(); cronTask = null; }
  res.json({ ok: true, ...updated });
});

// ── Initialize schedule on startup ────────────────────────────────────────────
{
  const configPath = path.join(__dirname, 'data/refresh_config.json');
  if (!fs.existsSync(configPath)) {
    const defaultCfg = { enabled: true, schedule: '0 2 * * 0', nextRun: computeNextRun('0 2 * * 0') };
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultCfg, null, 2));
  }
  const initCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (initCfg.enabled !== false) startCronSchedule(initCfg.schedule || '0 2 * * 0');
}

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`\nGallery Audit server  ->  http://localhost:${PORT}/viewer.html\n`);
});
