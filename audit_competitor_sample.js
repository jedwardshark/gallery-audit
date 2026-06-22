// One-off: audit a 10-PDP sample from each competitor brand (Vitamix, Breville,
// Williams-Sonoma, Dreame, Dyson). Dyson was previously excluded due to a broken
// extractor; the gallerySelectors + imageHost config fix in 2026-06 restored capture
// to ~18 images/PDP, so it's now in scope.
//
// Sampling: 10 evenly-spaced PDPs from each brand's audit-eligible set, so the sample
// reflects the breadth of each catalog rather than skewing to whichever PDPs happened
// to sort first.
//
// Persistence: writes to data/creative_audit_cache.json after every single audit so a
// mid-run failure (e.g. AI Hub budget cap) doesn't lose completed work. Skips any PDP
// already in the cache — safe to re-run after a partial failure.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { runCreativeAuditForPdp } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GALLERY_PATH = path.join(__dirname, 'data/gallery_raw.json');
const CACHE_PATH   = path.join(__dirname, 'data/creative_audit_cache.json');

const COMPETITORS = ['vitamix', 'breville', 'williamssonoma', 'dreame', 'dyson', 'miele', 'ooni', 'ourplace', 'fellow'];
const PER_BRAND   = 10;
const MIN_IMAGES  = 5;

function sampleEvenly(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  let cache = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) : {};

  // Build per-brand sample list
  const queue = [];
  for (const brand of COMPETITORS) {
    const eligible = data.filter(p =>
      p.brand === brand && Array.isArray(p.images) && p.images.length >= MIN_IMAGES && !p.skipped && !p.error
    );
    const picked = sampleEvenly(eligible, PER_BRAND);
    const fresh = picked.filter(p => !cache[p.url] || cache[p.url].skipped);
    console.log(`[Sample] ${brand.padEnd(15)} eligible=${eligible.length}  picked=${picked.length}  to-audit=${fresh.length}`);
    queue.push(...fresh.map(p => ({ ...p, brandKey: brand })));
  }

  console.log(`\n[Sample] Total audits to run: ${queue.length}`);
  console.log(`[Sample] Estimated cost: ~$${(queue.length * 0.07).toFixed(2)} at raw Anthropic Sonnet pricing\n`);

  let done = 0, errored = 0;
  let budgetCapped = false;
  for (const pdp of queue) {
    const sku = (pdp.url.split('/').pop() || '').replace('.html', '');
    process.stdout.write(`[${done + 1}/${queue.length}] ${pdp.brandKey} · ${sku} … `);
    try {
      const result = await runCreativeAuditForPdp({
        pdpUrl: pdp.url, brandName: pdp.brandName, images: pdp.images, apiKey,
      });
      cache[pdp.url] = result;
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      done++;
      console.log(`score=${result.galleryScore} ${result.readiness}`);
    } catch (e) {
      errored++;
      const msg = (e.message || '').slice(0, 120);
      console.log(`ERROR: ${msg}`);
      if (/402|Tenant budget|budget exhausted/i.test(e.message)) {
        budgetCapped = true;
        console.log('\n[Sample] Budget cap hit — stopping. Re-run when AI Hub budget is restored; it will pick up where it left off (already-cached PDPs are skipped).');
        break;
      }
    }
  }

  console.log(`\n[Sample] Done — audited:${done} errored:${errored}${budgetCapped ? ' (budget cap hit)' : ''}`);

  // Summary by brand
  console.log('\n[Sample] Sample coverage by brand:');
  for (const brand of COMPETITORS) {
    const inCache = Object.entries(cache).filter(([url, v]) => {
      const p = data.find(x => x.url === url);
      return p && p.brand === brand && !v.skipped && v.galleryScore != null;
    });
    console.log(`  ${brand.padEnd(15)} ${inCache.length} audited`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
