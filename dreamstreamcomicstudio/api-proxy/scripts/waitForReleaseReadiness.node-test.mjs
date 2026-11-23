import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { predatesReadiness, waitForReleaseReadiness } from './waitForReleaseReadiness.mjs';

const a = 'a'.repeat(12), b = 'b'.repeat(12);
const health = (releaseReadiness, build = a) => ({ status: 'ok', build, releaseReadiness });

function monitor(samples, legacy = () => false) {
  let elapsed = 0, polls = 0;
  const run = waitForReleaseReadiness({
    read: async () => {
      const next = samples[Math.min(polls++, samples.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    legacy, now: () => elapsed, wait: async ms => { elapsed += ms; }, log: () => {},
    pollMs: 5, idleMs: 10, timeoutMs: 60,
  });
  return { run, polls: () => polls };
}

test('new work, a transient error and a build change each restart the idle window', async () => {
  const check = monitor([health('idle'), health('busy'), health('idle'), new Error('offline'),
    health('idle'), health('idle', b), health('idle', b), health('idle', b)]);
  await check.run;
  assert.equal(check.polls(), 8);
});

test('continuous work, malformed health and unknown capabilities block the rollout', async () => {
  for (const input of [health('busy'), health('odd'), {}, health(undefined), { status: 'ok', releaseReadiness: 'idle' }]) {
    await assert.rejects(monitor([input]).run, /Deployment stopped/);
  }
});

test('bootstrap requires a verified older build and cannot follow a capable sample', async () => {
  const legacy = build => build === a;
  await monitor([health(undefined)], legacy).run;
  await assert.rejects(monitor([health(undefined, b)], legacy).run, /Deployment stopped/);
  await assert.rejects(monitor([health('busy'), health(undefined)], legacy).run, /Deployment stopped/);
  await assert.rejects(monitor([health('wrong')], legacy).run, /Deployment stopped/);
});

test('the bootstrap check proves an ancestor lacks the released gate in git', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-readiness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Readiness test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'older version');
  const older = git('rev-parse', '--short=12', 'HEAD');
  const scripts = join(dir, 'dreamstreamcomicstudio/api-proxy/scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'waitForReleaseReadiness.mjs'), '// fixture');
  git('add', '.');
  git('commit', '--quiet', '-m', 'reports readiness');
  assert.equal(predatesReadiness(older, dir), true);
  assert.equal(predatesReadiness(git('rev-parse', 'HEAD'), dir), false);
  git('rm', '--quiet', 'dreamstreamcomicstudio/api-proxy/scripts/waitForReleaseReadiness.mjs');
  git('commit', '--quiet', '-m', 'field removed');
  assert.equal(predatesReadiness(git('rev-parse', 'HEAD'), dir), false);
  assert.equal(predatesReadiness('HEAD', dir), false);
  assert.equal(predatesReadiness('f'.repeat(40), dir), false);
});


test('the production deploy sequence runs the readiness gate before Wrangler and verifies the new build', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/deploy-api-proxy.yml', import.meta.url), 'utf8');
  const gated = workflow.indexOf('run: node dreamstreamcomicstudio/api-proxy/scripts/waitForReleaseReadiness.mjs');
  const rollout = workflow.indexOf('run: npx wrangler deploy');
  assert.ok(gated > workflow.indexOf('run: node scripts/prepareDeploy.mjs') && gated < rollout);
  assert.match(workflow.slice(0, gated), /fetch-depth: 0/);
  assert.match(workflow.slice(rollout), /deadline=\$\(\(SECONDS \+ 15 \* 60\)\)/);
  assert.match(workflow.slice(rollout), /if \(\( SECONDS >= deadline \)\)/);
  assert.match(workflow.slice(rollout), /includes\(h\.releaseReadiness\).*v\.gitSha === process\.env\.GITHUB_SHA/);
});
