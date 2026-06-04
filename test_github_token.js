// Standalone GitHub-token-write smoke test.
// Verifies GITHUB_TOKEN + GITHUB_REPO can PUT a file via the Contents API.
// Mirrors the commit logic used by refresh.js / audit_pipeline.js / claims_pipeline.js
// but does ONE PUT and exits.
//
// Usage:
//   node test_github_token.js
//
// Env vars (from .env, or set inline before the command):
//   GITHUB_TOKEN   required — fine-grained PAT with Contents: Read and write
//   GITHUB_REPO    required — owner/repo, e.g. jedwardshark/gallery-audit
//   GITHUB_BRANCH  optional — defaults to 'main'

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const TOKEN  = process.env.GITHUB_TOKEN;
const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE   = 'data/_token_test.txt';

if (!TOKEN || !REPO) {
  console.error('FAIL: GITHUB_TOKEN and/or GITHUB_REPO env vars not set');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept:        'application/vnd.github+json',
  'User-Agent':  'gallery-audit-token-test',
};
const url = `https://api.github.com/repos/${REPO}/contents/${FILE}`;

// Step 1: check whether the file already exists — if so, we need its sha to update it.
let sha = null;
const getR = await fetch(`${url}?ref=${BRANCH}`, { headers });
if (getR.status === 200) {
  sha = (await getR.json()).sha;
  console.log(`[GET] 200 — existing file, sha: ${sha.slice(0, 10)}…`);
} else if (getR.status === 404) {
  console.log('[GET] 404 — file does not exist yet (will be created)');
} else {
  console.error(`[GET] ${getR.status} — ${await getR.text()}`);
  process.exit(1);
}

// Step 2: PUT new content.
const timestamp = new Date().toISOString();
const content = `Token write test at ${timestamp}\n`;
const body = {
  message: `chore: token write test at ${timestamp}`,
  content: Buffer.from(content).toString('base64'),
  branch:  BRANCH,
};
if (sha) body.sha = sha;

const putR = await fetch(url, {
  method:  'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body:    JSON.stringify(body),
});

console.log(`\n[PUT] HTTP ${putR.status}`);
console.log(await putR.text());
process.exit(putR.ok ? 0 : 1);
