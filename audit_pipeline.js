// Phase 4: Bulk Creative Audit + Deterministic Report Generator.
//
// Pipeline:
//   1. Load gallery_raw.json → SharkNinja PDPs
//   2. Load creative_audit_cache.json (existing per-PDP results)
//   3. Pick eligible PDPs (never audited OR gallery image-URL-set changed since last audit)
//   4. Cap at BULK_AUDIT_MAX (default 50)
//   5. Audit each via runCreativeAuditForPdp (server.js export)
//   6. After audit pass: regenerate data/audit_report.json with deterministic stats + Claude narrative
//   7. Commit creative_audit_cache.json + audit_report.json back to GitHub
//
// Why deterministic stats: Claude must NOT invent numbers like "60% missing lifestyle shots".
// We compute every statistic from the structured audit JSON ourselves, then ask Claude to
// write the human-readable narrative around those pre-computed numbers.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import Anthropic from '@anthropic-ai/sdk';
import { runCreativeAuditForPdp } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GALLERY_PATH      = path.join(__dirname, 'data/gallery_raw.json');
const CACHE_PATH        = path.join(__dirname, 'data/creative_audit_cache.json');
const REPORT_PATH       = path.join(__dirname, 'data/audit_report.json');
const AUDIT_JOBS_PATH   = path.join(__dirname, 'data/audit_jobs.json');

const BULK_AUDIT_MAX = parseInt(process.env.BULK_AUDIT_MAX || '50', 10);
// Minimum captured images required to run an audit. PDPs with fewer get a "skipped"
// record so they're visible (potentially a capture bug to investigate) rather than
// silently dropped. Threshold reads p.images.length — the live capture count.
const MIN_IMAGES_FOR_AUDIT = 5;

// Trim — Render's env editor silently appends \n/spaces that ride into the auth header
// and cause 403s on every request. Same defense as refresh.js.
const GH_TOKEN_RAW = process.env.GITHUB_TOKEN || '';
const GH_TOKEN  = GH_TOKEN_RAW.trim();
const GH_REPO   = (process.env.GITHUB_REPO   || '').trim();
const GH_BRANCH = (process.env.GITHUB_BRANCH || 'main').trim();
const GH_TOKEN_HAD_WS = GH_TOKEN_RAW.length !== GH_TOKEN.length;
console.log(`[BulkAudit-Commit] GH_TOKEN length=${GH_TOKEN.length} · whitespace stripped=${GH_TOKEN_HAD_WS} · repo=${GH_REPO} · branch=${GH_BRANCH}`);

// ── Eligibility: who needs an audit this run? ────────────────────────────────
function urlSetSignature(images) {
  return [...(images || [])].map(i => i.src).sort().join('|');
}

function needsAudit(pdp, cachedAudit) {
  if (!cachedAudit) return true;
  // "Gallery changed" = sorted URL set differs. Per user spec, change beats 7-day-stale rule —
  // re-audit immediately when the image set has changed.
  const currentSig = urlSetSignature(pdp.images);
  const cachedSig  = (cachedAudit.auditedImageUrls || []).join('|');
  return currentSig !== cachedSig;
}

function pickEligible(snPdps, cache, max) {
  const eligible = snPdps.filter(p => needsAudit(p, cache[p.url]));
  // Order: never-audited first (most coverage value), then oldest audit first.
  eligible.sort((a, b) => {
    const aCache = cache[a.url], bCache = cache[b.url];
    if (!aCache && !bCache) return 0;
    if (!aCache) return -1;
    if (!bCache) return 1;
    return new Date(aCache.auditedAt) - new Date(bCache.auditedAt);
  });
  return eligible.slice(0, max);
}

// ── Bulk audit pass ──────────────────────────────────────────────────────────
export async function runBulkAuditRolling({ log = (m) => console.log(m) } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');
  if (!fs.existsSync(GALLERY_PATH)) throw new Error('data/gallery_raw.json missing');

  const gallery = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  const snPdps  = gallery.filter(p => p.brand === 'sharkninja' && p.url && !p.error && Array.isArray(p.images) && p.images.length);
  const cache   = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) : {};

  const targets = pickEligible(snPdps, cache, BULK_AUDIT_MAX);
  log(`[BulkAudit] Pool: ${snPdps.length} SharkNinja PDPs · already audited: ${snPdps.filter(p => cache[p.url]).length}`);
  log(`[BulkAudit] This run: ${targets.length} PDPs (cap: BULK_AUDIT_MAX=${BULK_AUDIT_MAX})`);

  let audited = 0, failed = 0, skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const sku = (p.url.split('/').pop() || '').replace('.html', '');
    log(`[BulkAudit] [${i + 1}/${targets.length}] ${sku}`);

    // Guardrail: skip PDPs with too few captured images. Writes a distinct "skipped"
    // record so the viewer can surface "Too few images (N)" — important for spotting
    // under-capture bugs. We still record auditedImageUrls so a future refresh that
    // adds more images will mark the PDP eligible again via the URL-set-diff check.
    const liveImageCount = Array.isArray(p.images) ? p.images.length : 0;
    if (liveImageCount < MIN_IMAGES_FOR_AUDIT) {
      cache[p.url] = {
        skipped:            true,
        skipReason:         'insufficient_images',
        imageCount:         liveImageCount,
        minRequired:        MIN_IMAGES_FOR_AUDIT,
        auditedImageUrls:   [...(p.images || [])].map(img => img.src).sort(),
        skippedAt:          new Date().toISOString(),
      };
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      skipped++;
      log(`[BulkAudit]   SKIPPED — only ${liveImageCount} captured image(s) (min ${MIN_IMAGES_FOR_AUDIT})`);
      continue;
    }

    try {
      const result = await runCreativeAuditForPdp({
        pdpUrl: p.url, brandName: p.brandName, images: p.images, apiKey,
      });
      cache[p.url] = result;
      // Persist after each audit — survives a partial-run failure without losing prior work.
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      audited++;
      log(`[BulkAudit]   score: ${result.galleryScore} · readiness: ${result.readiness}`);
    } catch (e) {
      failed++;
      log(`[BulkAudit]   ERROR: ${e.message}`);
    }
  }

  // Clear the queued-request marker now that we've run, so the UI stops showing "queued".
  if (fs.existsSync(AUDIT_JOBS_PATH)) fs.unlinkSync(AUDIT_JOBS_PATH);

  log(`[BulkAudit] Done — audited:${audited} skipped:${skipped} failed:${failed}`);
  return { audited, failed, totalSnPdps: snPdps.length, eligible: targets.length };
}

// ── Deterministic stat aggregation ───────────────────────────────────────────
function computeStats(cache, snUrls) {
  const audits = snUrls.map(u => cache[u]).filter(Boolean);
  const total = snUrls.length;
  const audited = audits.length;

  if (!audited) {
    return { coverage: { audited: 0, total }, hasData: false };
  }

  const scores = audits.map(a => Number(a.galleryScore)).filter(n => !isNaN(n));
  const avg = scores.reduce((s, n) => s + n, 0) / Math.max(scores.length, 1);

  const readinessCount = { Approved: 0, Conditional: 0, Revise: 0 };
  audits.forEach(a => { if (readinessCount[a.readiness] != null) readinessCount[a.readiness]++; });

  // Beat coverage: % of audited PDPs that PRESENT each beat (not missing it).
  const ALL_BEATS = ['hero', 'lifestyle', 'benefit', 'technical', 'detail', 'social', 'proof'];
  const beatPresenceCounts = Object.fromEntries(ALL_BEATS.map(b => [b, 0]));
  audits.forEach(a => {
    const present = new Set((a.storyArc?.beatsPresent || []).map(s => String(s).toLowerCase()));
    ALL_BEATS.forEach(b => { if (present.has(b)) beatPresenceCounts[b]++; });
  });
  const beatPresenceRates = Object.fromEntries(
    Object.entries(beatPresenceCounts).map(([b, c]) => [b, audited ? c / audited : 0])
  );

  const categoryCount = {};
  audits.forEach(a => {
    const c = a.detectedCategory || 'Unknown';
    categoryCount[c] = (categoryCount[c] || 0) + 1;
  });

  // Top-N worst by gallery score.
  const worst = snUrls
    .map(url => ({ url, audit: cache[url] }))
    .filter(x => x.audit)
    .sort((a, b) => Number(a.audit.galleryScore) - Number(b.audit.galleryScore))
    .slice(0, 15)
    .map(x => {
      const sku = (x.url.split('/').pop() || '').replace('.html', '');
      const criticals = [];
      (x.audit.assets || []).forEach(a => (a.criticalActions || []).forEach(c => criticals.push(c)));
      return {
        url: x.url,
        sku,
        galleryScore: Number(x.audit.galleryScore),
        readiness:    x.audit.readiness,
        category:     x.audit.detectedCategory,
        beatsMissing: x.audit.storyArc?.beatsMissing || [],
        criticalSample: criticals.slice(0, 3),
      };
    });

  // Percentile helper.
  const sorted = [...scores].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;

  return {
    coverage:           { audited, total },
    hasData:            true,
    averageScore:       Number(avg.toFixed(2)),
    scoreDistribution:  readinessCount,
    scorePercentiles:   { p10: pct(0.10), p25: pct(0.25), p50: pct(0.50), p75: pct(0.75), p90: pct(0.90) },
    beatPresenceRates,
    categoryBreakdown:  categoryCount,
    topWorst:           worst,
  };
}

// ── Claude narrative around the pre-computed stats ───────────────────────────
const REPORT_PROMPT = `You are writing an executive-level catalog audit summary for a creative leader at SharkNinja.

You will receive PRE-COMPUTED statistics from a catalog-wide creative audit. DO NOT invent or estimate any new numbers — use only the statistics provided. Your job is to write a clear, prioritized narrative around them.

Structure your response as a JSON object with these exact fields:
{
  "headline": "<one-sentence top-line finding (the most important takeaway from the stats)>",
  "narrative": "<2-3 paragraph executive summary referencing the numbers in the stats payload>",
  "quickWins": [
    { "title": "<short action>", "detail": "<one sentence on why and how>", "supportingStat": "<a specific stat from the payload that supports this>" }
  ],
  "longerTerm": [
    { "title": "<short initiative>", "detail": "<one sentence on scope and expected impact>", "supportingStat": "<a specific stat from the payload>" }
  ]
}

Quick wins are actions doable in 1-2 sprints (e.g. add a missing beat to 10 PDPs). Longer-term items are catalog-wide initiatives (e.g. re-shoot all lifestyle imagery).

Provide 3-5 quick wins and 2-4 longer-term items. Ground every recommendation in a specific number from the payload — do not fabricate.

Respond ONLY with the JSON, no other text.`;

async function generateNarrative(stats) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for report narrative');

  const useBearer = apiKey.startsWith('sn_live_');
  const anthropic = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ...(useBearer ? { authToken: apiKey, apiKey: null } : { apiKey }),
  });

  // Compact payload — send only what's needed, keep token cost low.
  const payload = {
    coverage:           stats.coverage,
    averageScore:       stats.averageScore,
    scoreDistribution:  stats.scoreDistribution,
    scorePercentiles:   stats.scorePercentiles,
    beatPresenceRates:  stats.beatPresenceRates,
    categoryBreakdown:  stats.categoryBreakdown,
    topWorstSummary:    stats.topWorst.slice(0, 10).map(w => ({
      sku: w.sku, score: w.galleryScore, readiness: w.readiness,
      beatsMissing: w.beatsMissing, criticalSample: w.criticalSample,
    })),
  };

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    temperature: 0,
    messages: [{
      role: 'user',
      content: `${REPORT_PROMPT}\n\nStatistics payload:\n${JSON.stringify(payload, null, 2)}`,
    }],
  });

  if (message.stop_reason === 'max_tokens') throw new Error('Narrative truncated (max_tokens)');
  let raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(raw);
}

// ── Report generation ────────────────────────────────────────────────────────
export async function generateAuditReport({ log = (m) => console.log(m) } = {}) {
  if (!fs.existsSync(GALLERY_PATH)) throw new Error('data/gallery_raw.json missing');
  const gallery = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
  const snUrls  = gallery.filter(p => p.brand === 'sharkninja' && p.url && !p.error).map(p => p.url);
  const cache   = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) : {};

  const stats = computeStats(cache, snUrls);
  log(`[Report] Stats computed — coverage ${stats.coverage.audited}/${stats.coverage.total}`);

  if (!stats.hasData) {
    log('[Report] No audits in cache yet — skipping narrative generation');
    return null;
  }

  let narrative = null;
  try {
    narrative = await generateNarrative(stats);
    log(`[Report] Narrative generated — headline: ${narrative.headline}`);
  } catch (e) {
    log(`[Report] Narrative generation failed (non-fatal): ${e.message}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stats,
    narrative,
    disclaimer: 'AI-generated draft — review before acting. Statistics are computed from audit data; narrative and recommendations are LLM-generated and may contain errors.',
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`[Report] Written to ${REPORT_PATH}`);
  return report;
}

// ── GitHub commit-back (mirrors refresh.js pattern) ──────────────────────────
const GH_FILES = ['data/creative_audit_cache.json', 'data/audit_report.json'];

const GH_HEADERS = () => ({
  'Authorization': `Bearer ${GH_TOKEN}`,
  'Accept':        'application/vnd.github+json',
  'User-Agent':    'gallery-audit-bulkaudit',
});

async function ghGetSha(repoPath) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`, { headers: GH_HEADERS() });
  if (r.status === 404) return { sha: null, remoteContent: null };
  if (!r.ok) throw new Error(`GitHub GET ${repoPath} failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return { sha: json.sha, remoteContent: Buffer.from(json.content, 'base64').toString() };
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
  const absPath = path.join(__dirname, repoPath);
  if (!fs.existsSync(absPath)) { console.log(`[BulkAudit-Commit] ${repoPath} missing — skipping`); return; }
  const local = fs.readFileSync(absPath, 'utf8');
  const { sha, remoteContent } = await ghGetSha(repoPath);
  if (remoteContent === local) { console.log(`[BulkAudit-Commit] ${repoPath} unchanged — skipping`); return; }
  await ghPutFile(repoPath, Buffer.from(local, 'utf8').toString('base64'), message, sha);
  console.log(`[BulkAudit-Commit] ${repoPath} pushed`);
}

async function commitArtifacts(summary) {
  if (!GH_TOKEN || !GH_REPO) {
    console.log('[BulkAudit] GITHUB_TOKEN/GITHUB_REPO not set — skipping GitHub commit');
    return;
  }
  const message = `chore(audit): bulk audit — ${summary.audited} audited, coverage ${summary.coverage}`;
  for (const f of GH_FILES) {
    try { await commitFileIfChanged(f, message); }
    catch (e) { console.error(`[BulkAudit-Commit] ${f} failed: ${e.message}`); }
  }
}

// ── CLI entry: invoked by the gallery-audit-bulkaudit cron service ───────────
async function main() {
  // --commit-test: skip the audit loop and just exercise the commit code path with
  // one trivial file. Used to verify GitHub auth in seconds, not hours. Override the
  // cron's Docker Command to "node audit_pipeline.js --commit-test" to use.
  if (process.argv.includes('--commit-test')) {
    const testPath = path.join(__dirname, 'data/_commit_test.txt');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, `commit smoke test at ${new Date().toISOString()}\n`);
    console.log('[Commit-Test] wrote local file, attempting commit via audit_pipeline.js code path…');
    try {
      await commitFileIfChanged('data/_commit_test.txt', `chore: commit smoke test ${new Date().toISOString()}`);
      console.log('[Commit-Test] SUCCESS');
      process.exit(0);
    } catch (e) {
      console.error('[Commit-Test] FAILED:', e.message);
      process.exit(1);
    }
  }

  console.log(`[BulkAudit] Starting at ${new Date().toISOString()}`);
  const auditSummary = await runBulkAuditRolling();
  const report = await generateAuditReport();
  await commitArtifacts({
    audited: auditSummary.audited,
    coverage: report?.stats?.coverage ? `${report.stats.coverage.audited}/${report.stats.coverage.total}` : 'n/a',
  });
  console.log('[BulkAudit] All done');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e => { console.error('[BulkAudit] FATAL:', e); process.exit(1); });
}
