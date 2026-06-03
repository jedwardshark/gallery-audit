// Phase 1: Playwright extractor for SharkNinja customer reviews.
//
// Approach: Bazaarvoice injects all currently-rendered reviews into a <script id="bv-jsonld-reviews-data">
// tag as schema.org JSON-LD after widget hydration. We load the page, wait for the JSON-LD to appear,
// parse it, and strip all reviewer-identifying fields before saving.
//
// PII NOTE: We deliberately do NOT capture author.name or any other reviewer-identifying field.
// Per company AUP, consumer personal info must not be processed.
//
// Retained per review:
//   - rating       (1-5)
//   - text         (review body)
//   - title        (headline — review content, non-PII)
//   - submittedAt  (publication date)
//   - helpfulVotes (currently null — not in JSON-LD; see LIMITATIONS below)
//
// LIMITATIONS (Phase 1 minimum scope — intentional, revisit before Phase 3):
// - Only the first page of reviews is captured (~8 per PDP). The widget paginates;
//   we don't yet click "Load More" / "Next page" or call the BV display API for additional pages.
// - helpfulVotes is null. JSON-LD doesn't include helpfulness counts; would require a separate
//   DOM scrape against #bv_review_maincontainer to recover.
//
// Usage:
//   node 5_scrape_reviews.js                 # runs on the 5 Phase 1 validation SKUs
//   node 5_scrape_reviews.js --url <url>    # scrapes a single URL
//
// Output: data/reviews_sample.json

import { chromium as chromiumStealth } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';

chromiumStealth.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, 'data/reviews_sample.json');

const PHASE1_URLS = [
  'https://www.sharkninja.com/ninja-espresso-coffee-barista-system/CFN601.html',
  'https://www.sharkninja.com/shark-stratos-upright-vacuum/AZ3002.html',
  'https://www.sharkninja.com/ninja-creami-ice-cream-maker/NC301.html',
  'https://www.sharkninja.com/shark-air-purifier/HC455.html',
  'https://www.sharkninja.com/ninja-foodi-possible-cooker-pro/MC1001.html',
];

function parseArgs(argv) {
  const args = { url: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
  }
  return args;
}

// Strips the JSON-LD payload down to non-PII fields only.
function sanitizeJsonLdReview(r) {
  const ratingValue = r.reviewRating?.ratingValue ?? null;
  return {
    title:        typeof r.headline === 'string' ? r.headline.trim() : '',
    text:         typeof r.reviewBody === 'string' ? r.reviewBody.trim() : '',
    rating:       (typeof ratingValue === 'number') ? ratingValue : (parseFloat(ratingValue) || null),
    submittedAt:  r.datePublished || r.dateCreated || null,
    helpfulVotes: null,
  };
}

export async function fetchReviewsViaPlaywright(url, browser) {
  const page = await browser.newPage();
  const result = { url, reviewCount: 0, reviews: [], scrapedAt: new Date().toISOString() };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // BV injects the JSON-LD review payload into the head shortly after bv.js loads.
    // Don't scroll — empirically, scrolling can trigger the widget to swap state in a way that
    // removes the JSON-LD. Just give BV time to inject it.
    await page.waitForTimeout(5000);

    // state: 'attached' — the JSON-LD is a <script> tag (never "visible"), so default
    // state:'visible' would always time out. We just need it present in the DOM.
    const jsonLdRaw = await page.waitForSelector('#bv-jsonld-reviews-data', { state: 'attached', timeout: 20000 })
      .then(el => el.evaluate(node => node.textContent))
      .catch(() => null);

    if (!jsonLdRaw) {
      result.error = 'JSON-LD review payload (#bv-jsonld-reviews-data) never appeared';
      return result;
    }

    let payload;
    try {
      payload = JSON.parse(jsonLdRaw);
    } catch (e) {
      result.error = `JSON-LD parse failed: ${e.message}`;
      return result;
    }

    const rawReviews = Array.isArray(payload.review) ? payload.review : [];
    const cleaned = rawReviews.map(sanitizeJsonLdReview).filter(r => r.text);

    result.reviews = cleaned;
    result.reviewCount = cleaned.length;
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const urls = args.url ? [args.url] : PHASE1_URLS;

  console.log(`[Scrape] Scraping ${urls.length} SharkNinja PDP(s)…`);
  const browser = await chromiumStealth.launch({ headless: true });
  // Concurrency=1: BV widget hydration is fragile under parallel headless tabs.
  // Total time for 5 PDPs ~ 1-2 min which is fine for Phase 1.
  const limit = pLimit(1);

  try {
    const results = await Promise.all(
      urls.map((url, i) => limit(async () => {
        console.log(`  [${i + 1}/${urls.length}] ${url}`);
        const out = await fetchReviewsViaPlaywright(url, browser);
        console.log(`    → ${out.reviewCount} reviews${out.error ? ` (ERROR: ${out.error})` : ''}`);
        return out;
      }))
    );

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

    const totalReviews = results.reduce((s, r) => s + (r.reviewCount || 0), 0);
    const errored = results.filter(r => r.error).length;
    console.log(`\n[Scrape] Wrote ${results.length} result(s) to ${OUTPUT_PATH}`);
    console.log(`[Scrape] Totals — ${totalReviews} reviews captured across ${results.length} PDPs, ${errored} errored`);
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e => {
    console.error('[Scrape] FATAL:', e);
    process.exit(1);
  });
}
