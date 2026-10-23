#!/usr/bin/env node
// Comic Studio layout smoke (P1-QA; visualqa.md §7) — `npm run test:layout`.
//
// One command for the per-PR layout regression check (2–3 min on Chromium):
//   1. builds the QA entry (QA_BUILD=1 vite build --outDir dist-qa) unless --no-build;
//   2. runs the Playwright harness (tests/e2e) on the 4 smoke viewports — 360×740, 768×1024,
//      1024×768, 1440×900 — plus the harness self-tests;
//   3. prints a findings summary (new vs allowlisted, by owner package) and appends it to the GitHub
//      step summary when running in Actions.
//
//   node scripts/layout-smoke.mjs [--no-build] [--full] [--project <glob>]... [--update-snapshots] [-- <playwright args>]
//     --full       the whole device matrix (mobile.md §10.2: 14 devices + reflow-320) instead of the smoke
//     --project    extra/alternative Playwright project globs (repeatable)
//
// Environment: QA_OUT_DIR (default dist-qa), QA_ARTIFACTS (default node_modules/.cache/comic-qa),
// QA_CHROMIUM_PATH / PLAYWRIGHT_BROWSERS_PATH (see tests/e2e/playwright.config.ts). The build gets
// FAKE placeholder Supabase values when none are set (the client throws at import on an empty URL;
// the harness never contacts Supabase — it is offline by construction).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const passthroughAt = argv.indexOf('--');
const own = passthroughAt >= 0 ? argv.slice(0, passthroughAt) : argv;
const passthrough = passthroughAt >= 0 ? argv.slice(passthroughAt + 1) : [];
const has = (flag) => own.includes(flag);
const projects = [];
for (let i = 0; i < own.length; i++) if (own[i] === '--project' && own[i + 1]) projects.push(own[++i]);

const env = {
  ...process.env,
  QA_OUT_DIR: process.env.QA_OUT_DIR || 'dist-qa',
  QA_ARTIFACTS: process.env.QA_ARTIFACTS || 'node_modules/.cache/comic-qa',
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key'
};
const outDir = path.resolve(APP, env.QA_OUT_DIR);
const artifacts = path.resolve(APP, env.QA_ARTIFACTS);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const run = (label, cmd, args, extraEnv = {}) => {
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(cmd, args, { cwd: APP, stdio: 'inherit', env: { ...env, ...extraEnv } });
  process.stdout.write(`  ${label}: exit ${res.status ?? res.signal} in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  return res.status ?? 1;
};

// 1. Build the QA entry.
if (!has('--no-build')) {
  const code = run('QA build (QA_BUILD=1 vite build)', npx, ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { QA_BUILD: '1' });
  if (code !== 0) process.exit(code);
} else if (!fs.existsSync(path.join(outDir, 'qa', 'comic-qa.html'))) {
  console.error(`--no-build: ${path.join(outDir, 'qa', 'comic-qa.html')} is missing. Run without --no-build (or npm run qa:build) first.`);
  process.exit(2);
}

// 2. Run the harness.
fs.mkdirSync(artifacts, { recursive: true });
const findingsFile = path.join(artifacts, 'findings.jsonl');
fs.rmSync(findingsFile, { force: true });
const projectArgs = projects.length ? projects : has('--full') ? ['*'] : ['smoke-*', 'harness-selftest'];
const pwArgs = ['playwright', 'test', '-c', 'tests/e2e/playwright.config.ts', ...projectArgs.map((p) => `--project=${p}`)];
if (has('--update-snapshots')) pwArgs.push('--update-snapshots');
pwArgs.push(...passthrough);
const code = run(`Playwright (${projectArgs.join(', ')})`, npx, pwArgs);

// 3. Summarise findings.
const rows = fs.existsSync(findingsFile)
  ? fs
      .readFileSync(findingsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];
const count = (keyOf) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const fresh = rows.filter((r) => r.status === 'NEW');
const lines = [];
lines.push(`## Comic Studio layout ${has('--full') ? 'matrix' : 'smoke'}`);
lines.push('');
lines.push(`Playwright exit code **${code}** · ${rows.length} findings: **${fresh.length} new**, ${rows.length - fresh.length} allowlisted.`);
lines.push('');
if (fresh.length) {
  lines.push('### New findings (fix, or allowlist with an owner tag in `tests/e2e/allowlist.json`)');
  lines.push('');
  lines.push('| project | surface/scene | check | element | detail |');
  lines.push('|---|---|---|---|---|');
  const seen = new Set();
  for (const r of fresh) {
    const key = `${r.check}|${r.sig}|${r.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const esc = (s) => String(s || '').replace(/\|/g, '\\|').slice(0, 90);
    lines.push(`| ${r.project} | ${r.surface}/${r.scene} | ${r.check} | \`${esc(r.sig)}\` ${esc(r.label)} | ${esc(r.detail)} |`);
    if (seen.size >= 60) break;
  }
  lines.push('');
}
const owners = count((r) => (r.status === 'known-failure' ? `${r.owner} · ${r.allowId}` : null)).filter(([k]) => k);
if (owners.length) {
  lines.push('### Known failures still allowlisted (must be gone by wave 3)');
  lines.push('');
  for (const [k, n] of owners) lines.push(`- ${k}: ${n}`);
  lines.push('');
}
lines.push(`Report: \`${path.relative(APP, path.join(artifacts, 'report', 'index.html'))}\` · findings: \`${path.relative(APP, findingsFile)}\``);
const summary = lines.join('\n') + '\n';
fs.writeFileSync(path.join(artifacts, 'summary.md'), summary);
process.stdout.write('\n' + summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(code);
