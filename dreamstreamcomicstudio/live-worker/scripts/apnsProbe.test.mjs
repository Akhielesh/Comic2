// @vitest-environment node
// scripts/apnsProbe.mjs end to end: the script ↔ the real probe handler (src/push/probe.ts)
// served locally ↔ APNs answers from the recorded fixtures. Plain JS because it needs Node
// APIs the Workers tsconfig doesn't type.
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adrLine, classify, main } from './apnsProbe.mjs';
import { classifyApnsProbe, handleApnsProbe, probeAdrLine, probeApns } from '../src/push/probe';
import { recordingFetch } from '../src/push/testKit';
import fixtures from '../src/push/fixtures/apns/responses.json';

const RECORDED_PASS = fixtures.cases.find((c) => c.source === 'recorded' && c.name.startsWith('sandbox')).response;
const KEY = 'k'.repeat(32);
const noHttp2 = () =>
  recordingFetch(() => {
    throw new TypeError('Parse Error: Expected HTTP/ (Unexpected HTTP/1.x request)');
  }).fetcher;

describe('scripts/apnsProbe.mjs', () => {
  let server;
  let base = '';
  let apnsAnswers = 'pass';
  let dir = '';
  const env = { ...process.env };

  beforeEach(async () => {
    apnsAnswers = 'pass';
    dir = mkdtempSync(join(tmpdir(), 'apns-probe-'));
    process.env.GITHUB_STEP_SUMMARY = join(dir, 'summary.md');
    process.env.OPS_KEY = KEY;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A local stand-in for the deployed probe Worker: the real handler, APNs faked from fixtures.
    server = createServer(async (req, res) => {
      const r = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers });
      const fetcher = apnsAnswers === 'pass' ? recordingFetch(() => RECORDED_PASS).fetcher : noHttp2();
      const out = await handleApnsProbe(r, KEY, { fetcher });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(await out.text());
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...env };
    await new Promise((ok) => server.close(ok));
  });

  it('classifies and words the ADR line exactly like probe.ts', async () => {
    const inputs = [
      { status: 403, apnsId: 'A', body: '{"reason":"MissingProviderToken"}' },
      { status: 200, apnsId: 'A', body: '' },
      { status: 502, apnsId: null, body: '<html>' },
      { status: 403, apnsId: 'A', body: 'nope' },
      { status: 0, apnsId: null, body: '', error: 'Network connection lost.' },
    ];
    for (const i of inputs) expect(classify(i)).toEqual(classifyApnsProbe(i));
    const pass = await probeApns({ fetcher: recordingFetch(() => RECORDED_PASS).fetcher });
    expect(adrLine({ ...pass, colo: 'SJC' }, 'Cloudflare production')).toBe(probeAdrLine({ ...pass, colo: 'SJC' }));
    const fail = await probeApns({ fetcher: noHttp2() });
    expect(adrLine(fail, 'Cloudflare production')).toBe(probeAdrLine(fail));
  });

  it('records a pass: JSON record, ADR line and the job summary; exit 0; no key written', async () => {
    const out = join(dir, 'result.json');
    expect(await main(['--url', `${base}/probe`, '--out', out, '--attempts', '1'])).toBe(0);
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(rec).toMatchObject({ probe: 'apns-http2', decides: true, result: { verdict: 'pass', decision: 'apns-direct', status: 403 } });
    expect(rec.adr).toMatch(/pass\*\* — HTTP 403 `MissingProviderToken` with `apns-id` BEB26349/);
    expect(JSON.stringify(rec)).not.toContain(KEY);
    const summary = readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary).toContain('| Verdict | **pass** |');
    expect(summary).toContain('Paste under ADR 0006 D3:');
    expect(summary).not.toContain(KEY);
  });

  it('records a fail as a decision (exit 0), or as a failure with --strict (exit 2)', async () => {
    apnsAnswers = 'no-h2';
    const out = join(dir, 'fail.json');
    expect(await main(['--url', `${base}/probe`, '--out', out, '--attempts', '1'])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).result).toMatchObject({ verdict: 'fail', decision: 'fcm-for-ios', status: 0 });
    expect(await main(['--url', `${base}/probe`, '--attempts', '1', '--strict'])).toBe(2);
  });

  it('exit 1 when the probe cannot run: wrong key, no key, plain http to a remote host, bad args', async () => {
    process.env.OPS_KEY = 'x'.repeat(32);
    expect(await main(['--url', `${base}/probe`, '--attempts', '3'])).toBe(1); // a 403 is final, no retries
    delete process.env.OPS_KEY;
    expect(await main(['--url', `${base}/probe`, '--attempts', '1'])).toBe(1);
    process.env.OPS_KEY = KEY;
    expect(await main(['--url', 'http://probe.example/probe', '--attempts', '1'])).toBe(1);
    expect(await main(['--host', 'staging', '--url', `${base}/probe`])).toBe(1);
    expect(await main([])).toBe(1);
  });
});

// The CI job deploys a Worker with the account's deploy token: keep it the throwaway one.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROBE_CONFIG = join(HERE, '../src/push/probe.wrangler.jsonc');
const WORKFLOW = join(HERE, '../../../.github/workflows/apns-probe.yml');

describe('the throwaway probe Worker and its workflow', () => {
  it('the probe Worker has its own name, workers.dev only, and no routes or bindings', () => {
    const cfg = JSON.parse(
      readFileSync(PROBE_CONFIG, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n'),
    );
    expect(cfg.name).toBe('dreamstream-apns-probe');
    expect(cfg.main).toBe('probeWorker.ts');
    expect(cfg.workers_dev).toBe(true);
    const allowed = new Set(['name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls']);
    expect(Object.keys(cfg).filter((k) => !allowed.has(k))).toEqual([]);
  });

  it.skipIf(!existsSync(WORKFLOW))('deploys only that Worker, with a pinned wrangler, and always deletes it', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).toMatch(/^\s+PROBE_WORKER: dreamstream-apns-probe$/m);
    expect(code).toMatch(/^\s+PROBE_CONFIG: src\/push\/probe\.wrangler\.jsonc$/m);
    expect(code).toMatch(/^\s+WRANGLER: wrangler@\d+\.\d+\.\d+$/m);
    // Every tool it runs through npx is the pinned wrangler, against the probe config and name.
    const calls = code.split('\n').filter((l) => /\bnpx\b/.test(l));
    expect(calls.map((l) => /npx --yes "\$WRANGLER" (deploy|delete)\b/.exec(l)?.[1])).toEqual(['deploy', 'delete']);
    for (const l of calls) {
      expect(l).toContain('-c "$PROBE_CONFIG"');
      expect(l).toContain('"$PROBE_WORKER"');
    }
    expect(code).not.toMatch(/dreamstream-live\b/);
    expect(code).not.toMatch(/@latest\b/);
    expect(code).not.toMatch(/\bnpm ci\b(?!.*--ignore-scripts)/);
    // The delete runs whatever happened before it.
    expect(code).toMatch(/- name: Delete the probe Worker\n\s+if: always\(\)/);
    expect(code).toMatch(/^\s+workflow_dispatch:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|schedule):/m);
  });
});

