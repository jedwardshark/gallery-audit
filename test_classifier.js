// Synthetic precision test for the Phase 2 classifier.
// Confirms the classifier flags clear positive cases AND resists false positives
// on adjacent-but-different complaints (durability, aesthetic preference).
//
// Expected outcomes are hardcoded so the test self-reports pass/fail.

import Anthropic from '@anthropic-ai/sdk';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { classifyOneReview } from './6_classify_reviews.js';

const CASES = [
  {
    label: 'A. Clear positive — explicit photo reference',
    expectFlagged: true,
    review: {
      title: 'Color is wrong',
      text:  'The actual color is way more purple than what\'s shown on the website. Looks nothing like the photos.',
      rating: 1,
    },
  },
  {
    label: 'B. Durability — color word but not photo discrepancy',
    expectFlagged: false,
    review: {
      title: 'Finish faded',
      text:  'The color faded after 6 months of use. Disappointed in the durability — looks worn out already.',
      rating: 2,
    },
  },
  {
    label: 'C. Aesthetic preference — no photo claim',
    expectFlagged: false,
    review: {
      title: 'Not my taste',
      text:  'I just don\'t like the color. It\'s not my taste. Should have looked more carefully before ordering.',
      rating: 3,
    },
  },
  {
    label: 'D. Positive — implicit photo reference, no "photo" word',
    expectFlagged: true,
    review: {
      title: 'Misleading',
      text:  'Showed up looking completely different from what was advertised online. The pictures must have been heavily edited or under different lighting.',
      rating: 1,
    },
  },
];

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }
  const useBearer = apiKey.startsWith('sn_live_');
  const anthropic = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ...(useBearer ? { authToken: apiKey, apiKey: null } : { apiKey }),
  });

  let passed = 0, failed = 0;
  for (const c of CASES) {
    console.log('\n── ' + c.label);
    console.log('   Expect flagged=' + c.expectFlagged);
    try {
      const verdict = await classifyOneReview(anthropic, c.review);
      const ok = verdict.flagged === c.expectFlagged;
      console.log(`   Got      flagged=${verdict.flagged} (${verdict.confidence})  ${ok ? 'PASS' : 'FAIL'}`);
      console.log('   Reason:  ' + verdict.reason);
      if (verdict.relevantQuote) console.log('   Quote:   "' + verdict.relevantQuote + '"');
      if (ok) passed++; else failed++;
    } catch (e) {
      console.log('   ERROR: ' + e.message);
      failed++;
    }
  }

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`Result: ${passed} pass, ${failed} fail (of ${CASES.length})`);
  process.exit(failed > 0 ? 1 : 0);
})();
