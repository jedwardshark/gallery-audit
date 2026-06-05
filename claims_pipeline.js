// Phase 5: Claim Ownability Pipeline (SharkNinja vs Vitamix, Breville, Dyson).
//
// Stages:
//   1. Rolling-window claim extraction — for each eligible PDP, Claude vision extracts
//      substantive product claims from gallery images (raw + initial normalization).
//      Also a cheap text-only Claude call assigns the PDP a comparable category.
//   2. Vocabulary consolidation (Pass B) — single Claude call merges new normalized
//      strings into a canonical dictionary, then deterministic re-mapping.
//   3. Deterministic ownability stats — computed in plain JS over the canonical claims.
//      Three buckets per claim: OWNABLE (SN only), TABLE STAKES (SN + ≥2 competitors),
//      GAP (≥2 competitors, no SN). GAP-floor of 2 is non-optional.
//   4. Claude narrative — receives the pre-computed stats payload, writes a structured
//      recommendation report. Never invents numbers.
//   5. GitHub commit-back of the three data files.
//
// All ownership claims are "within crawled set" — never absolute. The asymmetry payload
// is surfaced everywhere (SN ~287 vs Dyson 27) so users don't over-read thin-coverage gaps.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GALLERY_PATH    = path.join(__dirname, 'data/gallery_raw.json');
const CLAIMS_PATH     = path.join(__dirname, 'data/claims_extracted.json');
const VOCAB_PATH      = path.join(__dirname, 'data/claims_vocabulary.json');
const REPORT_PATH     = path.join(__dirname, 'data/claims_report.json');

// Per user spec: exclude Williams-Sonoma. SharkNinja + Vitamix + Breville + Dyson only.
const IN_SCOPE_BRANDS = new Set(['sharkninja', 'vitamix', 'breville', 'dyson']);
const COMPETITOR_BRANDS = new Set(['vitamix', 'breville', 'dyson']);

const CLAIM_EXTRACT_MAX = parseInt(process.env.CLAIM_EXTRACT_MAX || '50', 10);
const IMAGES_PER_PDP    = 6;
const GAP_FLOOR         = 2; // ≥2 competitor PDPs required to count as a "gap"

// Trim — Render's env editor silently appends \n/spaces that ride into the auth header
// and cause 403s on every request. Same defense as refresh.js.
const GH_TOKEN_RAW = process.env.GITHUB_TOKEN || '';
const GH_TOKEN  = GH_TOKEN_RAW.trim();
const GH_REPO   = (process.env.GITHUB_REPO   || '').trim();
const GH_BRANCH = (process.env.GITHUB_BRANCH || 'main').trim();
const GH_TOKEN_HAD_WS = GH_TOKEN_RAW.length !== GH_TOKEN.length;
console.log(`[Claims-Commit] GH_TOKEN length=${GH_TOKEN.length} · whitespace stripped=${GH_TOKEN_HAD_WS} · repo=${GH_REPO} · branch=${GH_BRANCH}`);

// Comparable category taxonomy. Categories live across brands so they can be compared.
const CATEGORIES = [
  'espresso/coffee', 'blender', 'vacuum', 'robot vacuum',
  'air fryer', 'air purifier', 'hair dryer', 'hair styler',
  'cooker/multi-cooker', 'heater', 'fan', 'steam iron',
  'knife/cutlery', 'cookware/pots', 'mixer', 'toaster oven',
  'kettle', 'drip coffee maker', 'other',
];

// ── Anthropic client (SharkNinja AI Hub if sn_live_*) ────────────────────────
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');
  const useBearer = apiKey.startsWith('sn_live_');
  return new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ...(useBearer ? { authToken: apiKey, apiKey: null } : { apiKey }),
  });
}

// ── Image fetching (base64 for Claude vision) ────────────────────────────────
async function fetchImageBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const ct = r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  return { data: buf.toString('base64'), mediaType: ct.split(';')[0].trim() };
}

function sampleImages(images, max) {
  if (images.length <= max) return images;
  const step = images.length / max;
  return Array.from({ length: max }, (_, i) => images[Math.floor(i * step)]);
}

// ── Per-PDP claim extraction ────────────────────────────────────────────────
const CLAIM_EXTRACTION_PROMPT = `You are reviewing a brand.com product gallery to extract substantive product claims.

Look at the gallery images for explicit claims about:
- Performance / capability (e.g. "heats in 30 seconds", "lasts 60 minutes", "1500W power")
- Features (e.g. "self-cleaning", "wireless", "smart home compatible")
- Benefits with specifics (e.g. "no preheating required", "removes 99.9% of allergens")
- Awards / certifications (e.g. "Best in Class 2024", "ENERGY STAR")
- Compatibility / inclusions (e.g. "includes 5 attachments", "works with Alexa")

IGNORE generic marketing language without specific claims:
- "Premium quality", "Beautiful design", "Now available", "Modern look" → no
- Color or style descriptors → no
- Pure product names with no claim attached → no

For each claim, normalize it to a concise canonical form. Same claim phrased differently across brands should normalize to the same string. Examples:
- "Heats in 30 seconds" / "30-second heat-up" / "Rapid 30-second warmup" → "30-second heat-up"
- "Self-cleaning cycle" / "Auto-clean" / "Easy clean function" → "self-cleaning"
- "Works with Alexa, Google Home, Apple HomeKit" → "smart home compatible"

Tag evidence_type:
- "callout": text overlay or feature label on image
- "badge": award seal, certification icon
- "infographic": dedicated spec/feature graphic
- "lifestyle": claim implied by how product is shown in use
- "product": claim visible on product itself

Return ONLY JSON (no markdown, no commentary):
{
  "claims": [
    { "raw": "<as it appears or paraphrased close>", "normalized": "<concise canonical form, lowercase>", "evidence_type": "callout|badge|infographic|lifestyle|product" }
  ]
}

Be conservative — only extract claims that are clearly stated, not merely implied. If you see no substantive claims, return { "claims": [] }.`;

async function extractClaimsForPdp(anthropic, pdp) {
  const sampled = sampleImages(pdp.images, IMAGES_PER_PDP);
  const imageBlocks = (await Promise.all(
    sampled.map(async img => {
      try {
        const { data, mediaType } = await fetchImageBase64(img.src);
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      } catch { return null; }
    })
  )).filter(Boolean);

  if (!imageBlocks.length) throw new Error('Could not fetch any gallery images');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        { type: 'text', text: `${CLAIM_EXTRACTION_PROMPT}\n\nBrand: ${pdp.brandName}\nPDP: ${pdp.url}` },
      ],
    }],
  });

  if (message.stop_reason === 'max_tokens') throw new Error('Claim extraction truncated');
  const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.claims) ? parsed.claims : [];
}

// ── Category derivation (text-only, cheap) ──────────────────────────────────
async function classifyCategory(anthropic, pdp) {
  const familyHint = pdp.family || pdp.category || '';
  const prompt = `Classify this product into ONE of these categories: ${CATEGORIES.join(', ')}.

URL: ${pdp.url}
Product family slug: ${familyHint}
Brand: ${pdp.brandName}

Return ONLY the single category string from the list above (lowercase). Use "other" if none fit. No other text.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 32,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  const cat = message.content[0].text.trim().toLowerCase();
  return CATEGORIES.includes(cat) ? cat : 'other';
}

// ── Eligibility (rolling-window picker) ──────────────────────────────────────
function urlSetSignature(images) {
  return [...(images || [])].map(i => i.src).sort().join('|');
}

function pickEligible(pdps, state, max) {
  const eligible = pdps.filter(p => {
    const prev = state.pdps[p.url];
    if (!prev) return true;
    return urlSetSignature(p.images) !== (prev.extractedImageUrls || []).join('|');
  });
  eligible.sort((a, b) => {
    // Primary: SharkNinja first across all eligibility tiers. SN data is always priority.
    const aSN = a.brand === 'sharkninja' ? 0 : 1;
    const bSN = b.brand === 'sharkninja' ? 0 : 1;
    if (aSN !== bSN) return aSN - bSN;
    // Secondary (unchanged): never-extracted first, then oldest-extracted first.
    const ap = state.pdps[a.url], bp = state.pdps[b.url];
    if (!ap && !bp) return 0;
    if (!ap) return -1;
    if (!bp) return 1;
    return new Date(ap.lastExtractedAt) - new Date(bp.lastExtractedAt);
  });
  return eligible.slice(0, max);
}

// ── Stage 1: extraction pass ────────────────────────────────────────────────
export async function runClaimsExtractionRolling({ log = (m) => console.log(m) } = {}) {
  if (!fs.existsSync(GALLERY_PATH)) throw new Error('data/gallery_raw.json missing');
  const gallery = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  const pool = gallery.filter(p =>
    IN_SCOPE_BRANDS.has(p.brand) && p.url && !p.error && Array.isArray(p.images) && p.images.length
  );

  const state = fs.existsSync(CLAIMS_PATH)
    ? JSON.parse(fs.readFileSync(CLAIMS_PATH, 'utf8'))
    : { lastUpdatedAt: null, pdps: {} };

  const targets = pickEligible(pool, state, CLAIM_EXTRACT_MAX);
  log(`[Claims] In-scope pool: ${pool.length} PDPs · already extracted: ${pool.filter(p => state.pdps[p.url]).length}`);
  log(`[Claims] This run: ${targets.length} PDPs (cap: CLAIM_EXTRACT_MAX=${CLAIM_EXTRACT_MAX})`);

  const anthropic = getClient();
  let extracted = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const pdp = targets[i];
    const sku = (pdp.url.split('/').pop() || '').replace('.html', '');
    log(`[Claims] [${i + 1}/${targets.length}] ${pdp.brand} · ${sku}`);

    try {
      const [claims, category] = await Promise.all([
        extractClaimsForPdp(anthropic, pdp),
        classifyCategory(anthropic, pdp),
      ]);

      state.pdps[pdp.url] = {
        lastExtractedAt:    new Date().toISOString(),
        brand:              pdp.brand,
        brandName:          pdp.brandName,
        category,
        claims,
        extractedImageUrls: [...pdp.images].map(i => i.src).sort(),
      };
      // Persist incrementally so a mid-run crash doesn't lose work.
      fs.writeFileSync(CLAIMS_PATH, JSON.stringify(state, null, 2));
      extracted++;
      log(`[Claims]   category: ${category} · claims: ${claims.length}`);
    } catch (e) {
      failed++;
      log(`[Claims]   ERROR: ${e.message}`);
    }
  }

  state.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(CLAIMS_PATH, JSON.stringify(state, null, 2));
  log(`[Claims] Extraction done — extracted:${extracted} failed:${failed}`);
  return { extracted, failed, poolSize: pool.length };
}

// ── Stage 2: vocabulary consolidation (Pass B) ──────────────────────────────
const VOCAB_PROMPT = `You are consolidating product-claim vocabulary across a competitive product catalog.

Below is the EXISTING canonical claim vocabulary (canonical_form → known variants), followed by a list of NEW normalized claim strings that may need to merge with existing entries or with each other.

EXISTING CANONICAL VOCABULARY:
{{EXISTING}}

NEW NORMALIZED STRINGS TO MERGE:
{{NEW}}

For each new string, decide:
1. If it semantically matches an existing canonical, add it as a variant.
2. If it's a new distinct claim, create a new canonical entry.
3. If multiple new strings represent the same claim, group them under one new canonical.

Be CONSERVATIVE about merging — when in doubt, keep separate. Two phrasings should only merge if they clearly describe the same physical claim (not just adjacent claims).

Return the UPDATED canonical vocabulary as JSON. Preserve all existing canonical entries; only ADD variants or new canonicals. Do not remove anything.

{
  "<canonical_form>": ["variant1", "variant2", ...]
}

Respond ONLY with the JSON, no other text.`;

export async function consolidateClaimsVocabulary({ log = (m) => console.log(m) } = {}) {
  if (!fs.existsSync(CLAIMS_PATH)) {
    log('[Vocab] No claims file — skipping consolidation');
    return null;
  }
  const claimsState = JSON.parse(fs.readFileSync(CLAIMS_PATH, 'utf8'));
  const existing = fs.existsSync(VOCAB_PATH)
    ? JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'))
    : { lastUpdatedAt: null, canonical: {}, reverse: {} };

  // Collect every unique normalized string currently in the dataset.
  const seenNormalized = new Set();
  Object.values(claimsState.pdps || {}).forEach(p => {
    (p.claims || []).forEach(c => {
      if (c.normalized) seenNormalized.add(String(c.normalized).toLowerCase().trim());
    });
  });

  // Identify which ones are NEW (not already mapped in vocab.reverse).
  const newStrings = [...seenNormalized].filter(s => !existing.reverse[s]);
  log(`[Vocab] ${seenNormalized.size} distinct normalized strings · ${newStrings.length} new`);

  if (!newStrings.length) {
    log('[Vocab] No new strings — vocabulary unchanged');
    return existing;
  }

  const anthropic = getClient();
  const prompt = VOCAB_PROMPT
    .replace('{{EXISTING}}', JSON.stringify(existing.canonical, null, 2))
    .replace('{{NEW}}',      JSON.stringify(newStrings, null, 2));

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  if (message.stop_reason === 'max_tokens') throw new Error('Vocab consolidation truncated');
  const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const updatedCanonical = JSON.parse(raw);

  // Rebuild the deterministic reverse map (variant -> canonical).
  const reverse = {};
  for (const [canon, variants] of Object.entries(updatedCanonical)) {
    reverse[canon.toLowerCase().trim()] = canon;
    (variants || []).forEach(v => { reverse[String(v).toLowerCase().trim()] = canon; });
  }
  // Backstop: ensure every observed string maps to SOMETHING (use the string itself if Claude missed it).
  for (const s of seenNormalized) {
    if (!reverse[s]) reverse[s] = s;
  }

  const vocab = { lastUpdatedAt: new Date().toISOString(), canonical: updatedCanonical, reverse };
  fs.writeFileSync(VOCAB_PATH, JSON.stringify(vocab, null, 2));
  log(`[Vocab] Canonical entries: ${Object.keys(updatedCanonical).length}`);
  return vocab;
}

// ── Stage 3: deterministic ownability stats ─────────────────────────────────
function canonicalize(normalizedStr, vocab) {
  const key = String(normalizedStr || '').toLowerCase().trim();
  return vocab.reverse[key] || key;
}

function computeOwnabilityStats(claimsState, vocab) {
  const pdps = Object.entries(claimsState.pdps || {});
  const asymmetry = {};
  pdps.forEach(([, p]) => { asymmetry[p.brand] = (asymmetry[p.brand] || 0) + 1; });

  // claim → { byBrand: { sharkninja: Set<url>, vitamix: Set<url>, ... }, byCategory: { espresso: { brand: Set<url> } } }
  const claimIndex = new Map();
  for (const [url, p] of pdps) {
    const seen = new Set();
    for (const c of p.claims || []) {
      const canon = canonicalize(c.normalized, vocab);
      if (!canon || seen.has(canon)) continue; // de-dupe per-PDP
      seen.add(canon);
      if (!claimIndex.has(canon)) claimIndex.set(canon, { byBrand: {}, byCategory: {} });
      const entry = claimIndex.get(canon);
      entry.byBrand[p.brand] = entry.byBrand[p.brand] || new Set();
      entry.byBrand[p.brand].add(url);
      const cat = p.category || 'other';
      entry.byCategory[cat] = entry.byCategory[cat] || {};
      entry.byCategory[cat][p.brand] = entry.byCategory[cat][p.brand] || new Set();
      entry.byCategory[cat][p.brand].add(url);
    }
  }

  // Pooled bucketing.
  const pooled = { ownable: [], tableStakes: [], gaps: [] };
  for (const [claim, entry] of claimIndex) {
    const snCount = entry.byBrand.sharkninja ? entry.byBrand.sharkninja.size : 0;
    let compCount = 0;
    const byCompetitor = {};
    for (const b of COMPETITOR_BRANDS) {
      const n = entry.byBrand[b] ? entry.byBrand[b].size : 0;
      byCompetitor[b] = n;
      compCount += n;
    }
    const row = { claim, sharkninjaPdps: snCount, competitorPdps: compCount, byCompetitor };
    if (snCount > 0 && compCount === 0) pooled.ownable.push(row);
    else if (snCount > 0 && compCount >= GAP_FLOOR) pooled.tableStakes.push(row);
    else if (snCount === 0 && compCount >= GAP_FLOOR) pooled.gaps.push(row);
    // claims with compCount = 1 fall below the floor → dropped from bucketing (too noisy)
  }
  pooled.ownable.sort((a, b) => b.sharkninjaPdps - a.sharkninjaPdps);
  pooled.gaps.sort((a, b) => b.competitorPdps - a.competitorPdps);
  pooled.tableStakes.sort((a, b) => (b.sharkninjaPdps + b.competitorPdps) - (a.sharkninjaPdps + a.competitorPdps));

  // Per-category bucketing (only categories with both SN and ≥1 competitor PDP get analyzed).
  const allCategories = new Set();
  for (const [, p] of pdps) allCategories.add(p.category || 'other');

  const byCategory = {};
  for (const cat of allCategories) {
    const snPdpsInCat   = pdps.filter(([, p]) => p.category === cat && p.brand === 'sharkninja').length;
    const compPdpsInCat = pdps.filter(([, p]) => p.category === cat && COMPETITOR_BRANDS.has(p.brand)).length;
    if (snPdpsInCat === 0 && compPdpsInCat === 0) continue;

    const ownable = [], tableStakes = [], gaps = [];
    for (const [claim, entry] of claimIndex) {
      const inCat = entry.byCategory[cat];
      if (!inCat) continue;
      const snC = inCat.sharkninja ? inCat.sharkninja.size : 0;
      let compC = 0;
      for (const b of COMPETITOR_BRANDS) compC += inCat[b] ? inCat[b].size : 0;
      const row = { claim, sharkninjaPdps: snC, competitorPdps: compC };
      if (snC > 0 && compC === 0) ownable.push(row);
      else if (snC > 0 && compC >= GAP_FLOOR) tableStakes.push(row);
      else if (snC === 0 && compC >= GAP_FLOOR) gaps.push(row);
    }
    ownable.sort((a, b) => b.sharkninjaPdps - a.sharkninjaPdps);
    gaps.sort((a, b) => b.competitorPdps - a.competitorPdps);
    byCategory[cat] = { sharkninjaPdps: snPdpsInCat, competitorPdps: compPdpsInCat, ownable, tableStakes, gaps };
  }

  return {
    asymmetry,
    totalCanonicalClaims: claimIndex.size,
    pooled,
    byCategory,
  };
}

// ── Stage 4: Claude narrative ───────────────────────────────────────────────
const NARRATIVE_PROMPT = `You are writing an executive summary of a competitive claim-ownability analysis for SharkNinja's creative leadership.

You will receive PRE-COMPUTED statistics. DO NOT invent or estimate any numbers — use only what's in the payload.

CRITICAL CAVEAT to weave into your narrative:
- All analysis is "within crawled set" — emphasize this when referencing competitor gaps.
- Coverage is asymmetric (see "asymmetry" field) so gaps where competitors have thin crawl coverage may be artifacts of crawl thinness, not real positioning gaps.

Structure response as JSON:
{
  "headline": "<one sentence top-line finding>",
  "narrative": "<2-3 paragraphs grounding numbers in the data, with the 'within crawled set' caveat noted>",
  "quickWins": [
    { "title": "<short action>", "detail": "<why and how, ≤1 sentence>", "supportingStat": "<specific number quoted from payload>" }
  ],
  "longerTerm": [
    { "title": "<short initiative>", "detail": "<scope and impact>", "supportingStat": "<specific number from payload>" }
  ]
}

3-5 quick wins (e.g. "Add 'rapid heat-up' claim — present on 5 of 8 competitor espresso PDPs but 0 SharkNinja PDPs").
2-4 longer-term items.

Ground every recommendation in a specific stat. Always say "within crawled set" when citing competitor gaps. Don't fabricate.

Respond ONLY with the JSON, no other text.`;

async function generateNarrative(stats) {
  const anthropic = getClient();
  const payload = {
    asymmetry:           stats.asymmetry,
    totalCanonicalClaims: stats.totalCanonicalClaims,
    topGaps:             stats.pooled.gaps.slice(0, 12),
    topOwnable:          stats.pooled.ownable.slice(0, 12),
    topTableStakes:      stats.pooled.tableStakes.slice(0, 8),
    categoriesWithBoth:  Object.entries(stats.byCategory)
      .filter(([, c]) => c.sharkninjaPdps > 0 && c.competitorPdps > 0)
      .map(([cat, c]) => ({
        category: cat, sharkninjaPdps: c.sharkninjaPdps, competitorPdps: c.competitorPdps,
        topGaps: c.gaps.slice(0, 5), topOwnable: c.ownable.slice(0, 5),
      })),
  };

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    temperature: 0,
    messages: [{ role: 'user', content: `${NARRATIVE_PROMPT}\n\nStatistics payload:\n${JSON.stringify(payload, null, 2)}` }],
  });
  if (message.stop_reason === 'max_tokens') throw new Error('Narrative truncated');
  const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(raw);
}

// ── Report generation ──────────────────────────────────────────────────────
export async function generateClaimsReport({ log = (m) => console.log(m) } = {}) {
  if (!fs.existsSync(CLAIMS_PATH)) {
    log('[Report] No claims data yet');
    return null;
  }
  const claimsState = JSON.parse(fs.readFileSync(CLAIMS_PATH, 'utf8'));
  const vocab = fs.existsSync(VOCAB_PATH)
    ? JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'))
    : { canonical: {}, reverse: {} };

  const stats = computeOwnabilityStats(claimsState, vocab);
  log(`[Report] ${stats.totalCanonicalClaims} canonical claims · ${stats.pooled.gaps.length} gaps · ${stats.pooled.ownable.length} ownable`);

  let narrative = null;
  if (stats.totalCanonicalClaims > 0) {
    try { narrative = await generateNarrative(stats); }
    catch (e) { log(`[Report] Narrative failed (non-fatal): ${e.message}`); }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    asymmetry:   stats.asymmetry,
    gapFloor:    GAP_FLOOR,
    stats,
    narrative,
    disclaimer:  'AI draft — review before acting. All findings are within the crawled set only and not claims of absolute ownability. Coverage is asymmetric across brands (see asymmetry payload).',
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`[Report] Written to ${REPORT_PATH}`);
  return report;
}

// ── GitHub commit-back ──────────────────────────────────────────────────────
const GH_FILES = [
  'data/claims_extracted.json',
  'data/claims_vocabulary.json',
  'data/claims_report.json',
];

const GH_HEADERS = () => ({
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept:        'application/vnd.github+json',
  'User-Agent':  'gallery-audit-claims',
});

async function ghGetSha(repoPath) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`, { headers: GH_HEADERS() });
  if (r.status === 404) return { sha: null, remoteContent: null };
  if (!r.ok) throw new Error(`GitHub GET ${repoPath} failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { sha: j.sha, remoteContent: Buffer.from(j.content, 'base64').toString() };
}

async function ghPutFile(repoPath, contentBase64, message, sha) {
  const body = { message, content: contentBase64, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${repoPath}`, {
    method: 'PUT',
    headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${repoPath} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function commitFileIfChanged(repoPath, message) {
  const abs = path.join(__dirname, repoPath);
  if (!fs.existsSync(abs)) { console.log(`[Claims-Commit] ${repoPath} missing — skipping`); return; }
  const local = fs.readFileSync(abs, 'utf8');
  const { sha, remoteContent } = await ghGetSha(repoPath);
  if (remoteContent === local) { console.log(`[Claims-Commit] ${repoPath} unchanged — skipping`); return; }
  await ghPutFile(repoPath, Buffer.from(local, 'utf8').toString('base64'), message, sha);
  console.log(`[Claims-Commit] ${repoPath} pushed`);
}

async function commitArtifacts(summary) {
  if (!GH_TOKEN || !GH_REPO) { console.log('[Claims] No GH creds — skipping commit'); return; }
  const message = `chore(claims): weekly extraction — ${summary.extracted} new PDPs, ${summary.totalCanonicalClaims} canonical claims`;
  for (const f of GH_FILES) {
    try { await commitFileIfChanged(f, message); }
    catch (e) { console.error(`[Claims-Commit] ${f} failed: ${e.message}`); }
  }
}

// ── CLI entry (invoked by gallery-audit-claims cron) ────────────────────────
async function main() {
  // --commit-test: skip the extraction loop and just exercise the commit code path
  // with one trivial file. Override the cron's Docker Command to
  // "node claims_pipeline.js --commit-test" to use.
  if (process.argv.includes('--commit-test')) {
    const testPath = path.join(__dirname, 'data/_commit_test.txt');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, `commit smoke test at ${new Date().toISOString()}\n`);
    console.log('[Commit-Test] wrote local file, attempting commit via claims_pipeline.js code path…');
    try {
      await commitFileIfChanged('data/_commit_test.txt', `chore: commit smoke test ${new Date().toISOString()}`);
      console.log('[Commit-Test] SUCCESS');
      process.exit(0);
    } catch (e) {
      console.error('[Commit-Test] FAILED:', e.message);
      process.exit(1);
    }
  }

  console.log(`[Claims] Starting at ${new Date().toISOString()}`);
  const extractSummary = await runClaimsExtractionRolling();
  if (extractSummary.extracted > 0) {
    await consolidateClaimsVocabulary();
  } else {
    console.log('[Claims] No new extractions — skipping vocabulary consolidation');
  }
  const report = await generateClaimsReport();
  await commitArtifacts({
    extracted: extractSummary.extracted,
    totalCanonicalClaims: report?.stats?.totalCanonicalClaims ?? 0,
  });
  console.log('[Claims] All done');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(e => { console.error('[Claims] FATAL:', e); process.exit(1); });
