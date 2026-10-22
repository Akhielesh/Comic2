#!/usr/bin/env node
// Daily Stream Studio cost watch (ADR 0007 D3; docs/features/stream-studio-costs.md §3.2 "alert delivery").
//
// Run by .github/workflows/stream-cost-watch.yml once a day:
//   npx --yes tsx@4.19.2 dreamstreamcomicstudio/scripts/ops/streamCostWatch.mjs
//
//   1. Reads Cloudflare's own analytics (GraphQL + the rooms' Analytics Engine points) with the
//      READ-ONLY token in the CF_ANALYTICS_API_TOKEN secret — the same reads as Admin → Costs.
//      It never calls the backend, so the container stays asleep, and sends no email.
//   2. Evaluates the same pure alert rules as the Cost centre (shared/stream/usage.ts), including the
//      owner's TURN-at-$10/month alert.
//   3. Opens, updates or closes ONE GitHub issue (label `stream-cost-watch`) — only when the set of
//      firing alerts changes. GitHub's own notification is the owner's email. No change → no write.
//
// No secrets → a clear log line and exit 0 (a no-op), never a failed run.

import { pathToFileURL } from 'node:url';

export const LABEL = 'stream-cost-watch';
export const TITLE = 'Stream Studio cost watch';
const MARKER = 'stream-cost-watch-state';
const STATE_RE = new RegExp(`<!-- ${MARKER}: (\\[.*?\\]) -->`);

/** The alert state that matters for a diff: ids with their severity, sorted. */
export const stateOf = (alerts) => [...new Set(alerts.map((a) => `${a.id}:${a.severity}`))].sort();

/** The state saved in an issue body (or [] for none / an unreadable body). */
export function readState(body) {
  const m = STATE_RE.exec(String(body ?? ''));
  if (!m) return [];
  try {
    const v = JSON.parse(m[1]);
    return Array.isArray(v) ? v.map(String).sort() : [];
  } catch {
    return [];
  }
}

const sameState = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The issue body: what fires and why, then where to look. Carries the state marker. */
export function renderBody(alerts, ctx = {}) {
  const lines = [
    `Checked ${ctx.checkedAt ?? new Date().toISOString()} from Cloudflare's own analytics (month to date, account-wide).`,
    '',
    ...alerts.map((a) => `- **${a.severity === 'critical' ? 'Critical' : 'Warning'} — ${a.title}.** ${a.cause}`),
    '',
    'Where to look: Admin → Costs → Stream Studio. Runbook: `dreamstreamcomicstudio/docs/infrastructure/COST_RUNBOOK.md` §1.',
    'Backstop: the Cloudflare account budget alert (Billing → budget alerts). Stream Studio never charges users; limits never cut baby-monitor sound or alerts.',
    '',
    `<!-- ${MARKER}: ${JSON.stringify(stateOf(alerts))} -->`
  ];
  return lines.join('\n');
}

/**
 * What to do with the watch issue. `issue` is the open one (or null). Only a change in the set of
 * firing alerts (or a severity) writes anything.
 */
export function planIssueAction(issue, alerts, ctx = {}) {
  const prev = issue ? readState(issue.body) : [];
  const next = stateOf(alerts);
  if (sameState(prev, next)) return { kind: 'none', reason: next.length ? 'alerts unchanged' : 'all clear, nothing open' };
  const added = next.filter((x) => !prev.includes(x));
  const cleared = prev.filter((x) => !next.includes(x));
  // 'free_tier:doRowsWritten:warning' → 'free_tier:doRowsWritten (warning)'
  const pretty = (x) => `${x.slice(0, x.lastIndexOf(':'))} (${x.slice(x.lastIndexOf(':') + 1)})`;
  const summary = [
    added.length ? `New: ${added.map(pretty).join(', ')}.` : '',
    cleared.length ? `Cleared: ${cleared.map(pretty).join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join(' ');
  if (!next.length) return { kind: 'close', comment: `All clear — no Stream Studio cost alert fires any more. ${summary}`.trim() };
  const body = renderBody(alerts, ctx);
  if (!issue) return { kind: 'open', title: TITLE, body };
  return { kind: 'update', body, comment: `Alert state changed. ${summary}` };
}

// ─── GitHub (REST, the workflow's GITHUB_TOKEN with issues: write) ───────────────────────

async function gh(path, init = {}) {
  const repo = process.env.GITHUB_REPOSITORY;
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function findOpenIssue() {
  const list = await gh(`/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=10`);
  return (list ?? []).find((i) => !i.pull_request) ?? null;
}

async function apply(plan, issue) {
  if (plan.kind === 'none') return;
  if (plan.kind === 'open') {
    const made = await gh('/issues', { method: 'POST', body: JSON.stringify({ title: plan.title, body: plan.body, labels: [LABEL] }) });
    console.log(`stream-cost-watch: opened issue #${made?.number}`);
    return;
  }
  if (plan.kind === 'update') {
    await gh(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ body: plan.body }) });
    await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: plan.comment }) });
    console.log(`stream-cost-watch: updated issue #${issue.number}`);
    return;
  }
  if (plan.kind === 'close') {
    await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: plan.comment }) });
    await gh(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
    console.log(`stream-cost-watch: closed issue #${issue.number}`);
  }
}

export async function main(env = process.env) {
  if (!String(env.CF_ANALYTICS_API_TOKEN || '').trim() || !String(env.CLOUDFLARE_ACCOUNT_ID || '').trim()) {
    console.log(
      'stream-cost-watch: the CF_ANALYTICS_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID repository secret is not set — nothing to check. ' +
        'Add a READ-ONLY Cloudflare token (Account › Account Analytics › Read) as CF_ANALYTICS_API_TOKEN to turn the daily watch on.'
    );
    return { skipped: true };
  }
  // TypeScript sources (tsx runs this file): the same fetch, build and alert rules as Admin → Costs.
  const { fetchStreamAnalytics, buildStreamSection, namespaceLabelsFromEnv } = await import('../../server/src/services/streamCosts.ts');
  const nowMs = Date.now();
  const day = 86_400_000;
  const creds = { token: String(env.CF_ANALYTICS_API_TOKEN).trim(), accountId: String(env.CLOUDFLARE_ACCOUNT_ID).trim() };
  const analytics = await fetchStreamAnalytics({ nowMs, fromMs: nowMs - 14 * day, creds });
  const section = buildStreamSection({
    nowMs,
    range: { fromMs: nowMs - 7 * day, toMs: nowMs, prevFromMs: nowMs - 14 * day, days: 7 },
    analytics,
    namespaceLabels: namespaceLabelsFromEnv(env),
    phase0Shipped: env.STREAM_PHASE0_SHIPPED === '1'
  });
  for (const e of section.errors) console.log(`stream-cost-watch: dataset unavailable — ${e}`);
  console.log(`stream-cost-watch: ${section.alerts.length} alert(s) firing${section.alerts.length ? `: ${stateOf(section.alerts).join(', ')}` : ''}`);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log('stream-cost-watch: no GITHUB_TOKEN / GITHUB_REPOSITORY — reporting only.');
    return { alerts: section.alerts };
  }
  const issue = await findOpenIssue();
  const plan = planIssueAction(issue, section.alerts, { checkedAt: new Date(nowMs).toISOString() });
  if (plan.kind === 'none') console.log(`stream-cost-watch: no change (${plan.reason}) — no issue written.`);
  await apply(plan, issue);
  return { alerts: section.alerts, plan: plan.kind };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((err) => {
    // Token-free message (the fetchers scrub it); fail the run so the owner sees a red job.
    console.error(`stream-cost-watch: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
