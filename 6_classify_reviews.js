// Phase 2: Classify customer reviews for listing-photo mismatch complaints.
//
// Pipeline:
//   data/reviews_sample.json (from 5_scrape_reviews.js)
//     ↓ keyword pre-filter (color/photo/picture/image/looks/appearance/shade)
//     ↓ Claude classification (sonnet-4-6 via SharkNinja AI Hub if sn_live_* token)
//   data/reviews_flagged.json
//
// For each filtered review Claude returns: flagged, confidence, reason, relevant_quote
//
// Usage:
//   node 6_classify_reviews.js                # uses data/reviews_sample.json as input
//   node 6_classify_reviews.js --input <p>    # custom input file
//   node 6_classify_reviews.js --output <p>   # custom output file

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUT  = path.join(__dirname, 'data/reviews_sample.json');
const DEFAULT_OUTPUT = path.join(__dirname, 'data/reviews_flagged.json');

// ── Keyword pre-filter ────────────────────────────────────────────────────────
// Word-boundary regex catches singular/plural, US/UK spelling, common verb forms
// of: color, photo, picture, image, looks, appearance, shade, pictured.
const KEYWORD_REGEX = /\b(colou?rs?|photos?|pictures?|images?|looks?|looking|looked|appearances?|shades?|pictured)\b/i;

function passesKeywordFilter(review) {
  return KEYWORD_REGEX.test(`${review.title || ''} ${review.text || ''}`);
}

// ── Classifier prompt ─────────────────────────────────────────────────────────
const CLASSIFIER_PROMPT = `You are reviewing customer reviews to identify complaints SPECIFICALLY about a visual mismatch between the product's listing photos on the website and what the customer actually received.

Flag a review ONLY if ALL of these are true:
1. It is a complaint (negative tone about the visual mismatch).
2. It refers to the website photos / pictures / images / listing / "what was advertised" — explicitly or by clear implication.
3. It claims the actual product looks different from those photos.

DO NOT flag reviews that:
- Complain about color FADING, scratching, peeling, or wearing over time (durability issue, not photo accuracy).
- Express aesthetic preferences without mentioning the photos ("I don't like the color").
- Are about product PERFORMANCE, FUNCTION, or BUILD QUALITY.
- Mention color/photo/picture in passing without claiming a discrepancy.
- Use color positively.

When in doubt, prefer NOT flagging. Precision matters more than recall.

Return ONLY a JSON object with these exact fields (no markdown, no other text):
{
  "flagged": <boolean>,
  "confidence": "low" | "medium" | "high",
  "reason": "<one sentence explaining your decision>",
  "relevant_quote": "<the specific text from the review that triggered the flag, or empty string if not flagged>"
}`;

// ── Claude call (per review) ──────────────────────────────────────────────────
export async function classifyOneReview(anthropic, review) {
  const userPrompt = `${CLASSIFIER_PROMPT}

Review to analyze:
Title: ${review.title || '(no title)'}
Body: ${review.text || ''}
Rating: ${review.rating ?? '(no rating)'}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    temperature: 0,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Response hit max_tokens (truncated)`);
  }

  let raw = message.content[0].text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const parsed = JSON.parse(raw);
  return {
    flagged:       Boolean(parsed.flagged),
    confidence:    parsed.confidence || 'low',
    reason:        parsed.reason || '',
    relevantQuote: parsed.relevant_quote || parsed.relevantQuote || '',
  };
}

// ── Args ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--input')  args.input  = path.resolve(argv[++i]);
    else if (argv[i] === '--output') args.output = path.resolve(argv[++i]);
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[Classify] ANTHROPIC_API_KEY env var required');
    process.exit(1);
  }
  if (!fs.existsSync(args.input)) {
    console.error(`[Classify] Input not found: ${args.input}. Run 5_scrape_reviews.js first.`);
    process.exit(1);
  }

  // Mirror the same auth-mode detection used by server.js for the AI Hub.
  const useBearer = apiKey.startsWith('sn_live_');
  const anthropic = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ...(useBearer ? { authToken: apiKey, apiKey: null } : { apiKey }),
  });

  const pdps = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const output = [];

  for (const pdp of pdps) {
    const sku = (pdp.url || '').split('/').pop().replace('.html', '');
    console.log(`\n[Classify] ${sku}`);

    const reviews = pdp.reviews || [];
    const filtered = reviews.filter(passesKeywordFilter);
    console.log(`  ${reviews.length} reviews → ${filtered.length} passed keyword filter`);

    const classifications = [];
    for (const review of filtered) {
      try {
        const verdict = await classifyOneReview(anthropic, review);
        classifications.push({
          title:         review.title,
          text:          review.text,
          rating:        review.rating,
          submittedAt:   review.submittedAt,
          flagged:       verdict.flagged,
          confidence:    verdict.confidence,
          reason:        verdict.reason,
          relevantQuote: verdict.relevantQuote,
        });
        if (verdict.flagged) {
          console.log(`  [FLAGGED ${verdict.confidence}] "${review.title}" — ${verdict.reason}`);
        }
      } catch (e) {
        console.error(`  [ERROR] classifying "${review.title}": ${e.message}`);
        classifications.push({
          title:         review.title,
          text:          review.text,
          rating:        review.rating,
          submittedAt:   review.submittedAt,
          classifyError: e.message,
        });
      }
    }

    output.push({
      url:               pdp.url,
      totalReviews:      pdp.reviewCount ?? reviews.length,
      keywordFiltered:   filtered.length,
      flaggedCount:      classifications.filter(c => c.flagged).length,
      classifications,
    });
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2));

  const totalFiltered = output.reduce((s, p) => s + p.keywordFiltered, 0);
  const totalFlagged  = output.reduce((s, p) => s + p.flaggedCount, 0);
  console.log(`\n[Classify] Done. ${totalFiltered} reviews classified, ${totalFlagged} flagged.`);
  console.log(`[Classify] Output: ${args.output}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e => {
    console.error('[Classify] FATAL:', e);
    process.exit(1);
  });
}
