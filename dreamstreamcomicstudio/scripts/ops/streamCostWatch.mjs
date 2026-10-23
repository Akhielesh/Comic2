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
// Fails SAFE (owner decision): a dataset that didn't answer is "couldn't measure", never "all clear".
//   - Every alert that dataset feeds keeps its last state (an open TURN alert stays open while TURN
//     can't be read), and the issue says which data is missing.
//   - The issue is never closed, and "All clear" never posted, while any dataset is unmeasured.
//   - The run fails (red), so a revoked token or a renamed field can't go quiet.
//
// No secrets → a clear log line and exit 0 (a no-op), never a failed run.

import { pathToFileURL } from 'node:url';

export const LABEL = 'stream-cost-watch';
export const TITLE = 'Stream Studio cost watch';
const MARKER = 'stream-cost-watch-state';
const STATE_RE = new RegExp(`<!-- ${MARKER}: (\\[.*?\\]) -->`);

/** The alert state that matters for a diff: ids with their severity, sorted. */
export const stateOf = (alerts) => [...new Set(alerts.map((a) => `${a.id}:${a.severity}`))].sort();

/** A dataset that didn't answer is part of the state too: `data:<dataset>:unmeasured`. */
const DATA_PREFIX = 'data:';
const dataEntry = (dataset) => `${DATA_PREFIX}${dataset}:unmeasured`;
const isDataEntry = (x) => x.startsWith(DATA_PREFIX);
const datasetOf = (x) => x.slice(DATA_PREFIX.length, x.lastIndexOf(':'));
const alertIdOf = (x) => x.slice(0, x.lastIndexOf(':'));
const severityOf = (x) => x.slice(x.lastIndexOf(':') + 1);

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

/**
 * The state to keep: what fires now, plus — for every dataset that didn't answer — a marker and the
 * previous state of each alert that dataset feeds (it can't be checked, so it isn't cleared).
 *   ctx.unmeasured: [{ dataset, label, error }] — the datasets that didn't answer.
 *   ctx.dependsOn(alertId) → dataset ids the alert is evaluated from (default: all of them).
 *   ctx.labels: dataset id → words, for the comment when a dataset answers again.
 */
export function nextState(prev, alerts, ctx = {}) {
  const unmeasured = ctx.unmeasured ?? [];
  const failed = new Set(unmeasured.map((u) => u.dataset));
  const dependsOn = ctx.dependsOn ?? (() => [...failed]);
  const firing = new Set(alerts.map((a) => a.id));
  const carried = failed.size
    ? prev.filter((x) => !isDataEntry(x) && !firing.has(alertIdOf(x)) && dependsOn(alertIdOf(x)).some((d) => failed.has(d)))
    : [];
  return { carried, next: [...new Set([...stateOf(alerts), ...carried, ...[...failed].map(dataEntry)])].sort() };
}

/** The issue body: what fires and why, what couldn't be measured, then where to look. Carries the state marker. */
export function renderBody(alerts, ctx = {}) {
  const unmeasured = ctx.unmeasured ?? [];
  const carried = ctx.carried ?? [];
  const state = ctx.state ?? stateOf(alerts);
  const lines = [
    `Checked ${ctx.checkedAt ?? new Date().toISOString()} from Cloudflare's own analytics (month to date, account-wide).`,
    '',
    ...alerts.map((a) => `- **${a.severity === 'critical' ? 'Critical' : 'Warning'} — ${a.title}.** ${a.cause}`),
    ...carried.map(
      (x) =>
        `- **${severityOf(x) === 'critical' ? 'Critical' : 'Warning'} — \`${alertIdOf(x)}\` still open, not re-checked.** The data it needs didn't answer, so it keeps its last state until it can be measured again.`
    )
  ];
  if (unmeasured.length) {
    lines.push(
      '',
      `**Couldn't measure** — not "all clear". This issue stays open until every dataset answers again:`,
      ...unmeasured.map((u) => `- ${u.label}${u.error ? `: ${u.error}` : ''}`)
    );
  }
  lines.push(
    '',
    'Where to look: Admin → Costs → Stream Studio. Runbook: `dreamstreamcomicstudio/docs/infrastructure/COST_RUNBOOK.md` §1.',
    'Backstop: the Cloudflare account budget alert (Billing → budget alerts). Stream Studio never charges users; limits never cut baby-monitor sound or alerts.',
    '',
    `<!-- ${MARKER}: ${JSON.stringify(state)} -->`
  );
  return lines.join('\n');
}

/**
 * What to do with the watch issue. `issue` is the open one (or null). Only a change in the state
 * (firing alerts, severities, unmeasured datasets) writes anything; nothing closes while data is missing.
 */
export function planIssueAction(issue, alerts, ctx = {}) {
  const unmeasured = ctx.unmeasured ?? [];
  const prev = issue ? readState(issue.body) : [];
  const { carried, next } = nextState(prev, alerts, ctx);
  if (sameState(prev, next)) {
    const reason = unmeasured.length ? `still couldn't measure ${unmeasured.map((u) => u.label).join(', ')}; state unchanged` : next.length ? 'alerts unchanged' : 'all clear, nothing open';
    return { kind: 'none', reason };
  }
  const added = next.filter((x) => !prev.includes(x));
  const cleared = prev.filter((x) => !next.includes(x));
  const labelOf = (dataset) => unmeasured.find((u) => u.dataset === dataset)?.label ?? ctx.labels?.[dataset] ?? dataset;
  // 'free_tier:doRowsWritten:warning' → 'free_tier:doRowsWritten (warning)'; 'data:turn:unmeasured' → 'TURN egress'
  const pretty = (x) => (isDataEntry(x) ? labelOf(datasetOf(x)) : `${alertIdOf(x)} (${severityOf(x)})`);
  const newAlerts = added.filter((x) => !isDataEntry(x));
  const newGaps = added.filter(isDataEntry);
  const clearedAlerts = cleared.filter((x) => !isDataEntry(x));
  const answeredAgain = cleared.filter(isDataEntry);
  const summary = [
    newAlerts.length ? `New: ${newAlerts.map(pretty).join(', ')}.` : '',
    newGaps.length ? `Couldn't measure: ${newGaps.map(pretty).join(', ')}.` : '',
    clearedAlerts.length ? `Cleared: ${clearedAlerts.map(pretty).join(', ')}.` : '',
    answeredAgain.length ? `Measured again: ${answeredAgain.map(pretty).join(', ')}.` : '',
    carried.length ? `Kept as they were (not re-checked): ${carried.map(pretty).join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join(' ');
  // Only a fully measured run with nothing firing may close the issue.
  if (!next.length) return { kind: 'close', comment: `All clear — every dataset answered and no Stream Studio cost alert fires. ${summary}`.trim() };
  const body = renderBody(alerts, { ...ctx, carried, state: next });
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
  const { alertDatasets, buildStreamSection, failedDatasets, fetchStreamAnalytics, namespaceLabelsFromEnv, STREAM_DATASET_LABEL, STREAM_DATASETS } = await import(
    '../../server/src/services/streamCosts.ts'
  );
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
  // A dataset that didn't answer is "couldn't measure": its alerts keep their last state, and the run fails.
  const unmeasured = failedDatasets(analytics).map((dataset) => ({ dataset, label: STREAM_DATASET_LABEL[dataset], error: analytics.failures?.[dataset] ?? '' }));
  for (const u of unmeasured) console.log(`stream-cost-watch: couldn't measure ${u.label}${u.error ? ` — ${u.error}` : ''}`);
  console.log(`stream-cost-watch: ${section.alerts.length} alert(s) firing${section.alerts.length ? `: ${stateOf(section.alerts).join(', ')}` : ''}`);
  const exitCode = unmeasured.length ? 1 : 0;
  if (exitCode) {
    console.log(
      `stream-cost-watch: ${unmeasured.length} of ${STREAM_DATASETS.length} datasets unmeasured — not "all clear": alerts they feed keep their last state, and this run fails so it shows red.`
    );
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log('stream-cost-watch: no GITHUB_TOKEN / GITHUB_REPOSITORY — reporting only.');
    return { alerts: section.alerts, unmeasured: unmeasured.map((u) => u.dataset), exitCode };
  }
  const issue = await findOpenIssue();
  const plan = planIssueAction(issue, section.alerts, { checkedAt: new Date(nowMs).toISOString(), unmeasured, dependsOn: alertDatasets, labels: STREAM_DATASET_LABEL });
  if (plan.kind === 'none') console.log(`stream-cost-watch: no change (${plan.reason}) — no issue written.`);
  await apply(plan, issue);
  return { alerts: section.alerts, plan: plan.kind, unmeasured: unmeasured.map((u) => u.dataset), exitCode };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main()
    .then((out) => {
      if (out?.exitCode) process.exitCode = out.exitCode;
    })
    .catch((err) => {
      // Token-free message (the fetchers scrub it); fail the run so the owner sees a red job.
      console.error(`stream-cost-watch: ${err?.message ?? err}`);
      process.exitCode = 1;
    });
}
