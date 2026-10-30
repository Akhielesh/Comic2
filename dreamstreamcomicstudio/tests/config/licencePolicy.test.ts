// @vitest-environment node
/**
 * W1.6 licence gate (scripts/licence-check.mjs + scripts/licence-policy.json + licenceModules() in
 * vite.config.ts + scripts/notices.mjs). One policy over the npm lockfiles, the browser bundle,
 * platform-engine/engines.lock.json and the data assets:
 *   - browser: MIT / Apache / BSD / ISC / MPL / OFL only;
 *   - GPL and LGPL: server-only, and only from the allowlist (libvips through sharp, poppler, ffmpeg);
 *   - blocked everywhere: AGPL, SSPL, BUSL, PolyForm, CC-NC, source-available, no licence;
 *   - a named denylist; jszip under its MIT option; Liberation fonts 2.x (OFL) only;
 *   - known violations are owner decisions (KNOWN), never silent and never a dependency change.
 * Fixtures are synthetic lockfiles / engine locks / asset records judged by the REAL policy.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import * as gate from '../../scripts/licence-check.mjs';
import { engineNotices, webNotices } from '../../scripts/notices.mjs';
import viteConfig, { licenceModules } from '../../vite.config';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const REPO = path.resolve(APP, '..');
const POLICY = gate.loadPolicy(path.join(APP, 'scripts/licence-policy.json'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Pkg = { version?: string; license?: string; dev?: boolean; name?: string };
const lockfile = (pkgs: Record<string, Pkg>) => ({
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture' },
    ...Object.fromEntries(Object.entries(pkgs).map(([key, v]) => [`node_modules/${key}`, { version: '1.0.0', ...v }])),
  },
});
const bundle = (...pkgs: { name: string; version?: string; licence: string | null }[]) => ({
  version: 1,
  packages: pkgs.map((p) => ({ key: `node_modules/${p.name}`, name: p.name, version: p.version ?? '1.0.0', licence: p.licence, modules: 1 })),
  vendored: [] as string[],
  firstPartyModules: 1,
});

type GateOpts = Parameters<typeof gate.runGate>[0];
/** The gate over fixtures only: nothing is read from the repository except the real policy. */
const fixtureGate = (opts: GateOpts = {}) =>
  gate.runGate({
    root: '/nonexistent/licence-fixture',
    policy: POLICY,
    lockfiles: {},
    engines: {},
    dataAssetFiles: [],
    vendoredDirs: [],
    htmlPages: [],
    exists: () => true,
    ...opts,
  });
const failuresOf = (g: ReturnType<typeof gate.runGate>, name: string) => g.failures.filter((r) => r.name === name);
const kinds = (g: ReturnType<typeof gate.runGate>, name: string) => failuresOf(g, name).flatMap((r) => r.problems.map((p) => p.kind));

describe('npm lockfiles', () => {
  it('a clean fixture lockfile passes (control)', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({
      a: { license: 'MIT' }, b: { license: 'Apache-2.0' }, c: { license: '(MIT OR Apache-2.0)' }, d: { license: 'BSD-3-Clause' }, e: { license: 'ISC', dev: true },
    }) } });
    expect(g.failures).toEqual([]);
    expect(g.ok).toBe(true);
  });

  it.each([
    'AGPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0', 'BUSL-1.1', 'PolyForm-Noncommercial-1.0.0', 'PolyForm-Shield-1.0.0',
    'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'Elastic-2.0', 'UNLICENSED',
  ])('a fixture lockfile with %s fails, in production and dev dependencies alike', (licence) => {
    for (const dev of [false, true]) {
      const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({ ok: { license: 'MIT' }, bad: { license: licence, dev } }) } });
      expect(g.ok).toBe(false);
      expect(kinds(g, 'bad')).toEqual(['blocked']);
      expect(failuresOf(g, 'ok')).toEqual([]);
    }
  });

  it('a fixture lockfile with no licence, or a non-SPDX one nobody has read, fails', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({ none: {}, blank: { license: ' ' }, custom: { license: 'SEE LICENSE IN LICENSE.txt' } }) } });
    expect(kinds(g, 'none')).toEqual(['no-licence']);
    expect(kinds(g, 'blank')).toEqual(['no-licence']);
    expect(kinds(g, 'custom')).toEqual(['unrecognised']);
  });

  it('judges SPDX expressions: OR passes on an allowed option, AND needs every part', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({
      either: { license: '(AGPL-3.0-only OR MIT)' },
      both: { license: '(MIT AND SSPL-1.0)' },
      nested: { license: '(MIT AND (BSD-2-Clause OR GPL-3.0-only))' },
    }) } });
    expect(failuresOf(g, 'either')).toEqual([]);
    expect(kinds(g, 'both')).toEqual(['blocked']);
    expect(failuresOf(g, 'nested')).toEqual([]);
    expect(g.results.find((r) => r.name === 'either')?.effective).toBe('MIT');
  });

  it('GPL/LGPL on the server only from the allowlist (libvips through sharp passes, anything else fails)', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({
      '@img/sharp-libvips-linux-x64': { license: 'LGPL-3.0-or-later' },
      '@img/sharp-win32-x64': { license: 'Apache-2.0 AND LGPL-3.0-or-later' },
      'some-gpl-tool': { license: 'GPL-3.0-only', dev: true },
      'gpl-with-exception': { license: 'GPL-2.0-only WITH Classpath-exception-2.0' },
    }) } });
    expect(failuresOf(g, '@img/sharp-libvips-linux-x64')).toEqual([]);
    expect(failuresOf(g, '@img/sharp-win32-x64')).toEqual([]);
    expect(kinds(g, 'some-gpl-tool')).toEqual(['copyleft-not-allowlisted']);
    expect(kinds(g, 'gpl-with-exception')).toEqual(['copyleft-not-allowlisted']);
  });

  it('compares SPDX ids case-insensitively', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({ lower: { license: 'mit' }, agpl: { license: 'agpl-3.0-only' } }) } });
    expect(failuresOf(g, 'lower')).toEqual([]);
    expect(kinds(g, 'agpl')).toEqual(['blocked']);
  });

  it('finds and checks a lockfile the policy does not name (a new Worker, the engine image)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'licence-root-'));
    try {
      mkdirSync(path.join(root, 'new-worker'), { recursive: true });
      mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
      writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lockfile({ ok: { license: 'MIT' } })));
      writeFileSync(path.join(root, 'new-worker/package-lock.json'), JSON.stringify(lockfile({ sneaky: { license: 'SSPL-1.0', dev: true } })));
      // Synthetic test fixtures are never shipped and are not read.
      writeFileSync(path.join(root, 'tests/fixtures/package-lock.json'), JSON.stringify(lockfile({ fixture: { license: 'AGPL-3.0-only' } })));
      expect(gate.scanLockfiles(root, POLICY)).toEqual(['new-worker/package-lock.json', 'package-lock.json']);
      const policy = clone(POLICY);
      policy.dataAssets.records = [];
      policy.vendored.records = [];
      const g = gate.runGate({ root, policy, engines: {}, htmlPages: [] });
      expect(g.failures.map((r) => [r.name, r.source])).toEqual([['sneaky', 'new-worker/package-lock.json: node_modules/sneaky']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads every Worker lockfile the policy names', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({}), 'api-proxy/package-lock.json': lockfile({ evil: { license: 'BUSL-1.1', dev: true } }) } });
    expect(kinds(g, 'evil')).toEqual(['blocked']);
    expect(failuresOf(g, 'evil')[0].source).toMatch(/^api-proxy\/package-lock\.json: /);
    for (const f of POLICY.lockfiles as string[]) expect(f).toMatch(/package-lock\.json$/);
    expect(POLICY.lockfiles).toEqual(expect.arrayContaining(['package-lock.json', 'api-proxy/package-lock.json', 'comics-edge/package-lock.json', 'live-worker/package-lock.json', 'email-worker/package-lock.json']));
  });
});

describe('browser bundle (the licenceModules() report)', () => {
  it.each(['GPL-3.0-only', 'GPL-2.0-or-later', 'LGPL-2.1-or-later', 'LGPL-3.0-only'])('a %s module in the browser list fails', (licence) => {
    const lock = lockfile({ copyleft: { license: licence } });
    const asServer = fixtureGate({ lockfiles: { 'package-lock.json': lock } });
    expect(kinds(asServer, 'copyleft')).toEqual(['copyleft-not-allowlisted']);
    const inBrowser = fixtureGate({ lockfiles: { 'package-lock.json': lock }, browserModules: bundle({ name: 'copyleft', licence }) });
    expect(kinds(inBrowser, 'copyleft')).toEqual(['copyleft-in-browser']);
    expect(failuresOf(inBrowser, 'copyleft')[0].scope).toBe('browser');
  });

  it('the server copyleft allowlist never reaches the browser', () => {
    const lock = lockfile({ '@img/sharp-libvips-linux-x64': { license: 'LGPL-3.0-or-later' } });
    expect(fixtureGate({ lockfiles: { 'package-lock.json': lock } }).ok).toBe(true);
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lock }, browserModules: bundle({ name: '@img/sharp-libvips-linux-x64', licence: 'LGPL-3.0-or-later' }) });
    expect(kinds(g, '@img/sharp-libvips-linux-x64')).toEqual(['copyleft-in-browser']);
  });

  it('server-only permissive licences (BlueOak, CC0, Zlib) pass on the server and fail in the browser', () => {
    const lock = lockfile({ blue: { license: 'BlueOak-1.0.0' }, cc0: { license: 'CC0-1.0' }, zlib: { license: '(MIT AND Zlib)' } });
    expect(fixtureGate({ lockfiles: { 'package-lock.json': lock } }).ok).toBe(true);
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lock }, browserModules: bundle({ name: 'blue', licence: 'BlueOak-1.0.0' }, { name: 'cc0', licence: 'CC0-1.0' }, { name: 'zlib', licence: '(MIT AND Zlib)' }) });
    for (const n of ['blue', 'cc0', 'zlib']) expect(kinds(g, n)).toEqual(['not-allowed']);
  });

  it('the browser families pass: MIT, Apache, BSD, ISC, MPL, OFL', () => {
    const ids = ['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC', 'MPL-2.0', 'OFL-1.1'];
    const lock = lockfile(Object.fromEntries(ids.map((id) => [`p-${id}`, { license: id }])));
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lock }, browserModules: bundle(...ids.map((id) => ({ name: `p-${id}`, licence: id }))) });
    expect(g.failures).toEqual([]);
    expect(g.results.filter((r) => r.scope === 'browser' && r.source.startsWith('node_modules/'))).toHaveLength(ids.length);
  });

  it('a bundled package the lockfile does not list is judged from the report', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({}) }, browserModules: bundle({ name: 'stray', licence: 'GPL-3.0-only' }) });
    expect(kinds(g, 'stray')).toEqual(['copyleft-in-browser']);
  });

  it('CI mode refuses to pass without the bundle report, and checks the built notices name every bundled package', () => {
    expect(fixtureGate({ requireBrowserModules: true }).failures.map((r) => r.problems[0].kind)).toEqual(['no-browser-report']);
    const lock = lockfile({ a: { license: 'MIT' }, b: { license: 'ISC' } });
    const report = bundle({ name: 'a', licence: 'MIT' }, { name: 'b', licence: 'ISC' });
    expect(fixtureGate({ lockfiles: { 'package-lock.json': lock }, browserModules: report, noticesText: 'a@1.0.0 — MIT\nb@1.0.0 — ISC' }).ok).toBe(true);
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lock }, browserModules: report, noticesText: 'a@1.0.0 — MIT' });
    expect(g.failures.flatMap((r) => r.problems.map((p) => p.message))).toEqual(['b@1.0.0 is bundled but not in the notices']);
  });

  it('maps module ids to packages (nested, scoped, queries, assets) and finds vendored first-party code', () => {
    const root = '/app';
    const versions: Record<string, unknown> = {
      '/app/node_modules/jszip': { name: 'jszip', version: '3.10.1', license: '(MIT OR GPL-3.0-or-later)' },
      '/app/node_modules/@scope/pkg': { name: '@scope/pkg', version: '2.0.0', license: 'MIT' },
      '/app/node_modules/a/node_modules/b': { name: 'b', version: '0.1.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] },
    };
    const report = gate.browserModulesReport([
      '/app/node_modules/jszip/dist/jszip.min.js',
      '/app/node_modules/jszip/lib/index.js',
      '/app/node_modules/@scope/pkg/files/font.woff2?url',
      'node_modules/a/node_modules/b/index.js',
      '\0vite/preload-helper.js',
      '/app/components/x.tsx',
      '/app/packages/platform-render/src/vendor/pptxgenjs/pptxgen.es.js',
    ], { root, readPackageJson: (dir) => versions[dir] ?? null });
    expect(report.packages).toEqual([
      { key: 'node_modules/@scope/pkg', name: '@scope/pkg', version: '2.0.0', licence: 'MIT', modules: 1 },
      { key: 'node_modules/a/node_modules/b', name: 'b', version: '0.1.0', licence: '(MIT OR Apache-2.0)', modules: 1 },
      { key: 'node_modules/jszip', name: 'jszip', version: '3.10.1', licence: '(MIT OR GPL-3.0-or-later)', modules: 2 },
    ]);
    expect(report.vendored).toEqual(['packages/platform-render/src/vendor/pptxgenjs']);
    expect(report.firstPartyModules).toBe(2);
  });
});

describe('the named denylist', () => {
  const DENIED = [
    '@tiptap-pro/extension-comments', '@univerjs-pro/sheets-pivot', '@blocknote/xl-ai', '@docx-editor.dev/pro', '@docx-editor.dev/editor-api',
    '@docx-editor.dev/docx-to-pdf', '@docx-editor.dev/telemetry', 'superdoc', 'pdf-lib', 'presenton',
  ];
  it.each(DENIED)('%s fails whatever its licence and scope, and no exception rescues it', (name) => {
    const policy = clone(POLICY);
    policy.exceptions.push({ package: name, licence: 'MIT', decision: 'owner', reason: 'fixture' });
    for (const dev of [false, true]) {
      const g = fixtureGate({ policy, lockfiles: { 'package-lock.json': lockfile({ [name]: { license: 'MIT', dev } }) } });
      expect(kinds(g, name)).toEqual(['denied']);
      expect(g.known).toEqual([]);
    }
  });

  it('the maintained fork @cantoo/pdf-lib passes, and an npm alias cannot hide a denied package', () => {
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({
      '@cantoo/pdf-lib': { license: 'MIT' },
      'my-editor': { license: 'MIT', name: '@tiptap-pro/extension-ai' },
    }) } });
    expect(failuresOf(g, '@cantoo/pdf-lib')).toEqual([]);
    expect(kinds(g, '@tiptap-pro/extension-ai')).toEqual(['denied']);
  });
});

describe('platform-engine/engines.lock.json', () => {
  const sha = (c: string) => c.repeat(64);
  const engine = (over: Record<string, unknown> = {}) => ({
    id: 'qpdf', version: '12.4.2', asset: 'qpdf-12.4.2-bin-linux-x86_64.zip', sha256: sha('a'), licence: 'Apache-2.0',
    source: 'https://github.com/qpdf/qpdf/releases/tag/v12.4.2', trust: 'untrusted-ok', pool: 'light', build: 'upstream', ...over,
  });
  const engineGate = (engines: unknown[]) => fixtureGate({ engines: { 'platform-engine/engines.lock.json': { version: 1, engines } } });

  it('a well-formed lock with permissive engines and allowlisted poppler passes', () => {
    const g = engineGate([engine(), engine({ id: 'poppler-utils', version: '24.02.0', asset: 'poppler.tar.xz', sha256: sha('b'), licence: 'GPL-2.0-or-later', pool: 'heavy', trust: 'own' })]);
    expect(g.failures).toEqual([]);
    expect(g.results.filter((r) => r.scope === 'engine').map((r) => r.name)).toEqual(['engine:qpdf', 'engine:poppler-utils']);
  });

  it.each([
    ['AGPL-3.0-only', 'blocked'],
    ['GPL-3.0-only', 'copyleft-not-allowlisted'],
    ['LicenseRef-Proprietary', 'not-allowed'],
    ['SSPL-1.0', 'blocked'],
  ])('a fixture engine with %s fails (%s)', (licence, kind) => {
    const g = engineGate([engine({ id: 'ghostscript', licence })]);
    expect(kinds(g, 'engine:ghostscript')).toEqual([kind]);
  });

  it.each([
    ['no sha256', { sha256: undefined }],
    ['a short sha256', { sha256: 'abc123' }],
    ['an uppercase sha256', { sha256: sha('A') }],
    ['an http source', { source: 'http://example.com/x.zip' }],
    ['no source', { source: undefined }],
    ['an unknown pool', { pool: 'gpu' }],
    ['an unknown field', { downloadUrl: 'https://x' }],
  ])('an engine entry with %s fails the schema', (_label, over) => {
    const e = engine(over);
    for (const k of Object.keys(e)) if ((e as Record<string, unknown>)[k] === undefined) delete (e as Record<string, unknown>)[k];
    const g = engineGate([e]);
    expect(g.ok).toBe(false);
    expect(g.failures.flatMap((r) => r.problems.map((p) => p.kind))).toContain('schema');
  });

  it('the sha256 and https-source rules hold even if the policy schema is loosened', () => {
    const policy = clone(POLICY);
    const props = policy.engines.schema.properties.engines.items.properties;
    props.sha256 = { type: 'string' };
    props.source = { type: 'string' };
    const loose = (over: Record<string, unknown>) => fixtureGate({ policy, engines: { 'platform-engine/engines.lock.json': { version: 1, engines: [engine(over)] } } });
    expect(loose({}).failures).toEqual([]);
    expect(loose({ sha256: 'deadbeef' }).failures.flatMap((r) => r.problems.map((p) => p.message))).toEqual(['sha256 must be 64 lowercase hex characters']);
    expect(loose({ source: 'http://mirror.example/x' }).failures.flatMap((r) => r.problems.map((p) => p.message))).toEqual(['source must be an https:// URL']);
  });

  it('a duplicate id or a wrong lock version fails', () => {
    expect(engineGate([engine(), engine()]).failures.flatMap((r) => r.problems.map((p) => p.message))).toContain('duplicate engine id qpdf');
    const g = fixtureGate({ engines: { 'platform-engine/engines.lock.json': { version: 2, engines: [engine()] } } });
    expect(g.failures.flatMap((r) => r.problems.map((p) => p.message))).toContain('$.version: must be 1');
  });

  it('the engine notices list every engine with its licence, source and sha256', () => {
    const text = engineNotices({ version: 1, engines: [engine()] }, { root: APP, policy: POLICY });
    expect(text).toContain('qpdf@12.4.2 — Apache-2.0 — https://github.com/qpdf/qpdf/releases/tag/v12.4.2');
    expect(text).toContain(`sha256 ${sha('a')}; upstream build`);
  });
});

describe('data assets (fonts, ICC profiles)', () => {
  const withRecords = (records: unknown[], extra: Record<string, unknown> = {}) => {
    const policy = clone(POLICY);
    policy.dataAssets.records = records;
    Object.assign(policy.dataAssets, extra);
    return policy;
  };
  const font = (over: Record<string, unknown> = {}) => ({
    name: 'Fixture Sans', files: ['assets/fonts/FixtureSans-*.ttf'], licence: 'OFL-1.1', scope: 'server',
    terms: 'OFL-1.1: embed and redistribute, never sold alone', licenceFile: 'assets/fonts/OFL.txt', ...over,
  });

  it('a font with a complete record passes (control)', () => {
    const g = fixtureGate({ policy: withRecords([font()]), dataAssetFiles: ['assets/fonts/FixtureSans-Bold.ttf'] });
    expect(g.failures).toEqual([]);
  });

  it('a data asset with no recorded terms fails: no record at all, or a record without terms', () => {
    const none = fixtureGate({ policy: withRecords([]), dataAssetFiles: ['platform-engine/assets/icc/GRACoL2013_CRPC6.icc'] });
    expect(kinds(none, 'platform-engine/assets/icc/GRACoL2013_CRPC6.icc')).toEqual(['asset-unrecorded']);
    const noTerms = fixtureGate({ policy: withRecords([font({ terms: '' })]), dataAssetFiles: ['assets/fonts/FixtureSans-Bold.ttf'] });
    expect(kinds(noTerms, 'asset:Fixture Sans')).toEqual(['asset-no-terms']);
  });

  it('a record whose licence text is missing, or two records for one file, fail', () => {
    const missing = fixtureGate({ policy: withRecords([font()]), dataAssetFiles: ['assets/fonts/FixtureSans-Bold.ttf'], exists: (rel) => !rel.endsWith('OFL.txt') });
    expect(kinds(missing, 'asset:Fixture Sans')).toEqual(['asset-no-licence-file']);
    const twice = fixtureGate({ policy: withRecords([font(), font({ name: 'Other' })]), dataAssetFiles: ['assets/fonts/FixtureSans-Bold.ttf'] });
    expect(kinds(twice, 'assets/fonts/FixtureSans-Bold.ttf')).toEqual(['asset-ambiguous']);
  });

  it('a Liberation 1.x entry fails and 2.x passes', () => {
    const lib = (version: string, licence: string) => font({ name: 'Liberation Sans', version, licence, files: ['assets/fonts/LiberationSans-*.ttf'], terms: 'fonts for the print engine' });
    const files = ['assets/fonts/LiberationSans-Regular.ttf'];
    const v1 = fixtureGate({ policy: withRecords([lib('1.07.4', 'GPL-2.0-with-font-exception')]), dataAssetFiles: files });
    expect(kinds(v1, 'asset:Liberation Sans').sort()).toEqual(['asset-version', 'copyleft-not-allowlisted']);
    const v1Mislabelled = fixtureGate({ policy: withRecords([lib('1.07.4', 'OFL-1.1')]), dataAssetFiles: files });
    expect(kinds(v1Mislabelled, 'asset:Liberation Sans')).toEqual(['asset-version']);
    const v2 = fixtureGate({ policy: withRecords([lib('2.1.5', 'OFL-1.1')]), dataAssetFiles: files });
    expect(v2.failures).toEqual([]);
    const unversioned = fixtureGate({ policy: withRecords([font({ name: 'Liberation Serif', files: ['assets/fonts/LiberationSans-*.ttf'] })]), dataAssetFiles: files });
    expect(kinds(unversioned, 'asset:Liberation Serif')).toEqual(['asset-version']);
  });

  it('a browser-served font follows the browser rules', () => {
    const g = fixtureGate({ policy: withRecords([font({ scope: 'browser', licence: 'CC0-1.0' })]), dataAssetFiles: ['assets/fonts/FixtureSans-Bold.ttf'] });
    expect(kinds(g, 'asset:Fixture Sans')).toEqual(['not-allowed']);
  });

  it('an ICC profile with custom terms passes only once the terms are verified', () => {
    const icc = { name: 'GRACoL2013_CRPC6', files: ['platform-engine/assets/icc/*.icc'], licence: 'LicenseRef-GRACoL-ICC', scope: 'engine',
      terms: 'may be embedded in output files; not altered or sold', licenceFile: 'platform-engine/assets/icc/LICENSE.txt' };
    const files = ['platform-engine/assets/icc/GRACoL2013_CRPC6.icc'];
    const unlisted = fixtureGate({ policy: withRecords([icc]), dataAssetFiles: files });
    expect(kinds(unlisted, 'asset:GRACoL2013_CRPC6')).toEqual(['not-allowed']);
    const custom = (verified: boolean) => ({ customLicences: { 'LicenseRef-GRACoL-ICC': { terms: icc.terms, scopes: ['engine'], verified } } });
    const unverified = fixtureGate({ policy: withRecords([icc], custom(false)), dataAssetFiles: files });
    expect(kinds(unverified, 'asset:GRACoL2013_CRPC6')).toEqual(['asset-terms-unverified', 'not-allowed']);
    expect(fixtureGate({ policy: withRecords([icc], custom(true)), dataAssetFiles: files }).failures).toEqual([]);
    const wrongScope = fixtureGate({ policy: withRecords([{ ...icc, scope: 'browser' }], custom(true)), dataAssetFiles: files });
    expect(kinds(wrongScope, 'asset:GRACoL2013_CRPC6')).toEqual(['asset-scope', 'not-allowed']);
  });
});

describe('vendored code and CDN scripts', () => {
  it('vendored code needs a record, its LICENSE and a PATCHES.md', () => {
    const dir = 'packages/platform-render/src/vendor/pptxgenjs';
    expect(fixtureGate({ vendoredDirs: [dir] }).failures).toEqual([]);
    const noFiles = fixtureGate({ vendoredDirs: [dir], exists: () => false });
    expect(kinds(noFiles, 'pptxgenjs').sort()).toEqual(['vendored-no-licence', 'vendored-no-patches']);
    const unknown = fixtureGate({ vendoredDirs: ['lib/vendor/mystery'] });
    expect(kinds(unknown, 'lib/vendor/mystery')).toEqual(['vendored-unrecorded']);
  });

  it('finds vendored code anywhere, public/ included (it ships to browsers as is)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'licence-vendor-'));
    try {
      for (const d of ['public/vendor/widget', 'packages/x/src/vendor/lib', 'node_modules/y/vendor/z', 'dist/vendor/built']) mkdirSync(path.join(root, d), { recursive: true });
      expect(gate.scanVendored(root, POLICY)).toEqual(['packages/x/src/vendor/lib', 'public/vendor/widget']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a CDN script in index.html needs a record with a browser licence', () => {
    const html = (src: string) => [{ file: 'index.html', html: `<script defer src="${src}" integrity="sha512-x"></script>` }];
    expect(fixtureGate({ htmlPages: html('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js') }).failures).toEqual([]);
    const g = fixtureGate({ htmlPages: html('https://cdn.example.com/agpl-widget.js') });
    expect(g.failures.map((r) => r.problems[0].kind)).toEqual(['script-unrecorded']);
  });
});

describe('owner decisions and elections', () => {
  it('a recorded owner decision turns a violation into KNOWN with its reason; a changed licence or version fails again', () => {
    const policy = clone(POLICY);
    policy.exceptions = [{ package: 'odd', version: '1.0.0', licence: 'Elastic-2.0', decision: 'owner', status: 'pending', reason: 'dormant tool, owner deciding' }];
    const known = fixtureGate({ policy, lockfiles: { 'package-lock.json': lockfile({ odd: { license: 'Elastic-2.0' } }) } });
    expect(known.ok).toBe(true);
    expect(known.known.map((r) => [r.name, r.status, r.decision])).toEqual([['odd', 'known', 'owner decision (pending): dormant tool, owner deciding']]);
    expect(gate.formatGate(known)).toMatch(/^KNOWN {2}odd@1\.0\.0 \[server\] Elastic-2\.0/m);
    expect(fixtureGate({ policy, lockfiles: { 'package-lock.json': lockfile({ odd: { license: 'SSPL-1.0' } }) } }).ok).toBe(false);
    expect(fixtureGate({ policy, lockfiles: { 'package-lock.json': lockfile({ odd: { license: 'Elastic-2.0', version: '1.0.1' } }) } }).ok).toBe(false);
  });

  it('every real owner decision names the package, version, licence, where it is used and the options', () => {
    expect(POLICY.exceptions.length).toBeGreaterThan(0);
    for (const e of POLICY.exceptions) {
      expect(e.package).toBeTruthy();
      expect(e.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(e.licence).toBeTruthy();
      expect(e.decision).toBe('owner');
      expect(e.reason).toMatch(/components\/|chunk|used|Pulled in/);
      expect(e.reason).toMatch(/Owner options/);
    }
  });

  it('jszip is recorded under its MIT option, and an election that is not an option fails', () => {
    const eff = gate.effectiveLicence({ name: 'jszip', version: '3.10.1', licence: '(MIT OR GPL-3.0-or-later)' }, POLICY);
    expect(eff.licence).toBe('MIT');
    expect(eff.note).toMatch(/elected MIT/);
    const g = fixtureGate({ lockfiles: { 'package-lock.json': lockfile({ jszip: { license: '(MIT OR GPL-3.0-or-later)' } }) }, browserModules: bundle({ name: 'jszip', licence: '(MIT OR GPL-3.0-or-later)' }) });
    expect(g.failures).toEqual([]);
    expect(g.results.find((r) => r.name === 'jszip')?.effective).toBe('MIT');
    const policy = clone(POLICY);
    policy.elections.jszip.licence = 'Apache-2.0';
    const bad = fixtureGate({ policy, lockfiles: { 'package-lock.json': lockfile({ jszip: { license: '(MIT OR GPL-3.0-or-later)' } }) } });
    expect(kinds(bad, 'jszip')).toEqual(['election-mismatch']);
  });

  it('a non-SPDX licence string is mapped only by a clarification for that exact version', () => {
    const lock = (version: string) => ({ 'package-lock.json': lockfile({ duck: { license: 'BSD', version } }) });
    expect(fixtureGate({ lockfiles: lock('0.1.12') }).failures).toEqual([]);
    // 'BSD' is not an SPDX id on any allowlist: a new version must be read again before it passes.
    expect(kinds(fixtureGate({ lockfiles: lock('0.1.13') }), 'duck')).toEqual(['not-allowed']);
  });
});

describe('notices', () => {
  it('THIRD-PARTY-NOTICES.txt lists each bundled package with the licence we rely on and its own licence text', () => {
    const text = webNotices({ packages: [
      { key: 'node_modules/jszip', name: 'jszip', version: '3.10.1', licence: '(MIT OR GPL-3.0-or-later)' },
      { key: 'node_modules/clsx', name: 'clsx', version: '2.1.1', licence: 'MIT' },
    ], vendored: [] }, { root: APP, policy: POLICY });
    expect(text).toContain('jszip@3.10.1 — MIT');
    expect(text).toMatch(/elected MIT from '\(MIT OR GPL-3\.0-or-later\)'/);
    expect(text).toContain('clsx@2.1.1 — MIT');
    expect(text).toMatch(/==== .*clsx@2\.1\.1.* ====\n\nMIT License/);
    // Browser fonts and CDN scripts are named too.
    expect(text).toContain('IBM Plex Sans — OFL-1.1');
    expect(text).toContain('jspdf@2.5.1 — MIT — https://cdnjs.cloudflare.com/');
    // Deterministic.
    expect(webNotices({ packages: [{ key: 'node_modules/clsx', name: 'clsx', version: '2.1.1', licence: 'MIT' }] }, { root: APP, policy: POLICY }))
      .toBe(webNotices({ packages: [{ key: 'node_modules/clsx', name: 'clsx', version: '2.1.1', licence: 'MIT' }] }, { root: APP, policy: POLICY }));
  });
});

describe('licenceModules() (vite.config.ts)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'licence-modules-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('a real Vite build records the bundled npm packages, writes the report outside dist and emits the notices', async () => {
    const reportFile = path.join(tmp, 'report.json');
    const entry: Plugin = {
      name: 'fixture-entry',
      resolveId: (id) => (id === 'virtual:licence-fixture' ? '\0virtual:licence-fixture' : null),
      load: (id) => (id === '\0virtual:licence-fixture' ? "import { clsx } from 'clsx';\nexport const cls = clsx('a', { b: true });\n" : null),
    };
    const out = (await build({
      configFile: false,
      root: APP,
      logLevel: 'silent',
      publicDir: false,
      plugins: [entry, licenceModules({ root: APP, reportFile })],
      build: { write: false, minify: false, rollupOptions: { input: 'virtual:licence-fixture' } },
    })) as Rollup.RollupOutput;
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    const clsxVersion = JSON.parse(readFileSync(path.join(APP, 'node_modules/clsx/package.json'), 'utf8')).version;
    expect(report.packages).toEqual([{ key: 'node_modules/clsx', name: 'clsx', version: clsxVersion, licence: 'MIT', modules: 1 }]);
    const notices = out.output.find((o) => o.fileName === 'THIRD-PARTY-NOTICES.txt');
    expect(notices?.type).toBe('asset');
    expect(String((notices as Rollup.OutputAsset).source)).toContain(`clsx@${clsxVersion} — MIT`);
    // The report judged by the gate: clsx is browser scope.
    const g = fixtureGate({ lockfiles: { 'package-lock.json': JSON.parse(readFileSync(path.join(APP, 'package-lock.json'), 'utf8')) }, browserModules: report });
    expect(g.results.find((r) => r.name === 'clsx')?.scope).toBe('browser');
  }, 60_000);

  it('worker bundles count as browser code', () => {
    const plugin = licenceModules({ root: APP });
    const worker = plugin.worker();
    const chunk = (ids: string[]) => ({ type: 'chunk', modules: Object.fromEntries(ids.map((id) => [id, {}])) });
    (worker.generateBundle as (this: unknown, o: unknown, b: unknown) => void).call({}, {}, { 'w.js': chunk([path.join(APP, 'node_modules/clsx/dist/clsx.mjs')]) });
    const emitted: { fileName: string; source: string }[] = [];
    (plugin.generateBundle as (this: unknown, o: unknown, b: unknown) => void).call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) }, {}, {
      'main.js': chunk([path.join(APP, 'components/x.tsx')]),
      'font.woff2': { type: 'asset', originalFileNames: [path.join(APP, 'node_modules/@fontsource/bangers/files/bangers-latin-400-normal.woff2')] },
    });
    expect(emitted.map((e) => e.fileName)).toEqual(['THIRD-PARTY-NOTICES.txt']);
    expect(emitted[0].source).toMatch(/^clsx@\S+ — MIT$/m);
    expect(emitted[0].source).toMatch(/^@fontsource\/bangers@\S+ — OFL-1\.1$/m);
  });

  it('the app build uses it for the main bundle and for every worker bundle', () => {
    const config = (viteConfig as unknown as (env: { mode: string; command: string }) => { plugins: { name?: string }[]; worker: { plugins: () => { name?: string }[] } })({ mode: 'production', command: 'build' });
    expect(config.plugins.flat().map((p) => p?.name)).toContain('licence-modules');
    expect(config.worker.plugins().map((p) => p?.name)).toEqual(['licence-modules:worker']);
  });
});

describe('the real repository', () => {
  it('passes the gate: lockfiles, data assets, vendored code, CDN scripts and engines (the bundle runs in CI)', () => {
    const g = gate.runGate({ root: APP });
    expect(g.failures.map((r) => `${r.subject}: ${r.problems.map((p) => p.message).join('; ')}`)).toEqual([]);
    expect(g.ok).toBe(true);
    // Known violations are visible, never silent.
    expect(g.known.map((r) => r.name)).toContain('@codesandbox/nodebox');
    for (const r of g.known) expect(r.decision).toMatch(/^owner decision/);
    // Every font in the repo is covered by a record.
    expect(gate.scanDataAssets(APP, POLICY).length).toBeGreaterThan(0);
  });
});

describe('CI wiring and deploy paths', () => {
  const workflow = (name: string) => readFileSync(path.join(REPO, '.github/workflows', name), 'utf8');
  const HAS_GITHUB = existsSync(path.join(REPO, '.github/workflows'));

  it.skipIf(!HAS_GITHUB)('ci.yml builds with the module report and runs the licence gate before the unit tests', () => {
    const ci = workflow('ci.yml');
    const buildAt = ci.indexOf('- name: Build (frontend)');
    const gateAt = ci.indexOf('- name: Licence gate');
    const testsAt = ci.indexOf('- name: Unit tests');
    expect(buildAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(buildAt);
    expect(testsAt).toBeGreaterThan(gateAt);
    expect(ci.slice(buildAt, gateAt)).toMatch(/LICENCE_MODULES_OUT: \$\{\{ runner\.temp \}\}\/licence\/browser-modules\.json/);
    expect(ci.slice(gateAt, testsAt)).toMatch(/run: node scripts\/licence-check\.mjs --browser-modules "\$RUNNER_TEMP\/licence\/browser-modules\.json" --require-browser-modules --notices dist\/THIRD-PARTY-NOTICES\.txt/);
  });

  it.skipIf(!HAS_GITHUB)('deploy-api-proxy.yml redeploys the backend when packages/platform-core changes', () => {
    const block = /\n {4}paths:\n((?: {6}(?:- '[^']+'|#.*)\n)+)/.exec(workflow('deploy-api-proxy.yml'))?.[1] ?? '';
    const paths = [...block.matchAll(/- '([^']+)'/g)].map((m) => m[1]);
    expect(paths).toContain('dreamstreamcomicstudio/packages/platform-core/**');
  });
});
