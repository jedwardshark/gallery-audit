// Standalone weekly refresh entry point — invoked by the Render Cron Job (see render.yaml).
// Runs runFullRefresh(), then commits the updated data files back to GitHub via the Contents API,
// so the next web deploy picks them up. No git CLI required.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { runFullRefresh } from './server.js';
import { runReviewPipelineRolling } from './review_pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Trim aggressively — Render's env var editor (and copy-paste from password managers)
// will silently append \n or spaces, which then ride into the "Bearer ${token}" header
// and cause 403 "Resource not accessible by personal access token" on every request.
const GH_TOKEN_RAW = process.env.GITHUB_TOKEN || '';
const GH_TOKEN  = GH_TOKEN_RAW.trim();
const GH_REPO   = (process.env.GITHUB_REPO   || '').trim();
const GH_BRANCH = (process.env.GITHUB_BRANCH || 'main').trim();
const GH_TOKEN_HAD_WS = GH_TOKEN_RAW.length !== GH_TOKEN.length;
console.log(`[Refresh-Commit] GH_TOKEN length=${GH_TOKEN.length} · whitespace stripped=${GH_TOKEN_HAD_WS} · repo=${GH_REPO} · branch=${GH_BRANCH}`);

const FILES_TO_COMMIT = [
  'data/gallery_raw.json',
  'data/refresh_history.json',
  'data/refresh_config.json',
  'data/reviews_flagged.json',
  // Per-brand URL lists are refreshed by the sitemap re-discovery phase in runFullRefresh.
  // commitFileIfChanged is a no-op for files that don't exist locally, so unused brands here
  // are harmless.
  'data/urls/sharkninja.json',
  'data/urls/vitamix.json',
  'data/urls/breville.json',
  'data/urls/dyson.json',
  'data/urls/williamssonoma.json',
  'data/urls/dreame.json',
  'data/urls/miele.json',
];

// Rolling-window size for the weekly review pipeline. ~75 per week covers all 293
// SharkNinja PDPs in roughly 4 weeks. Override via REVIEW_TARGET_COUNT env if needed.
const REVIEW_TARGET_COUNT = parseInt(process.env.REVIEW_TARGET_COUNT || '75', 10);

const GH_HEADERS = () => ({
  'Authorization': `Bearer ${GH_TOKEN}`,
  'Accept':        'application/vnd.github+json',
  'User-Agent':    'gallery-audit-refresh',
});

async function ghGetSha(repoPath) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`;
  const r = await fetch(url, { headers: GH_HEADERS() });
  if (r.status === 404) return { sha: null, remoteContent: null };
  if (!r.ok) throw new Error(`GitHub GET ${repoPath} failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return { sha: json.sha, remoteContent: Buffer.from(json.content, 'base64').toString() };
}

async function ghPutFile(repoPath, contentBase64, message, sha) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${repoPath}`;
  const body = { message, content: contentBase64, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${repoPath} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function commitFileIfChanged(repoPath, message) {
  const absPath = path.join(__dirname, repoPath);
  if (!fs.existsSync(absPath)) {
    console.log(`[Refresh-Commit] ${repoPath} missing locally — skipping`);
    return;
  }
  const localContent = fs.readFileSync(absPath, 'utf8');
  const { sha, remoteContent } = await ghGetSha(repoPath);
  if (remoteContent === localContent) {
    console.log(`[Refresh-Commit] ${repoPath} unchanged on remote — skipping`);
    return;
  }
  const contentBase64 = Buffer.from(localContent, 'utf8').toString('base64');
  await ghPutFile(repoPath, contentBase64, message, sha);
  console.log(`[Refresh-Commit] ${repoPath} pushed`);
}

async function main() {
  if (!GH_TOKEN || !GH_REPO) {
    console.error('[Refresh] Missing required env vars: GITHUB_TOKEN and GITHUB_REPO (owner/repo)');
    process.exit(1);
  }

  // --commit-test mode: skip the whole refresh and just exercise the commit code path
  // with a trivial file. Used to verify GitHub auth in seconds instead of 90 minutes.
  // Override the cron's Docker Command to "node refresh.js --commit-test" to use it.
  if (process.argv.includes('--commit-test')) {
    const testPath = path.join(__dirname, 'data/_commit_test.txt');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, `commit smoke test at ${new Date().toISOString()}\n`);
    console.log('[Commit-Test] wrote local file, attempting commit via refresh.js code path…');
    try {
      await commitFileIfChanged('data/_commit_test.txt', `chore: commit smoke test ${new Date().toISOString()}`);
      console.log('[Commit-Test] SUCCESS');
      process.exit(0);
    } catch (e) {
      console.error('[Commit-Test] FAILED:', e.message);
      process.exit(1);
    }
  }

  console.log(`[Refresh] Scheduled refresh starting at ${new Date().toISOString()}`);

  const record = await runFullRefresh();
  if (!record) {
    console.error('[Refresh] runFullRefresh returned null — nothing to commit, exiting non-zero');
    process.exit(1);
  }

  // After the gallery refresh, run a rolling-window review scan on SharkNinja PDPs.
  // Failures here are non-fatal — gallery data still gets committed.
  let reviewSummary = null;
  try {
    reviewSummary = await runReviewPipelineRolling({ targetCount: REVIEW_TARGET_COUNT });
  } catch (e) {
    console.error('[Refresh] Review pipeline failed (non-fatal):', e.message);
  }

  const t = record.totals;
  const discoveredTotal = Object.values(record.newlyDiscovered || {}).reduce((s, n) => s + n, 0);
  const discoverySuffix = discoveredTotal > 0
    ? ` · discovered ${discoveredTotal} new SKU(s) from sitemaps`
    : '';
  const reviewSuffix = reviewSummary
    ? ` · reviews: ${reviewSummary.processed} PDPs scanned, ${reviewSummary.totalFlagged} flagged`
    : '';
  const message = `chore(refresh): weekly auto-refresh — +${t.added} new, ${t.changed} changed, ${t.removed} removed${discoverySuffix}${reviewSuffix}`;

  let failures = 0;
  for (const f of FILES_TO_COMMIT) {
    try {
      await commitFileIfChanged(f, message);
    } catch (e) {
      failures++;
      console.error(`[Refresh-Commit] ${f} failed: ${e.message}`);
    }
  }

  if (failures > 0) {
    console.error(`[Refresh] Completed with ${failures} commit failure(s)`);
    process.exit(2);
  }
  console.log('[Refresh] All done');
  process.exit(0);
}

main().catch(e => {
  console.error('[Refresh] FATAL:', e);
  process.exit(1);
});
