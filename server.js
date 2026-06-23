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
import Anthropic from '@anthropic-ai/sdk';
import { crawlBrand } from './1_crawl_sitemaps.js';
import { BRANDS as SITEMAP_BRAND_CONFIG } from './config.js';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

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
const streamBuffers = new Map(); // replay buffer so late-connecting clients don't miss early messages

function emit(id, type, data) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  if (!streamBuffers.has(id)) streamBuffers.set(id, []);
  streamBuffers.get(id).push(msg);
  const res = streams.get(id);
  if (res) res.write(msg);
}

app.get('/api/stream/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent Render/nginx proxy buffering
  res.flushHeaders();
  streams.set(req.params.id, res);
  // Replay any messages that fired before the client connected
  (streamBuffers.get(req.params.id) || []).forEach(msg => res.write(msg));
  req.on('close', () => {
    streams.delete(req.params.id);
    streamBuffers.delete(req.params.id);
  });
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
      const hint = resolvedSitemapUrl
        ? `Sitemap at ${resolvedSitemapUrl} returned no URLs matching the filter "${pdpFilter || '(none)'}". Try removing the PDP filter or entering a different sitemap URL.`
        : 'No sitemap URL was provided and no bypass URLs were found. Use the discovery panel or enter a sitemap URL manually.';
      emit(streamId, 'error', { message: hint });
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
  // Sequential + single stealth browser to fit Render 512MB web tier. Prior version ran
  // pLimit(3) + two browsers (chromium + chromiumStealth) ≈ 650MB peak — OOM-killed the
  // web service on Add Brand with 50+ PDPs. Same fix already applied to reExtractBrand
  // (cron path) — stealth is a superset of std chromium so we drop the second browser.
  // Trade-off: ~3x slower than concurrent, but the 5s heartbeat below keeps the modal alive.
  const results = [];
  const startedAt = Date.now();
  let started = 0;
  let done = 0;
  let failures = 0;
  let totalImages = 0;

  const needsBrowser = brandKey !== 'sharkninja';
  const browser = needsBrowser ? await chromiumStealth.launch({ headless: true }) : null;

  // Heartbeat: ticks every 5s so the modal doesn't look frozen during a slow PDP
  // (a single page load + scroll + extract can take 15-30s).
  const heartbeat = setInterval(() => {
    const inFlight = started - done;
    const elapsed  = Math.round((Date.now() - startedAt) / 1000);
    emit(streamId, 'progress', {
      step:     'extract',
      message:  `Extracting… ${done} done · ${inFlight} in flight · ${sampled.length - started} pending · ${elapsed}s elapsed${failures ? ` · ${failures} errors` : ''}`,
      pct:      25 + Math.round((done / sampled.length) * 62),
      done, started, total: sampled.length, errors: failures, images: totalImages, elapsedSec: elapsed,
    });
  }, 5000);

  try {
    for (const url of sampled) {
      started++;
      const skuLabel = url.split('/').filter(Boolean).pop() || url;
      emit(streamId, 'progress', {
        step:    'extract',
        message: `Starting ${started} / ${sampled.length} — ${skuLabel}`,
        pct:     25 + Math.round((done / sampled.length) * 62),
        done, started, total: sampled.length, errors: failures, images: totalImages,
      });

      // Pass the same browser as both std + stealth args — extractOnePdp's retry path
      // varies waitUntil/extraWait, not browser type. Identical pattern to reExtractBrand.
      const result = await extractOnePdp(url, brandKey, brandName, imageHost, browser, browser, useStealth);
      results.push(result);
      if (result.error) failures++;
      totalImages += result.galleryImageCount || 0;

      done++;
      emit(streamId, 'progress', {
        step:    'extract',
        message: `Done ${done} / ${sampled.length}${failures ? ` (${failures} errors)` : ''} — ${skuLabel}`,
        pct:     25 + Math.round((done / sampled.length) * 62),
        done, started, total: sampled.length, errors: failures, images: totalImages,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }

  await browser?.close();

  // ─ Step 3: merge ─
  emit(streamId, 'progress', { step: 'merge', message: 'Merging into dataset…', pct: 90 });
  const rawPath = path.join(__dirname, 'data/gallery_raw.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(rawPath, 'utf8')); } catch {}
  const merged = [...existing.filter(p => p.brand !== brandKey), ...results];
  fs.writeFileSync(rawPath, JSON.stringify(merged, null, 2));

  saveBrandConfig(brandKey, { brandName, imageHost: imageHost || '', useStealth: !!useStealth });

  const successCount = results.filter(r => !r.error).length;
  emit(streamId, 'done', { added: results.length, successCount, failures, total: merged.length, brandName });
  console.log(`Done — ${brandName}: ${successCount} succeeded, ${failures} failed. Total dataset: ${merged.length}`);
}

// ── SharkNinja: pull gallery via Cloudinary list API (no browser needed) ─────
// SharkNinja PDP template (as of 2026-06) organizes product imagery into labeled section
// folders, not a single gallery carousel. The legacy Cloudinary list-by-SKU API only
// returns the "01_Gallery" tag, which is now sparse or empty on most SKUs while the real
// creative lives in /02_Highlights/, /03_5050_*/, /04_Carousel_*/, /05_ProductOwners/.
// This hybrid extractor scrapes the live PDP and captures all storefront/products/<SKU>/
// images across every section folder, deduped by storefront-relative base path.
//
// Step 1: static HTML fetch with Cheerio (fast, no browser).
// Step 2: if Cheerio finds <3 distinct storefront images, fall back to Playwright on the
//         rendered DOM. The fallback should be rare — FO101 alone yields 13 from static HTML.

// Normalize a section folder name → viewType tag the audit prompt understands.
// Two folder-naming conventions in the wild:
//   underscore-separated:  "01_Gallery", "03_5050_LargeCapacity", "05_ProductOwners"
//   hyphen-separated:      "4-Highlights-Froth", "8-5050-ProductOwners", "0-HeroImages"
function viewTypeFromSection(sectionFolder) {
  // Accept either underscore or hyphen after the leading digit prefix.
  const m = String(sectionFolder || '').match(/^\d+[_-]([^/_-]+)/);
  if (!m) return 'other';
  const raw = m[1].toLowerCase();
  if (raw === 'gallery')        return 'gallery';
  if (raw === 'heroimages')     return 'gallery';
  if (raw === 'hero')           return 'gallery';
  if (raw === 'highlights')     return 'highlights';
  if (raw === '5050')           return '5050';
  if (raw === 'carousel')       return 'carousel';
  if (raw === 'productowners')  return 'proof';
  return raw;
}

// Variant-tolerant SKU stem extraction. The URL slug includes variant suffixes that
// the image library does NOT use as folder names:
//   AE1001-MASTER.html  →  asset folder is "PDP-AE1001"   (drop "-MASTER")
//   AE1001C.html        →  asset folder is "PDP-AE1001"   (drop "C" colorway letter)
//   FA022C-MASTER.html  →  asset folder is "FA022"        (drop both)
// Strategy: extract leading "<letters><digits>" stem; keep original too for explicit
// matches against variant-specific folders that DO exist.
function skuMatchCandidates(rawSku) {
  const upper = String(rawSku).toUpperCase();
  const candidates = new Set([upper]);
  const stemMatch = upper.match(/^([A-Z]+\d+)/);
  if (stemMatch) candidates.add(stemMatch[1]);
  return [...candidates];
}

// SharkNinja images come in TWO URL patterns depending on PDP template version:
//
//   Old template (e.g. AF141, AMC14): flat numbered files
//     https://assets.sharkninja.com/image/upload/<xforms>/SharkNinja-NA/AF141_01.jpg
//     → viewType: "gallery" (this IS the carousel; no section folders)
//
//   New template (e.g. FO101): section-folder layout
//     https://assets.sharkninja.com/image/upload/<xforms>/v1/storefront/products/<SKU>/Desktop/<NN_Section>/<file>
//     → viewType: derived from section folder (highlights, 5050, carousel, proof)
//
// Both patterns appear on both hosts (assets.sharkninja.com is the primary; the legacy
// sharkninja-sfcc-prod-res.cloudinary.com still resolves for some files).
//
// Dedup keys differ per pattern: new template dedups by the storefront path; old template
// dedups by "<SKU>_<NN>" so different transform variants of AF141_01.jpg collapse to one.
function parseStorefrontImagesFromHtml(html, sku) {
  const candidates = skuMatchCandidates(sku);
  // Pre-compute O→0 normalized variants for each candidate (SN's image folders have
  // inconsistent letter-O / digit-0 spellings).
  const candidatesNormalized = candidates.map(c => c.replace(/O/g, '0').replace(/[^A-Z0-9]/g, ''));
  const skuStem = candidates[candidates.length - 1]; // longest is the stripped stem
  const dirMatches = (dirRaw) => {
    const dir = (dirRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const dirN = dir.replace(/O/g, '0');
    return candidatesNormalized.some(c => dirN === c || dir.startsWith(c) || c.startsWith(dir));
  };

  const HOST_GROUP = `(?:assets\\.sharkninja\\.com|sharkninja-sfcc-prod-res\\.cloudinary\\.com)`;

  // Pattern A: storefront/products/<SKU>/Desktop/<NN_Section>/<file>
  const patternA = new RegExp(
    `https://${HOST_GROUP}/image/upload/[^"'\\s]*?/v\\d+/(storefront/products/([A-Z0-9]+)/Desktop/(\\d+_[^/]+)/[^"'\\s?<>]+)`,
    'gi'
  );

  // Pattern B: /SharkNinja-NA/<SKU>_<NN>.(ext) — old flat-numbered template
  const patternB = new RegExp(
    `https://${HOST_GROUP}/image/upload/[^"'\\s]*?/SharkNinja-NA/(${skuStem}(?:[_-][A-Z0-9]+)*)\\.(?:jpg|jpeg|png|webp|gif)`,
    'gi'
  );

  // Pattern C (newest template, mid-2026): /v\d+/<global_path>/PDP-<SKU>/<region>/<NN-Section>/<file>
  // Section folder uses hyphens (e.g. "4-Highlights-Froth", "8-5050-ProductOwners").
  // URL-encoded spaces (%20) appear in the global_path segment — character class allows them.
  const patternC = new RegExp(
    `https://${HOST_GROUP}/image/upload/[^"'\\s]*?/v\\d+/([A-Za-z0-9%/_.-]+?/PDP-([A-Z0-9]+)/[^/]+/(\\d+-[^/]+)/[^"'\\s?<>]+)`,
    'gi'
  );

  const seen = new Map();
  const sanitizeUrl = u => u.replace(/[&"'<>].*$/, '').replace(/\?_i=.*$/, '');

  // ─ Pattern A ─
  let m;
  while ((m = patternA.exec(html)) !== null) {
    const dirSku = m[2] || '';
    if (!dirMatches(dirSku)) continue;
    const dedupKey = m[1];
    if (seen.has(dedupKey)) continue;
    seen.set(dedupKey, {
      src:           sanitizeUrl(m[0]),
      sectionFolder: m[3],
      viewType:      viewTypeFromSection(m[3]),
    });
  }

  // ─ Pattern B ─
  while ((m = patternB.exec(html)) !== null) {
    const baseName = (m[1] || '').toUpperCase();
    const seqMatch = baseName.match(new RegExp(`^${skuStem}_(\\d+)`, 'i'));
    if (!seqMatch) continue;
    const dedupKey = `${skuStem}_${seqMatch[1]}`;
    if (seen.has(dedupKey)) continue;
    seen.set(dedupKey, {
      src:           sanitizeUrl(m[0]),
      sectionFolder: '01_Gallery',
      viewType:      'gallery',
    });
  }

  // ─ Pattern C ─
  // Dedup by the captured path (group 1) so transform variants of the same file collapse.
  while ((m = patternC.exec(html)) !== null) {
    const dirSku = m[2] || '';
    if (!dirMatches(dirSku)) continue;
    const dedupKey = m[1];
    if (seen.has(dedupKey)) continue;
    seen.set(dedupKey, {
      src:           sanitizeUrl(m[0]),
      sectionFolder: m[3],
      viewType:      viewTypeFromSection(m[3]),
    });
  }

  return Array.from(seen.values()).map((img, i) => ({ ...img, sequencePosition: i + 1 }));
}

// Cloudinary list-by-tag — the old extractor's source. Still authoritative for
// OLD-template PDPs whose carousel hydrates client-side: the HTML only renders 1-2
// visible thumbnails, but the API returns the complete tagged set (e.g. AF141 → 8).
// On NEW-template PDPs the same API typically returns just 1 hero (still useful to merge).
async function fetchSharkNinjaListApi(sku) {
  try {
    const { data } = await axios.get(
      `https://sharkninja-sfcc-prod-res.cloudinary.com/image/list/${sku.toLowerCase()}.json`,
      { timeout: 15000, headers: HEADERS }
    );
    return (data.resources || []).map(r => ({
      src:           `https://assets.sharkninja.com/image/upload/f_auto,q_auto,w_1200/${r.public_id}`,
      sectionFolder: '01_Gallery',
      viewType:      'gallery',
      // Dedup key for old-template assets is the filename stem (e.g. "AF141_01"),
      // which the list API exposes as the trailing segment of public_id.
      _dedupKey:     (r.public_id.split('/').pop() || '').toUpperCase(),
    }));
  } catch {
    return [];
  }
}

export async function extractSharkNinjaHybrid(url, brandName, browser) {
  const pathParts = new URL(url).pathname.split('/').filter(Boolean);
  const lastSeg   = pathParts[pathParts.length - 1] || '';
  const sku       = lastSeg.replace(/\.html$/i, '').toUpperCase();
  const family    = pathParts.length > 1 ? pathParts[pathParts.length - 2] : pathParts[0] || 'unknown';
  const category  = pathParts.length > 2 ? pathParts[pathParts.length - 3] : family;
  const base = { brand: 'sharkninja', brandName, url, sku, family, category };

  // ─ Source A: legacy Cloudinary list API (gives full gallery on old-template PDPs) ─
  // Runs in parallel with the HTML fetch — both are independent network calls.
  const apiPromise = fetchSharkNinjaListApi(sku);

  // ─ Source B: HTML parsing — static Cheerio first, Playwright fallback ─
  let htmlImages = [];
  let extractorPath = 'cheerio';
  try {
    const { data: html } = await axios.get(url, { timeout: 20000, maxRedirects: 5, headers: HEADERS });
    htmlImages = parseStorefrontImagesFromHtml(html, sku);
  } catch {
    htmlImages = [];
  }

  if (htmlImages.length < 3 && browser) {
    extractorPath = 'playwright';
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      // Scroll in steps to trigger lazy-loaded sections (highlights / 5050 / carousel
      // / productowners blocks typically defer rendering until scrolled into view).
      for (let i = 1; i <= 4; i++) {
        await page.evaluate(s => window.scrollTo(0, document.body.scrollHeight * s / 4), i);
        await page.waitForTimeout(1200);
      }
      htmlImages = parseStorefrontImagesFromHtml(await page.content(), sku);
    } catch {
      // Browser path failed — keep whatever Cheerio produced.
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // ─ Merge: union of API gallery + HTML sections, deduped ─
  // Dedup keys differ by source: API entries use filename stem; HTML new-template
  // entries use the storefront-relative path; HTML old-template entries use filename
  // stem (matches the API). The dedup keys are pre-computed on each image to keep
  // this merge stable across both URL patterns.
  const apiImages = await apiPromise;
  // Compute dedup key per HTML image: old-template uses filename stem, new uses path.
  const tagHtmlImage = (img) => {
    if (img.sectionFolder === '01_Gallery') {
      // Old-template image — derive filename stem from src
      const m = img.src.match(/SharkNinja-NA\/([A-Z0-9_-]+)\.(?:jpg|jpeg|png|webp|gif)/i);
      const stem = m ? m[1].toUpperCase() : img.src;
      return { ...img, _dedupKey: stem.replace(/[_-]+/, '_') };
    }
    // New-template — dedup by storefront path embedded in URL
    const m = img.src.match(/(storefront\/products\/[^"'\s?]+)/);
    return { ...img, _dedupKey: m ? m[1] : img.src };
  };
  const taggedHtml = htmlImages.map(tagHtmlImage);

  const seen = new Set();
  const merged = [];
  for (const img of [...apiImages, ...taggedHtml]) {
    if (seen.has(img._dedupKey)) continue;
    seen.add(img._dedupKey);
    const { _dedupKey, ...rest } = img;
    merged.push({ ...rest, sequencePosition: merged.length + 1 });
  }

  // Second-pass dedup: collapse mobile/desktop variants of the same underlying asset.
  // SharkNinja stores many shots as both <Name>_Desktop and <Name>_Mobile (or
  // <Name>_Desktop-InUse_04 and <Name>_Mobile-InUse_04). These have distinct storefront
  // paths so the first-pass key-based dedup misses them, but they're the same source
  // asset rendered for two viewport tiers. Keep the first-seen, drop the duplicate.
  // Conservative: only strips a "Desktop" or "Mobile" segment when it's a clean
  // separator-delimited token (so "MobileLarge" stays as-is).
  const stemSeen = new Set();
  const deduped = [];
  for (const img of merged) {
    const filename = (img.src.split('/').pop() || '').split('?')[0]
      .replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
    let stem = filename.toLowerCase()
      .replace(/-/g, '_')                                  // normalize separators
      .replace(/_+/g, '_')                                  // collapse multi
      .replace(/(?:^|_)(?:desktop|mobile)(?=_|$)/g, '')    // strip platform tokens
      .replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (stemSeen.has(stem)) continue;
    stemSeen.add(stem);
    deduped.push({ ...img, sequencePosition: deduped.length + 1 });
  }

  return {
    ...base,
    galleryImageCount: deduped.length,
    images:            deduped,
    extractorPath,     // 'cheerio' or 'playwright' (HTML source); API always also tried
    extractedAt:       new Date().toISOString(),
  };
}

// Generic Shopify product JSON API extractor. Used by any brand running on Shopify
// where /products/<handle>.json returns the canonical gallery image list — no DOM
// scrape, no browser, no SKU-in-path filter needed. Currently in use for: Dreame,
// Ooni, Our Place, Fellow.
//
// Accessory tag-and-skip: URL handles matching the brand's pdpExcludeKeywords pattern
// get a skip record (skipped: true, skipReason: 'accessory') so they remain visible
// in gallery_raw.json without burning the JSON API call or any downstream audit
// budget. Brands without a pdpExcludeKeywords pattern simply skip the check.
export async function extractShopifyJsonApi(url, brandKey, brandName) {
  const pathParts = new URL(url).pathname.split('/').filter(Boolean);
  const handle = pathParts[pathParts.length - 1] || 'unknown';
  const base = {
    brand:    brandKey,
    brandName,
    url,
    sku:      handle,           // Shopify convention: URL handle is the effective SKU.
    family:   handle,
    category: handle,
  };

  // Tag-and-skip accessories before any network call.
  const excludePattern = SITEMAP_BRAND_CONFIG[brandKey]?.pdpExcludeKeywords;
  if (excludePattern && excludePattern.test(handle)) {
    return {
      ...base,
      galleryImageCount: 0,
      images:            [],
      skipped:           true,
      skipReason:        'accessory',
      skipPattern:       String(excludePattern),
      extractorPath:     'skipped',
      extractedAt:       new Date().toISOString(),
    };
  }

  try {
    const { data } = await axios.get(`${url}.json`, { timeout: 15000, headers: HEADERS });
    const p = data?.product || {};
    const images = (p.images || []).map((img, i) => ({
      src:              img.src,
      alt:              img.alt || '',
      width:            img.width  || 0,
      height:           img.height || 0,
      sequencePosition: img.position || (i + 1),
      // No section info on Shopify JSON — viewType intentionally absent. The audit
      // sampler (sampleGalleryImages) detects this and falls back to position-based
      // sampling, which is the correct behavior for a single linear gallery carousel.
    }));
    return {
      ...base,
      family:            p.handle       || handle,
      // Use Shopify's product_type as the category — clean signal for cross-brand
      // comparison (e.g. "Robot Vacuums", "Wet and Dry Vacuums", "Cordless Vacuums").
      category:          p.product_type || 'unknown',
      productType:       p.product_type || null,
      productTitle:      p.title        || null,
      galleryImageCount: images.length,
      images,
      extractorPath:     'shopify-json',
      extractedAt:       new Date().toISOString(),
    };
  } catch (e) {
    return {
      ...base,
      galleryImageCount: 0,
      images:            [],
      error:             e.message,
      extractorPath:     'shopify-json-error',
      extractedAt:       new Date().toISOString(),
    };
  }
}

// Generic extractor for brands whose PDP galleries are lazy-loaded behind an
// IntersectionObserver — scrolling each candidate img into view forces it to populate
// its src before we read the DOM. Combined with multi-host filtering (Nothing splits
// across Sanity + Shopify CDNs) and substring path filtering (Rimowa needs
// "Sites-rimowa-master-catalog-final" to separate product imagery from chrome).
//
// Config flags (set in config.js BRANDS[brandKey]):
//   useLazyLoadGalleryExtractor: true   — routes here from extractOnePdp
//   imageHosts: string[]                — allowed hostnames (preferred over imageHost)
//   imageHost: string                   — single allowed hostname (used if imageHosts absent)
//   imagePathContains: string           — substring that must appear anywhere in src
//   gallerySelectors: string[]          — DOM scope; falls back to all <img> if absent
//   lazyLoadWaitMs: number              — delay per scrollIntoView step (default 200)
//   initialPageWaitMs: number           — post-goto wait before scroll (default 2500)
//
// Currently in use for: Nothing, Bang & Olufsen, Rimowa.
export async function extractGenericLazyLoadGallery(url, brandKey, brandName, browser) {
  const cfg = SITEMAP_BRAND_CONFIG[brandKey] || {};
  const imageHosts = Array.isArray(cfg.imageHosts) ? cfg.imageHosts : (cfg.imageHost ? [cfg.imageHost] : []);
  const pathContains = cfg.imagePathContains || null;
  const gallerySelectors = cfg.gallerySelectors || [];
  const lazyLoadWait = cfg.lazyLoadWaitMs || 200;
  const initialWait = cfg.initialPageWaitMs || 2500;

  const pathParts = new URL(url).pathname.split('/').filter(Boolean);
  const handle = (pathParts[pathParts.length - 1] || 'unknown').replace('.html', '');
  const base = {
    brand: brandKey,
    brandName,
    url,
    sku: handle,
    family: pathParts[1] || pathParts[0] || 'unknown',
    category: pathParts[2] || pathParts[1] || 'unknown',
  };

  let page = null;
  try {
    page = await browser.newPage();
    await setupPage(page);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch { /* continue — partial loads still extract */ }
    await page.waitForTimeout(initialWait);

    // Akamai/Cloudflare bot-block detection. When the title says "Access Denied" we
    // record the error and return early instead of timing out on element queries.
    const title = await page.title();
    if (/Access Denied/i.test(title)) {
      return { ...base, galleryImageCount: 0, images: [], error: 'bot-block-detected', extractorPath: 'lazy-load-blocked', extractedAt: new Date().toISOString() };
    }

    // Trigger lazy load: scroll each candidate element into the viewport so the
    // IntersectionObserver fires and populates src.
    if (gallerySelectors.length) {
      await page.evaluate(async ({ sels, wait }) => {
        const found = new Set();
        for (const sel of sels) {
          try { document.querySelectorAll(sel).forEach(el => found.add(el)); } catch {}
        }
        for (const el of found) {
          el.scrollIntoView({ block: 'center' });
          await new Promise(r => setTimeout(r, wait));
        }
      }, { sels: gallerySelectors, wait: lazyLoadWait });
      await page.waitForTimeout(1500);
    }

    // Extract images: scoped to gallerySelectors when provided, then filtered by
    // imageHosts (any-match) and imagePathContains (substring), then deduped by clean src.
    const images = await page.evaluate(({ sels, hosts, pathSub }) => {
      const found = new Set();
      if (sels && sels.length) {
        for (const sel of sels) {
          try {
            document.querySelectorAll(sel).forEach(el => {
              if (el.tagName === 'IMG') found.add(el);
              else el.querySelectorAll('img').forEach(img => found.add(img));
            });
          } catch {}
        }
      } else {
        document.querySelectorAll('img').forEach(el => found.add(el));
      }
      const out = [];
      let i = 0;
      for (const el of found) {
        const src = el.currentSrc || el.src || el.getAttribute('data-src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (hosts.length) {
          try { if (!hosts.includes(new URL(src).hostname)) continue; } catch { continue; }
        }
        if (pathSub && !src.includes(pathSub)) continue;
        out.push({ src, alt: el.alt || '', width: el.naturalWidth || 0, height: el.naturalHeight || 0, sequencePosition: ++i });
      }
      const seen = new Set();
      const dedupd = [];
      for (const im of out) {
        const k = im.src.split('?')[0];
        if (seen.has(k)) continue;
        seen.add(k);
        dedupd.push(im);
      }
      return dedupd;
    }, { sels: gallerySelectors, hosts: imageHosts, pathSub: pathContains });

    return {
      ...base,
      productTitle: null,
      galleryImageCount: images.length,
      images,
      extractorPath: 'lazy-load-gallery',
      extractedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ...base, galleryImageCount: 0, images: [], error: e.message, extractorPath: 'lazy-load-error', extractedAt: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── Extract one PDP: standard browser first, stealth retry on error ─────────
async function extractOnePdp(url, brandKey, brandName, imageHost, stdBrowser, stealthBrowser, preferStealth) {
  // SharkNinja: hybrid static+browser extractor scrapes section-block imagery from
  // the live PDP (legacy catalog API is now sparse). Browser is passed for fallback.
  if (brandKey === 'sharkninja') {
    return extractSharkNinjaHybrid(url, brandName, stealthBrowser || stdBrowser);
  }
  // Shopify-backed brands route through the generic JSON-API extractor. No browser needed.
  if (SITEMAP_BRAND_CONFIG[brandKey]?.useShopifyJsonApi) {
    return extractShopifyJsonApi(url, brandKey, brandName);
  }
  // Lazy-load gallery brands (Nothing, B&O, Rimowa) — scrollIntoView + multi-host + path-filter.
  if (SITEMAP_BRAND_CONFIG[brandKey]?.useLazyLoadGalleryExtractor) {
    return extractGenericLazyLoadGallery(url, brandKey, brandName, preferStealth ? stealthBrowser : stdBrowser);
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
    let page = null;
    try {
      page = await browser.newPage();
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
        // On attempt 1: skip straight to stealth on next iteration; on attempt 2: return blocked.
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
        continue;
      }

      await progressiveScroll(page, extraWait);
      // Tighten capture using brand-specific gallery selectors. Reduces over-capture
      // from cross-sell carousels, color swatches, recommendation widgets, promo
      // tiles. SKU-in-path filter is brand-opt-in (BRANDS[key].enforceSkuInPath) —
      // only safe for brands whose asset CDN includes the SKU in URL paths (Breville
      // does: /BES995/...; Vitamix and Williams-Sonoma do not, so don't enforce there).
      const brandCfg = SITEMAP_BRAND_CONFIG[brandKey] || {};
      const skuForFilter = brandCfg.enforceSkuInPath
        ? (pathParts[pathParts.length - 1] || '').toUpperCase()
        : null;
      const images = await extractAllImageSrcs(page, imageHost || '', {
        gallerySelectors: brandCfg.gallerySelectors,
        skuForFilter,
      });

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
    } finally {
      // Always close the page — guards against leaks when any page.* call above throws.
      if (page) await page.close().catch(() => {});
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
//
// TODO (follow-up, 2026-06): the imageHost filter on competitor brands is permissive —
// any image on the brand's primary host counts as "gallery." This over-counts in
// practice because it also catches:
//   - Header/nav logos and icons
//   - Recommended-product thumbnails ("you may also like…")
//   - Reviews-section avatars / mini product shots
//   - Promotional banners and email-signup imagery
// Symptom: Breville PDPs storing 39-122 images each (median 55), well above the realistic
// gallery size of ~10-15. After the SharkNinja section-aware fix lands, do the same kind
// of structural pass for competitors — narrow the selector to known PDP gallery container
// classes (per-brand) instead of blanket img[src*=imageHost], OR add per-brand exclusion
// regexes for nav/recommendation/avatar URL patterns.
async function extractAllImageSrcs(page, imageHost, opts = {}) {
  // opts.gallerySelectors: optional array of CSS selectors that narrow the DOM scope
  //   to specific gallery containers/images. Used by competitor brands whose pages
  //   pack the layout with cross-sell carousels, color swatches, and promo tiles —
  //   without scoping, every brand-hosted <img> gets captured (Breville bes995 = 121
  //   images, ~80% of which are chrome). When this is set, only <img> elements
  //   matching one of the selectors (or <img> descendants of matching containers)
  //   are read. Selectors come from BRANDS[brandKey].gallerySelectors in config.js.
  //
  // opts.skuForFilter: defensive secondary filter — image src path must contain this
  //   substring (case-insensitive). Catches anything that leaks through the selector
  //   (e.g. a cross-sell that happens to use the same image class).
  return page.evaluate(({ host, selectors, sku }) => {
    const seen = new Set();
    const results = [];

    function add(src, meta = {}) {
      if (!src || src.startsWith('data:') || seen.has(src)) return;
      if (host && !src.includes(host)) return;
      if (sku && !src.toLowerCase().includes(sku.toLowerCase())) return;
      seen.add(src);
      results.push({ src, alt: meta.alt || '', width: meta.width || 0, height: meta.height || 0 });
    }

    function bestFromSrcset(srcset) {
      if (!srcset) return null;
      const parts = srcset.split(',').map(s => s.trim().split(/\s+/));
      parts.sort((a, b) => parseInt(b[1] || 0) - parseInt(a[1] || 0));
      return parts[0]?.[0] || null;
    }

    // Scope: gallerySelectors when provided, otherwise the whole page (legacy behavior
    // for /api/host-discovery and brands without configured selectors).
    let scopedImgs;
    if (Array.isArray(selectors) && selectors.length) {
      const collected = new Set();
      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            if (el.tagName === 'IMG') collected.add(el);
            else el.querySelectorAll('img').forEach(img => collected.add(img));
          });
        } catch { /* ignore invalid selector */ }
      }
      scopedImgs = [...collected];
    } else {
      scopedImgs = Array.from(document.querySelectorAll('img'));
    }

    // img tags
    scopedImgs.forEach(img => {
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
  }, { host: imageHost, selectors: opts.gallerySelectors || null, sku: opts.skuForFilter || null });
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

// ── Creative audit ────────────────────────────────────────────────────────────

const AUDIT_CACHE_PATH = path.join(__dirname, 'data/creative_audit_cache.json');

function loadAuditCache() {
  return fs.existsSync(AUDIT_CACHE_PATH) ? JSON.parse(fs.readFileSync(AUDIT_CACHE_PATH, 'utf8')) : {};
}
function saveAuditCache(cache) {
  fs.writeFileSync(AUDIT_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Sampling for the Creative Audit. Two strategies:
//   - If images carry viewType tags (SharkNinja hybrid extractor), sample ACROSS view
//     types so the audit sees a representative spread of every PDP section, not 6 from
//     one block. Round-robin pick: 1 per viewType, then 2 per viewType, etc.
//   - If images don't carry viewType (legacy/competitor brands), fall back to the
//     position-based even sample.
function sampleGalleryImages(images, max = 6) {
  if (images.length <= max) return images;

  const tagged = images.filter(img => img.viewType);
  const useCrossSection = tagged.length >= images.length * 0.5; // mostly tagged → use it

  if (useCrossSection) {
    const buckets = {};
    images.forEach(img => {
      const k = img.viewType || 'other';
      (buckets[k] = buckets[k] || []).push(img);
    });
    const keys = Object.keys(buckets);
    const picked = [];
    // Round-robin: take index 0 from each bucket, then 1, etc., until quota.
    for (let i = 0; picked.length < max; i++) {
      let advanced = false;
      for (const k of keys) {
        if (i < buckets[k].length && picked.length < max) {
          picked.push(buckets[k][i]);
          advanced = true;
        }
      }
      if (!advanced) break;
    }
    return picked;
  }

  // Legacy fallback: evenly spaced across the array.
  const out = [images[0]];
  const step = (images.length - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.push(images[Math.round(i * step)]);
  out.push(images[images.length - 1]);
  return out;
}

async function fetchImageBase64(url) {
  const { data, headers } = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 12000, headers: HEADERS,
  });
  const mediaType = (headers['content-type'] || 'image/jpeg').split(';')[0].trim();
  return { data: Buffer.from(data).toString('base64'), mediaType };
}

const CREATIVE_AUDIT_PROMPT = `You are a senior PDP creative director. Audit this brand.com product gallery.

Platform: brand.com — apply these standards:
- Environmental/contextual hero preferred over pure white; creative latitude allowed
- Bold typography, dark/moody aesthetics acceptable if on-brand
- Consistency across the product line matters more than strict retailer compliance
- Video or motion in top slot strongly preferred

Auto-detect product category from visual cues only (no text clues needed):
Electronics: hardware, buttons, cables, displays, mesh grilles, hard plastic/metal housing
Beauty: pumps, droppers, compacts, glass/soft-touch packaging, swatches, skin/hair close-ups
Hybrid: device with direct skin/hair contact (electric razor, hair dryer)

Evaluate the gallery using the 7-Beat Framework:
Beat 1 "hero" — product identification | Beat 2 "lifestyle" — product in use
Beat 3 "benefit" — benefit callout | Beat 4 "technical" — how it works
Beat 5 "detail" — quality/material close-up | Beat 6 "social" — diverse lifestyle
Beat 7 "proof" — awards/social proof

Some assets carry a "section:" label indicating which labeled block of the brand.com PDP
they came from. Use it as a strong prior when assigning each asset's most likely beat:
  - section: gallery     → typically hero or lifestyle
  - section: highlights  → typically benefit or technical (feature callouts)
  - section: 5050        → typically benefit or detail (split-section feature blocks)
  - section: carousel    → typically benefit or lifestyle (in-page secondary carousel)
  - section: proof       → typically social or proof (testimonials, ratings, awards)
Treat the label as a prior, not a rule — confirm visually before assigning the beat.

For each image, score relevant dimensions 1–10 (null if not applicable):
- composition: framing, negative space, product prominence
- lighting: evenness, mood, color accuracy
- appeal: emotional pull, aspirational quality within 2 seconds
- textLegibility: hierarchy, thumbnail legibility, contrast (infographics only)
- brandConsistency: color/font/tone coherence with rest of gallery

Do NOT emit a gallery-level headline score or readiness band. Those are computed
downstream from your per-image dimension scores and beat-presence list using a fixed
formula. Your job is to give accurate, calibrated dimension scores and a clear beat
analysis — the headline number is derived from those, not picked by you.

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "detectedCategory": "Electronics | Beauty | Hybrid",
  "storyArc": {
    "score": <1-10>,
    "beatsPresent": ["hero","lifestyle",...],
    "beatsMissing": ["detail",...],
    "assessment": "<2-3 specific sentences about narrative strength>"
  },
  "assets": [
    {
      "position": <1-based>,
      "type": "Hero | Lifestyle | Infographic | Detail | Video Thumbnail | Packshot",
      "scores": { "composition": <n|null>, "lighting": <n|null>, "appeal": <n|null>, "textLegibility": <n|null>, "brandConsistency": <n|null> },
      "observations": "<2-3 specific, observational sentences — reference what is visible>",
      "criticalActions": ["<issue — why it matters — specific fix>"],
      "recommendedActions": ["<issue — why it matters — specific fix>"]
    }
  ],
  "summary": {
    "strengths": "<what works and why>",
    "gaps": "<dominant creative gap>",
    "crossAssetConsistency": "<visual coherence assessment>"
  },
  "priorityActions": [
    { "tier": "critical | recommended | optional", "action": "<specific action>" }
  ]
}`;

// ── Deterministic gallery scoring ────────────────────────────────────────────
// galleryScore / readiness are NOT trusted from the model — the model emits per-image
// dimension scores and beat-presence lists; this function turns those into the headline
// number with a fixed formula so two audits of the same JSON always yield the same score.
//
// Formula:
//   per-image craft = weighted avg of present dimension scores, weights renormalized over
//                     the dimensions that actually have values (so an image without
//                     textLegibility is not penalized for that absence).
//   gallery craft   = mean of per-image craft scores.
//   story score     = (distinct beatsPresent / 7) * 10.
//   galleryScore    = 0.70 * gallery craft + 0.30 * story score, rounded to 1 decimal.
//   readiness       = >=7.5 Approved, 6.0–7.4 Conditional, <6.0 Revise.
//
// scoreBreakdown is returned alongside so any score can be explained — exactly which
// dimensions contributed, what each per-image craft was, and how the blend resolved.
const CRAFT_WEIGHTS = {
  appeal:           0.30,
  composition:      0.30,
  lighting:         0.20,
  brandConsistency: 0.15,
  textLegibility:   0.05,
};
const ALL_BEATS = ['hero','lifestyle','benefit','technical','detail','social','proof'];

export function computeGalleryScore(auditResult) {
  const assets = Array.isArray(auditResult?.assets) ? auditResult.assets : [];

  // Per-image craft. Renormalize weights across whatever dimensions are present so a
  // missing dimension neither contributes 0 nor caps the max — it's simply excluded.
  const perImageRaw = [];
  const perImage = assets.map((asset, idx) => {
    const scores = asset?.scores || {};
    const dimensionsScored = [];
    let weightedSum = 0;
    let weightTotal = 0;
    for (const [dim, w] of Object.entries(CRAFT_WEIGHTS)) {
      const v = scores[dim];
      if (typeof v === 'number' && Number.isFinite(v)) {
        weightedSum += v * w;
        weightTotal += w;
        dimensionsScored.push({ dimension: dim, value: v, weight: w });
      }
    }
    const craftRaw = weightTotal > 0 ? weightedSum / weightTotal : null;
    perImageRaw.push(craftRaw);
    return {
      position:       asset?.position ?? idx + 1,
      craftScore:     craftRaw !== null ? Number(craftRaw.toFixed(3)) : null,
      dimensionsScored,
    };
  });

  // Gallery craft uses RAW per-image values so we don't accumulate rounding error.
  const validRaw = perImageRaw.filter(n => n !== null);
  const galleryCraftRaw = validRaw.length
    ? validRaw.reduce((s, n) => s + n, 0) / validRaw.length
    : 0;

  // Story completeness — only beats from the canonical 7-beat list count.
  const presentRaw = auditResult?.storyArc?.beatsPresent || [];
  const beatsPresent = new Set(
    presentRaw.map(b => String(b).toLowerCase()).filter(b => ALL_BEATS.includes(b))
  );
  const storyCompletenessRaw = (beatsPresent.size / 7) * 10;

  const finalRaw = galleryCraftRaw * 0.70 + storyCompletenessRaw * 0.30;
  const galleryScore = Number(finalRaw.toFixed(1));

  let readiness;
  if (galleryScore >= 7.5) readiness = 'Approved';
  else if (galleryScore >= 6.0) readiness = 'Conditional';
  else readiness = 'Revise';

  return {
    galleryScore,
    readiness,
    scoreBreakdown: {
      perImage,
      galleryCraftAverage:    Number(galleryCraftRaw.toFixed(3)),
      storyCompletenessScore: Number(storyCompletenessRaw.toFixed(3)),
      beatsPresentCount:      beatsPresent.size,
      beatsPresentMatched:    [...beatsPresent].sort(),
      finalRaw:               Number(finalRaw.toFixed(3)),
      formula:                '0.70 × galleryCraftAverage + 0.30 × storyCompletenessScore',
      weights:                CRAFT_WEIGHTS,
      readinessThresholds:    { Approved: '>=7.5', Conditional: '6.0-7.4', Revise: '<6.0' },
    },
  };
}

// Reusable audit core — used by both /api/creative-audit (single-PDP) and audit_pipeline.js (bulk).
// Throws on failure; caller handles cache + HTTP semantics.
export async function runCreativeAuditForPdp({ pdpUrl, brandName, images, apiKey }) {
  if (!pdpUrl || !Array.isArray(images) || !images.length) {
    throw new Error('pdpUrl and images required');
  }
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const sampled = sampleGalleryImages(images, 6);
  // Fetch image bytes + keep the original sampled metadata so we can pair each image
  // with its section label in the prompt.
  const fetched = (await Promise.all(
    sampled.map(async img => {
      try {
        const { data, mediaType } = await fetchImageBase64(img.src);
        return { img, block: { type: 'image', source: { type: 'base64', media_type: mediaType, data } } };
      } catch { return null; }
    })
  )).filter(Boolean);
  if (!fetched.length) throw new Error('Could not fetch any gallery images for analysis');

  const imageBlocks = fetched.map(f => f.block);
  // Section labels for each image, indexed in the same order as imageBlocks.
  // If no images carry a viewType (legacy brands), the list collapses to empty and the
  // prompt's section-prior guidance falls back to pure visual judgment.
  const sectionLabels = fetched.map((f, i) =>
    f.img.viewType ? `Image ${i + 1}: section: ${f.img.viewType}` : `Image ${i + 1}: (no section label)`
  ).join('\n');

  const useBearer = apiKey.startsWith('sn_live_');
  const anthropic = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ...(useBearer ? { authToken: apiKey, apiKey: null } : { apiKey }),
    // Bump explicit retry count above the SDK default of 2. The audit goes through the
    // SharkNinja AI Hub gateway → Anthropic, and occasional 500s ("Internal server
    // error", request_id req_011...) from Anthropic's backend recover within seconds.
    // 4 retries with exponential backoff buys ~30s of resilience.
    maxRetries: 4,
  });

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    // Temperature 0 — galleryScore is now computed in code from the model's structured
    // dimension ratings, so we want those ratings as stable as possible. The cross-PDP
    // score spread now comes from the deterministic formula (computeGalleryScore), not
    // from model variance. Re-running the same PDP should produce the same audit.
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        { type: 'text', text: `${CREATIVE_AUDIT_PROMPT}\n\nBrand: ${brandName}\nPDP: ${pdpUrl}\nImages shown: ${imageBlocks.length} of ${images.length} total (sampled across PDP sections when available).\n\nSection labels for the assets shown above:\n${sectionLabels}` },
      ],
    }],
  });

  if (message.stop_reason === 'max_tokens') {
    throw new Error('Audit response was truncated (hit max_tokens)');
  }

  let rawText = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const result = JSON.parse(rawText);

  // Derive galleryScore/readiness/scoreBreakdown deterministically from the model's
  // structured ratings. The model itself no longer emits a headline score — any value
  // present on `result` here for these fields is overwritten with the computed value,
  // which prevents a stray freehand number from leaking through if the prompt is ever
  // edited back to emit one.
  const computed = computeGalleryScore(result);
  result.galleryScore   = computed.galleryScore;
  result.readiness      = computed.readiness;
  result.scoreBreakdown = computed.scoreBreakdown;

  result.auditedAt        = new Date().toISOString();
  result.imageCount       = images.length;
  result.sampledCount     = imageBlocks.length;
  // Sorted URL set — used by audit_pipeline.js to detect gallery changes since last audit.
  result.auditedImageUrls = [...images].map(i => i.src).sort();
  return result;
}

// Same threshold as audit_pipeline.js — keep them in sync. Both call sites enforce
// the guardrail; per-row endpoint also writes a skip record so the viewer's column
// surfaces "Too few images (N)" instead of leaving the row looking unaudited.
const MIN_IMAGES_FOR_AUDIT = 5;

app.post('/api/creative-audit', async (req, res) => {
  const { pdpUrl, brandName, images } = req.body;

  const cache = loadAuditCache();
  if (cache[pdpUrl]) return res.json({ cached: true, ...cache[pdpUrl] });

  // Guardrail: skip audit for PDPs with too few captured images. Counts the live
  // images array passed in the request (sourced from gallery_raw.json), which is
  // the exact set the audit would otherwise sample.
  const liveImageCount = Array.isArray(images) ? images.length : 0;
  if (liveImageCount < MIN_IMAGES_FOR_AUDIT) {
    const skipRecord = {
      skipped:          true,
      skipReason:       'insufficient_images',
      imageCount:       liveImageCount,
      minRequired:      MIN_IMAGES_FOR_AUDIT,
      auditedImageUrls: [...(images || [])].map(img => img.src).sort(),
      skippedAt:        new Date().toISOString(),
    };
    cache[pdpUrl] = skipRecord;
    saveAuditCache(cache);
    return res.json({ skipped: true, ...skipRecord });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const result = await runCreativeAuditForPdp({ pdpUrl, brandName, images, apiKey });
    cache[pdpUrl] = result;
    saveAuditCache(cache);
    res.json({ cached: false, ...result });
  } catch (e) {
    console.error('[Audit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/creative-audit/cache', (_req, res) => res.json(loadAuditCache()));

// ── Bulk audit (Phase 4) ─────────────────────────────────────────────────────
const AUDIT_JOBS_PATH   = path.join(__dirname, 'data/audit_jobs.json');
const AUDIT_REPORT_PATH = path.join(__dirname, 'data/audit_report.json');

// POST: button writes a job-queue request. The next bulk-audit cron run picks it up.
// On free tier we can't remotely trigger a cron, so this is feedback-only — the cron
// runs on its own schedule (Wednesday 2 AM UTC) and the queue request expands its coverage.
app.post('/api/audit/bulk/trigger', (_req, res) => {
  const job = { requested: new Date().toISOString() };
  fs.mkdirSync(path.dirname(AUDIT_JOBS_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_JOBS_PATH, JSON.stringify(job, null, 2));
  res.json({ queued: true, ...job });
});

// GET: coverage status — how many SharkNinja PDPs have a current audit.
app.get('/api/audit/bulk/status', (_req, res) => {
  const galleryPath = path.join(__dirname, 'data/gallery_raw.json');
  if (!fs.existsSync(galleryPath)) return res.json({ audited: 0, total: 0, pending: 0 });
  const gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
  const snUrls  = gallery.filter(p => p.brand === 'sharkninja' && p.url && !p.error).map(p => p.url);
  const cache   = loadAuditCache();
  const audited = snUrls.filter(u => cache[u]).length;

  let queuedAt = null;
  if (fs.existsSync(AUDIT_JOBS_PATH)) {
    try { queuedAt = JSON.parse(fs.readFileSync(AUDIT_JOBS_PATH, 'utf8')).requested; } catch {}
  }
  res.json({ audited, total: snUrls.length, pending: snUrls.length - audited, queuedAt });
});

// GET: the deterministic + Claude-narrative report generated by audit_pipeline.js.
app.get('/api/audit/report', (_req, res) => {
  if (!fs.existsSync(AUDIT_REPORT_PATH)) return res.json({ generatedAt: null });
  try { res.json(JSON.parse(fs.readFileSync(AUDIT_REPORT_PATH, 'utf8'))); }
  catch (e) { res.status(500).json({ error: `Could not read audit_report.json: ${e.message}` }); }
});

// ── Claim ownability (Phase 5) ────────────────────────────────────────────────
const CLAIMS_REPORT_PATH = path.join(__dirname, 'data/claims_report.json');
const CLAIMS_DATA_PATH   = path.join(__dirname, 'data/claims_extracted.json');

app.get('/api/claims/status', (_req, res) => {
  const galleryPath = path.join(__dirname, 'data/gallery_raw.json');
  if (!fs.existsSync(galleryPath)) return res.json({ extracted: 0, total: 0, asymmetry: {} });
  const gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
  const inScope = new Set(['sharkninja', 'vitamix', 'breville', 'dyson']);
  const pool = gallery.filter(p => inScope.has(p.brand) && p.url && !p.error && p.images?.length);
  const claims = fs.existsSync(CLAIMS_DATA_PATH) ? JSON.parse(fs.readFileSync(CLAIMS_DATA_PATH, 'utf8')) : { pdps: {} };
  const extracted = pool.filter(p => claims.pdps[p.url]).length;
  const asymmetry = {};
  pool.forEach(p => { asymmetry[p.brand] = (asymmetry[p.brand] || 0) + 1; });
  res.json({ extracted, total: pool.length, pending: pool.length - extracted, asymmetry });
});

app.get('/api/claims/report', (_req, res) => {
  if (!fs.existsSync(CLAIMS_REPORT_PATH)) return res.json({ generatedAt: null });
  try { res.json(JSON.parse(fs.readFileSync(CLAIMS_REPORT_PATH, 'utf8'))); }
  catch (e) { res.status(500).json({ error: `Could not read claims_report.json: ${e.message}` }); }
});

// ── Review flags (Phase 3 — color/appearance mismatch monitoring) ────────────
app.get('/api/reviews/flagged', (_req, res) => {
  const p = path.join(__dirname, 'data/reviews_flagged.json');
  if (!fs.existsSync(p)) return res.json({ lastUpdatedAt: null, pdps: {} });
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Tolerate the Phase 2 array shape by returning empty until the pipeline overwrites it.
    if (Array.isArray(raw)) return res.json({ lastUpdatedAt: null, pdps: {} });
    res.json(raw);
  } catch (e) {
    res.status(500).json({ error: `Could not read reviews_flagged.json: ${e.message}` });
  }
});

app.delete('/api/creative-audit/cache', (req, res) => {
  const { url } = req.body;
  const cache = loadAuditCache();
  if (url && cache[url]) { delete cache[url]; saveAuditCache(cache); }
  else if (!url) { saveAuditCache({}); }
  res.json({ ok: true });
});

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
  // Sequential within a brand and a single browser, to fit Render 512MB starter tier.
  // Prior version ran pLimit(3) + two parallel browsers — peak ~600MB and OOM-killed on Render.
  // Brands are already sequential in runFullRefresh, so this caps total peak at ~300MB.
  const results = [];
  let done = 0;

  if (brandKey === 'sharkninja') {
    // Hybrid extractor: Cheerio first, falls back to Playwright at <3 images.
    // Need a browser available for the fallback. Launch one stealth browser shared
    // across all SN PDPs in this run; only opens pages when fallback fires.
    const snBrowser = await chromiumStealth.launch({ headless: true });
    try {
      for (const url of urls) {
        results.push(await extractSharkNinjaHybrid(url, brandName, snBrowser));
        onProgress?.(++done, urls.length);
      }
    } finally {
      await snBrowser.close();
    }
    return results;
  }

  if (SITEMAP_BRAND_CONFIG[brandKey]?.useShopifyJsonApi) {
    // Shopify product JSON API — pure HTTP, no browser. Accessory tag-and-skip
    // is handled inside the extractor.
    for (const url of urls) {
      results.push(await extractShopifyJsonApi(url, brandKey, brandName));
      onProgress?.(++done, urls.length);
    }
    return results;
  }

  // Single stealth-capable browser. Stealth is a superset of std chromium for our use,
  // so we drop the second browser entirely to halve browser memory.
  // extractOnePdp's retry path varies waitUntil/extraWait — passing the same browser
  // as both "std" and "stealth" args still exercises that retry, just with one process.
  const browser = await chromiumStealth.launch({ headless: true });
  try {
    for (const url of urls) {
      results.push(await extractOnePdp(url, brandKey, brandName, imageHost, browser, browser, useStealth));
      onProgress?.(++done, urls.length);
    }
  } finally {
    await browser.close();
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
  // Computes the next fire time for a 5-field "min hour * * weekday" cron expression
  // in UTC — Render Cron Jobs (and our refresh.js) interpret schedules as UTC, so we
  // must reason in UTC throughout (otherwise an EDT/PDT server box would mis-compute).
  const parts = cronExpression.split(' ');
  if (parts.length !== 5) return null;
  const minute  = parseInt(parts[0]);
  const hour    = parseInt(parts[1]);
  const weekday = parseInt(parts[4]);
  if ([minute, hour, weekday].some(isNaN)) return null;

  const now = new Date();
  let daysUntil = (weekday - now.getUTCDay() + 7) % 7;
  if (daysUntil === 0) {
    const passedToday = now.getUTCHours() > hour || (now.getUTCHours() === hour && now.getUTCMinutes() >= minute);
    if (passedToday) daysUntil = 7;
  }
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntil);
  next.setUTCHours(hour, minute, 0, 0);
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

  // ─ Sitemap re-discovery phase ─
  // Re-fetch each brand's sitemap (or category pages) so newly-launched SKUs that
  // weren't in the original crawl get picked up. Reuses crawlBrand() from
  // 1_crawl_sitemaps.js — no new crawler logic. Brands not in config.js (e.g.
  // user-added via the Add Brand modal) are skipped since we don't know their sitemap.
  // Memory: sharkninja/vitamix/williamssonoma use pure HTTP (negligible). Dyson and
  // Breville use Playwright; crawlBrand opens then closes its browser per call, so
  // peak memory matches the existing single-browser extract pattern (~300MB).
  const newlyDiscoveredCounts = {};
  log('Re-crawling sitemaps for newly-launched SKUs…');
  progress(2, 'Re-crawling sitemaps…');

  // Discovery in SharkNinja-first order so SN's new SKUs are guaranteed-merged even if
  // a later brand's crawl hangs.
  const brandKeysForDiscovery = Object.keys(brandMap).sort((a, b) => {
    if (a === 'sharkninja') return -1;
    if (b === 'sharkninja') return 1;
    return 0;
  });

  for (const brandKey of brandKeysForDiscovery) {
    if (!SITEMAP_BRAND_CONFIG[brandKey]) {
      log(`  ${brandKey} — not in config.js, skipping discovery (URLs from gallery_raw.json only)`);
      continue;
    }
    try {
      const discovered = await crawlBrand(brandKey);
      const discoveredUrls = discovered.map(p => p.url);
      const before = brandMap[brandKey].urls.size;
      discoveredUrls.forEach(u => brandMap[brandKey].urls.add(u));
      const added = brandMap[brandKey].urls.size - before;
      newlyDiscoveredCounts[brandKey] = added;
      log(`  ${brandKey} — sitemap has ${discoveredUrls.length} URLs · ${added} new since last crawl`);
    } catch (e) {
      log(`  ${brandKey} — discovery FAILED (non-fatal): ${e.message}`);
      newlyDiscoveredCounts[brandKey] = 0;
    }
  }

  const brandConfigs = loadBrandConfigs();
  const brands = Object.values(brandMap).map(b => ({
    ...b,
    urls: [...b.urls],
    imageHost:  brandConfigs[b.brandKey]?.imageHost  || '',
    useStealth: brandConfigs[b.brandKey]?.useStealth || false,
  }));

  // SharkNinja-first ordering: SN's data is the freshest priority across every run.
  // This only reorders the brand iteration — per-run scope, brand eligibility, and
  // diff/commit behavior are unchanged.
  brands.sort((a, b) => {
    if (a.brandKey === 'sharkninja') return -1;
    if (b.brandKey === 'sharkninja') return 1;
    return 0;
  });

  const refreshRecord = {
    id: Date.now().toString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    brands: {},
    totals: { added: 0, removed: 0, changed: 0, unchanged: 0, errors: 0 },
    newlyDiscovered: newlyDiscoveredCounts,
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

// Scheduling lives outside this process — see render.yaml's cron service running refresh.js.
// 5-field cron validator used only by /api/refresh/config (informational, no longer drives anything).
const CRON_5FIELD_REGEX = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/;
const isValidCron = (s) => typeof s === 'string' && CRON_5FIELD_REGEX.test(s);

// ── Refresh endpoints ─────────────────────────────────────────────────────────
app.get('/api/refresh/status', (req, res) => {
  const configPath  = path.join(__dirname, 'data/refresh_config.json');
  const historyPath = path.join(__dirname, 'data/refresh_history.json');
  const config  = fs.existsSync(configPath)  ? JSON.parse(fs.readFileSync(configPath,  'utf8')) : { enabled: true, schedule: '0 2 * * 0' };
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : [];
  const schedule = config.schedule || '0 2 * * 0';

  // lastRun: derive from refresh_history.json — the authoritative source of completed runs.
  // The stored config.lastRun has historically gone stale on git-backed persistence;
  // we intentionally ignore it here.
  const lastRun = history[0]?.completedAt || history[0]?.startedAt || null;

  // nextRun: always computed live from the cron schedule. Stored config.nextRun is ignored
  // because it's only refreshed when the cron itself ran successfully — which is precisely
  // when the widget tends to read it most.
  const nextRun = computeNextRun(schedule);

  res.json({
    enabled:       config.enabled !== false,
    schedule,
    lastRun,
    nextRun,
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
  // Note: schedule field is now informational only. The actual cron is defined in render.yaml.
  // To change when the refresh runs in production, edit render.yaml and redeploy.
  const { enabled, schedule } = req.body;
  const configPath = path.join(__dirname, 'data/refresh_config.json');
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { schedule: '0 2 * * 0' };
  const updated = { ...existing };
  if (typeof enabled === 'boolean') updated.enabled = enabled;
  if (schedule && isValidCron(schedule)) { updated.schedule = schedule; }
  updated.nextRun = computeNextRun(updated.schedule);
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
  res.json({ ok: true, ...updated });
});

app.use(express.static(__dirname));

// Export runFullRefresh for refresh.js (the standalone cron entry point).
// app.listen is gated below so importing this module doesn't start the server.
export { runFullRefresh };

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`\nGallery Audit server  ->  http://localhost:${PORT}/viewer.html\n`);
  });
}
