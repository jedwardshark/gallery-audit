// Phase 3 orchestrator for the weekly review-monitoring pipeline.
//
// Pipeline (rolling-window strategy):
//   1. Load SharkNinja PDP list from data/gallery_raw.json
//   2. Load prior state from data/reviews_flagged.json
//   3. Pick the N oldest-scraped (or never-scraped) PDPs — `targetCount` knob
//   4. For each, scrape reviews via fetchReviewsViaPlaywright (Phase 1)
//   5. Keyword pre-filter + classify each review via classifyOneReview (Phase 2)
//   6. Compute severity per PDP (low=1, medium=2-3, high=4+ flagged)
//   7. Write data/reviews_flagged.json
//
// Output schema:
//   { lastUpdatedAt, pdps: { "<url>": { lastScrapedAt, totalReviews, keywordFiltered,
//                                        flaggedCount, severity, flaggedReviews: [...] } } }
//
// Only flagged reviews are persisted (not all classifications) to keep the committed JSON small.

import { chromium as chromiumStealth } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { fetchReviewsViaPlaywright } from './5_scrape_reviews.js';
import { classifyOneReview }         from './6_classify_reviews.js';

chromiumStealth.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_DATA_PATH = path.join(__dirname, 'data/reviews_flagged.json');
const GALLERY_PATH     = path.join(__dirname, 'data/gallery_raw.json');

const KEYWORD_REGEX = /\b(colou?rs?|photos?|pictures?|images?|looks?|looking|looked|appearances?|shades?|pictured)\b/i;

function severityFor(flaggedCount) {
  if (flaggedCount >= 4) return 'high';
  if (flaggedCount >= 2) return 'medium';
  if (flaggedCount >= 1) return 'low';
  return 'none';
}

function loadState() {
  if (!fs.existsSync(REVIEW_DATA_PATH)) return { lastUpdatedAt: null, pdps: {} };
  const raw = JSON.parse(fs.readFileSync(REVIEW_DATA_PATH, 'utf8'));
  // Tolerate old array-shape from Phase 2 sample by ignoring it.
  if (Array.isArray(raw)) return { lastUpdatedAt: null, pdps: {} };
  return raw;
}

function pickRollingWindow(allUrls, prevState, targetCount) {
  const ranked = allUrls.map(url => ({
    url,
    lastScrapedAt: prevState.pdps[url]?.lastScrapedAt || null,
  })).sort((a, b) => {
    // Never-scraped first, then oldest scraped first.
    if (!a.lastScrapedAt && !b.lastScrapedAt) return 0;
    if (!a.lastScrapedAt) return -1;
    if (!b.lastScrapedAt) return 1;
    return new Date(a.lastScrapedAt) - new Date(b.lastScrapedAt);
  });
  return ranked.slice(0, targetCount).map(r => r.url);
}

export async function runReviewPipelineRolling({ targetCount = 75, log = (m) => console.log(m) } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for review pipeline');
  if (!fs.existsSync(GALLERY_PATH)) throw new Error('data/gallery_raw.json missing — run gallery extractor first');

  const gallery = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  const allUrls = gallery.filter(p => p.brand === 'sharkninja' && p.url && !p.error).map(p => p.url);
  log(`[Reviews] Pool: ${allUrls.length} SharkNinja PDPs`);

  const state = loadState();
  const windowUrls = pickRollingWindow(allUrls, state, targetCount);
  log(`[Reviews] This cycle: ${windowUrls.length} PDPs (targetCount=${targetCount})`);

  const useBearer = apiKey.startsWith('sn_live_');
  const anthropic = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ...(useBearer ? { authToken: apiKey, apiKey: null } : { apiKey }),
  });
  const browser = await chromiumStealth.launch({ headless: true });

  let processed = 0, errors = 0, totalFlagged = 0;

  try {
    for (let i = 0; i < windowUrls.length; i++) {
      const url = windowUrls[i];
      const sku = url.split('/').pop().replace('.html', '');
      log(`[Reviews] [${i + 1}/${windowUrls.length}] ${sku}`);

      try {
        const scrape = await fetchReviewsViaPlaywright(url, browser);
        if (scrape.error) {
          // Record the attempt so this PDP doesn't get re-picked next cycle.
          state.pdps[url] = {
            ...(state.pdps[url] || {}),
            lastScrapedAt: new Date().toISOString(),
            scrapeError: scrape.error,
            totalReviews: 0,
            keywordFiltered: 0,
            flaggedCount: 0,
            severity: 'none',
            flaggedReviews: [],
          };
          errors++;
          log(`[Reviews]   scrape error: ${scrape.error}`);
          continue;
        }

        const candidates = (scrape.reviews || []).filter(r =>
          KEYWORD_REGEX.test(`${r.title || ''} ${r.text || ''}`)
        );

        const flagged = [];
        for (const review of candidates) {
          try {
            const verdict = await classifyOneReview(anthropic, review);
            if (verdict.flagged) {
              flagged.push({
                title:         review.title,
                text:          review.text,
                rating:        review.rating,
                submittedAt:   review.submittedAt,
                confidence:    verdict.confidence,
                reason:        verdict.reason,
                relevantQuote: verdict.relevantQuote,
              });
            }
          } catch (e) {
            log(`[Reviews]   classifier error on "${review.title}": ${e.message}`);
          }
        }

        state.pdps[url] = {
          lastScrapedAt:   new Date().toISOString(),
          totalReviews:    scrape.reviewCount,
          keywordFiltered: candidates.length,
          flaggedCount:    flagged.length,
          severity:        severityFor(flagged.length),
          flaggedReviews:  flagged,
        };

        processed++;
        totalFlagged += flagged.length;
        if (flagged.length) {
          log(`[Reviews]   ${flagged.length} flagged (severity: ${state.pdps[url].severity})`);
        }
      } catch (e) {
        errors++;
        log(`[Reviews]   FATAL on ${sku}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  state.lastUpdatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REVIEW_DATA_PATH), { recursive: true });
  fs.writeFileSync(REVIEW_DATA_PATH, JSON.stringify(state, null, 2));

  const coveredPdps = Object.keys(state.pdps).length;
  log(`[Reviews] Cycle done — processed:${processed} errors:${errors} totalFlagged:${totalFlagged}`);
  log(`[Reviews] Coverage — ${coveredPdps}/${allUrls.length} PDPs have data on disk`);
  return { processed, errors, totalFlagged, coveredPdps, totalPdps: allUrls.length };
}

// CLI entry — allow ad-hoc runs with `node review_pipeline.js [--limit N]`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const limitArg = process.argv.indexOf('--limit');
  const targetCount = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 75;
  runReviewPipelineRolling({ targetCount }).catch(e => {
    console.error('[Reviews] FATAL:', e);
    process.exit(1);
  });
}
