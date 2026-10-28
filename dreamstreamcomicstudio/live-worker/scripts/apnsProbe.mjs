#!/usr/bin/env node
/**
 * Run the ADR 0006 Phase 0 APNs HTTP/2 probe and record the result.
 *
 * The decision comes from a Worker on Cloudflare's production network (the live Worker's
 * `POST /api/ops/apns-probe`, or the throwaway probe Worker — see
 * src/push/probe.wrangler.jsonc). This script calls it, checks the answer, prints the
 * line to paste under ADR 0006 D3, writes a JSON record (`--out`) and, in GitHub Actions,
 * the job summary.
 *
 *   OPS_KEY=… node scripts/apnsProbe.mjs --url https://<worker>/probe [--host sandbox|production] [--out file.json] [--strict]
 *   node scripts/apnsProbe.mjs --direct [--host sandbox|production] [--out file.json]
 *
 * `--direct` is a control, not the decision: it asks APNs from this machine with Node's
 * HTTP/2 client, so a pass here and a fail from the Worker pins the problem on the Worker's
 * egress. Exit codes: 0 = probe ran (pass or fail, both recorded); 2 = fail with --strict;
 * 1 = the probe could not run.
 *
 * No secrets are printed or written: the key travels only in the request header.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROBE_DEVICE_TOKEN = '0'.repeat(64);
const HOSTS = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };

/** Mirror of src/push/probe.ts classifyApnsProbe (a vitest keeps the two in step). */
export function classify({ status, apnsId, body, error }) {
  let reason = null;
  try {
    const j = JSON.parse(body);
    if (typeof j?.reason === 'string') reason = j.reason;
  } catch {
    /* not JSON */
  }
  if (error && !status) return { verdict: 'fail', reason, detail: `No HTTP/2 answer from APNs (${error}).` };
  const id = apnsId?.trim() || null;
  if (id && (reason || status === 200)) return { verdict: 'pass', reason, detail: `APNs answered over HTTP/2: ${status}${reason ? ` ${reason}` : ''} with apns-id ${id}.` };
  if (!id) return { verdict: 'fail', reason, detail: `HTTP ${status} without an apns-id header — not an APNs HTTP/2 response.` };
  return { verdict: 'fail', reason, detail: `HTTP ${status} with apns-id but no APNs reason in the body.` };
}

/** Is this the probe result shape the Worker returns? */
export function isProbeResult(r) {
  return !!r && typeof r === 'object' && typeof r.status === 'number' && (r.verdict === 'pass' || r.verdict === 'fail') && typeof r.detail === 'string' && 'apnsId' in r;
}

/** The line for ADR 0006 D3 (same words as probe.ts probeAdrLine). */
export function adrLine(r, where) {
  const day = String(r.at ?? new Date().toISOString()).slice(0, 10);
  const from = r.colo ? `${where}, ${r.colo}` : where;
  return r.verdict === 'pass'
    ? `- **APNs probe ${day} (${from}, ${r.host}): pass** — HTTP ${r.status} \`${r.reason ?? ''}\` with \`apns-id\` ${r.apnsId}. Decision: **send to APNs directly**.`
    : `- **APNs probe ${day} (${from}, ${r.host}): fail** — ${r.detail} Decision: **FCM for iOS** (set \`PUSH_IOS_VIA=fcm\`; VoIP via the Container).`;
}

function args(argv) {
  const out = { host: 'sandbox', attempts: 8, strict: false, direct: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--attempts') out.attempts = Number(argv[++i]);
    else if (a === '--strict') out.strict = true;
    else if (a === '--direct') out.direct = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.host !== 'sandbox' && out.host !== 'production') throw new Error('--host is sandbox or production');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the Worker (retrying while a fresh workers.dev deploy propagates). */
async function viaWorker(url, host, key, attempts) {
  const target = new URL(url);
  const local = target.hostname === '127.0.0.1' || target.hostname === 'localhost';
  if (target.protocol !== 'https:' && !(local && target.protocol === 'http:')) throw new Error('--url must be https');
  if (host === 'production') target.searchParams.set('host', 'production');
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(target, { method: 'POST', headers: { 'x-ops-key': key } });
      if (res.status === 403) throw Object.assign(new Error('the probe refused the key (403)'), { final: true });
      if (res.ok) {
        const j = await res.json();
        if (!isProbeResult(j)) throw Object.assign(new Error('the probe answered something that is not a probe result'), { final: true });
        return j;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      if (err?.final) throw err;
      last = String(err?.message ?? err);
    }
    await sleep(Math.min(15_000, 2_000 * (i + 1)));
  }
  throw new Error(`no answer from the probe Worker after ${attempts} tries (${last})`);
}

/** The control: Node's own HTTP/2 client from this machine. */
async function direct(host) {
  const http2 = await import('node:http2');
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const done = (r) => {
      const c = classify(r);
      resolve({ ...r, ...c, decision: c.verdict === 'pass' ? 'apns-direct' : 'fcm-for-ios', host, at: new Date(t0).toISOString(), ms: Date.now() - t0 });
    };
    let session;
    try {
      session = http2.connect(HOSTS[host]);
    } catch (err) {
      return done({ status: 0, apnsId: null, body: '', error: String(err?.message ?? err) });
    }
    const timer = setTimeout(() => {
      session.destroy();
      done({ status: 0, apnsId: null, body: '', error: 'timeout' });
    }, 15_000);
    session.on('error', (err) => {
      clearTimeout(timer);
      done({ status: 0, apnsId: null, body: '', error: String(err?.message ?? err) });
    });
    const req = session.request({ ':method': 'POST', ':path': `/3/device/${PROBE_DEVICE_TOKEN}`, 'apns-push-type': 'alert', 'apns-priority': '5', 'content-type': 'application/json' });
    let status = 0;
    let apnsId = null;
    let body = '';
    req.on('response', (h) => {
      status = Number(h[':status']) || 0;
      apnsId = typeof h['apns-id'] === 'string' ? h['apns-id'] : null;
    });
    req.setEncoding('utf8');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      clearTimeout(timer);
      session.close();
      done({ status, apnsId, body: body.slice(0, 512) });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      session.destroy();
      done({ status: 0, apnsId: null, body: '', error: String(err?.message ?? err) });
    });
    req.end('{"aps":{}}');
  });
}

function summary(record) {
  const r = record.result;
  const rows = [
    ['Verdict', `**${r.verdict}**`],
    ['Decision', r.decision === 'apns-direct' ? 'send to APNs directly' : 'FCM for iOS'],
    ['Ran from', record.via],
    ['APNs host', r.host],
    ['HTTP status', String(r.status)],
    ['apns-id', r.apnsId ?? '—'],
    ['Body', `\`${(r.body || '—').replace(/`/g, "'")}\``],
    ['Detail', r.detail],
    ['When', `${r.at}${r.colo ? ` (${r.colo})` : ''}, ${r.ms} ms`],
  ];
  return [`### APNs HTTP/2 probe — ${record.via}`, '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '', record.decides ? 'Paste under ADR 0006 D3:' : 'Control only (not the decision):', '', '```', record.adr, '```', ''].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try {
    a = args(argv);
  } catch (err) {
    console.error(String(err.message));
    return 1;
  }
  if (a.help || (!a.url && !a.direct)) {
    console.log('usage: OPS_KEY=… node scripts/apnsProbe.mjs --url https://<worker>/probe [--host sandbox|production] [--out file.json] [--strict]\n       node scripts/apnsProbe.mjs --direct [--host sandbox|production] [--out file.json]');
    return a.help ? 0 : 1;
  }
  let result;
  let via;
  try {
    if (a.direct) {
      via = `node ${process.version} http2 from this machine`;
      result = await direct(a.host);
    } else {
      const key = process.env.OPS_KEY;
      if (!key) throw new Error('set OPS_KEY to the probe secret');
      via = 'Cloudflare production (Worker fetch)';
      result = await viaWorker(a.url, a.host, key, Math.max(1, a.attempts || 1));
    }
  } catch (err) {
    console.error(`APNs probe could not run: ${err.message}`);
    return 1;
  }
  const record = {
    probe: 'apns-http2',
    adr: adrLine(result, a.direct ? 'control: this machine' : 'Cloudflare production'),
    decides: !a.direct,
    via,
    url: a.url ? new URL(a.url).origin + new URL(a.url).pathname : null,
    result,
  };
  console.log(JSON.stringify(record, null, 2));
  console.log(`\n${record.adr}`);
  if (a.out) writeFileSync(a.out, `${JSON.stringify(record, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary(record)}\n`);
  return a.strict && result.verdict !== 'pass' ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code));
}
