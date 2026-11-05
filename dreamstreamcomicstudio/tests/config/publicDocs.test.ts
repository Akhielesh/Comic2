// @vitest-environment node
/**
 * W1.11: the public-repo guard for the shared platform, and a dry run of its release workflow.
 *
 * This repository is public. The platform's docs (docs/platform/**, ADR 0008) and the two release tarballs that
 * .github/workflows/release-platform-core.yml attaches to a public GitHub Release carry only the platform's own wire
 * contract. Private names (kept below only as digests) and security advisory ids must never appear in them. The
 * tarballs are built here, in memory, with the same export.mjs the workflow runs, and every file in them is read.
 *
 * The docs must also stay true to the code: every header, reason, error code, label and job state the wire defines
 * is documented, nothing the wire does not define is, each limit row states its own WIRE_LIMITS values, the bodyless
 * status mapping is failureFromResponse's, and every relative link and anchor resolves. security.md keeps every
 * threat of plan §9 and its UNVERIFIED marks, and the pages agree with ADR 0008 ((k): no model-placed image; L2: every
 * host holds a sub secret).
 *
 * The release workflow is checked for shape (tag trigger, least privilege, pinned actions, Node 22, no expressions
 * inside scripts), and its own run: steps are executed as a dry run: two packs are byte-identical, the verify step
 * refuses a dirty, mismatched or tampered pack, the release job refuses a rebuild that differs from the verified pack,
 * and `gh release create` (a fake on PATH) receives the tag and all four files.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExport, gzipStored, tar } from '../../packages/platform-core/scripts/export.mjs';
import { PLATFORM_ERRORS, PLATFORM_ERROR_CODES, type RetryPolicy } from '../../packages/platform-core/src/errors.js';
import { JOB_STATES, RENDER_MAX_BYTES } from '../../packages/platform-core/src/client/index.js';
import {
  CLAIM_TIERS,
  PLATFORM_HEADERS,
  PREVIEW_CAPABILITIES,
  USER_CLAIM_PURPOSES,
  WIRE_KEY_LABELS,
  WIRE_LIMITS,
  WIRE_REASONS,
  WIRE_REASON_CODES,
  failureFromResponse,
} from '../../packages/platform-core/src/wire/index.js';
import { PLATFORM_DOCS_STAGE } from '../../shared/platform/flags';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const REPO = path.resolve(APP, '..');
const PKG = path.join(APP, 'packages/platform-core');
const DOCS = path.join(APP, 'docs/platform');
const ADR = path.join(APP, 'docs/decisions/0008-shared-platform.md');
const WORKFLOWS = path.join(REPO, '.github/workflows');
const WORKFLOW = path.join(WORKFLOWS, 'release-platform-core.yml');
const PAGES = ['README.md', 'contract.md', 'onboarding.md', 'security.md'];
const SLOW = 120_000;

// ── The banned tokens ───────────────────────────────────────────────────────────────────────────────────────────

/** Public patterns: security advisory ids. */
const BANNED_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'CVE-', re: /\bCVE-/i },
  { label: 'GHSA-', re: /\bGHSA-/i },
];

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Private names that must never reach a public platform doc or release tarball, kept here only as SHA-256 digests of
 * the lower-cased name so this public file does not spell them out. The lead holds the plain list privately; a new
 * name is added as its digest.
 */
const PRIVATE_NAME_DIGESTS: readonly string[] = [
  '2372c598ddf3acb85f431fa8ed612a2bb1309682d363ed5fed1be8f7f31a74a7',
  'c480d9be83fdc34b277d38d5298fda9141297744b7e1778cc74d6fc0fc95d3aa',
  '34608daee9e636e0c9a2f8486ab00d47c0a805b6d6484a1648d93d91cd7b6e08',
  '4c35b47bedcdc599abc81f92a99cec4215a01a5d5f7313ad6c653bf031f09d7f',
  '0fad48f4c1a94e352b92b40f4feb9c0f419044b1559965ad4f4282e5e8456629',
  '1cde5b903653da04b4a629b60c33aa8653abda558c92822bf8056d43ac44cfc3',
  'e46f33a577dd773c3c51496de6c662c2da9fd9ff8a86a3b20d70db38920c1d84',
  'd271b743548b8d54b512ed73100530ca0f77099797812769b5d62061a89fba7d',
  '7658d15a82a30010d9234019a1164f49a081d333ff544129e6d6436fd3e7c748',
  '5723f8da27ccb7b614745e6cbb544ededcdde5b348b91be250079bafbbe21790',
];

/**
 * The candidate names of one line, lower-cased: each run of name characters, split into path segments; every window of
 * one to three consecutive segments (also with a trailing slash when another segment or a slash follows); and the
 * pieces of a segment split at '-', '_' and '.'. So `lib/x/y.ts` yields `lib`, `lib/`, `lib/x`, `lib/x/`, `lib/x/y.ts`,
 * `x`, `x/`, `x/y.ts`, `y.ts`, `y` and `ts`, and a name is found only as a whole word, file name or path window
 * (`oauth.ts`, `auth.tsx` and `x-session.ts` do not contain the name `auth.ts` or `session.ts`).
 */
const candidateNames = (line: string): Set<string> => {
  const out = new Set<string>();
  for (const m of line.toLowerCase().matchAll(/[a-z0-9_.\/-]+/g)) {
    const segs = m[0].split('/');
    for (let i = 0; i < segs.length; i++) {
      for (const piece of segs[i].split(/[-_.]/)) if (piece) out.add(piece);
      for (let n = 1; n <= 3 && i + n <= segs.length; n++) {
        const w = segs.slice(i, i + n).join('/');
        if (!w) continue;
        out.add(w);
        if (i + n < segs.length) out.add(`${w}/`);
      }
    }
  }
  return out;
};

/** A scanner over the public patterns and a set of private name digests (the tests plant stand-in digests). */
const makeScanner = (digests: readonly string[]) => {
  const index = new Map(digests.map((d, i) => [d, `private name ${i + 1}`]));
  return (where: string, text: string): string[] => {
    const out: string[] = [];
    const lines = text.split('\n');
    for (const { label, re } of BANNED_PATTERNS) {
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(`${where}:${i + 1}: ${label}`);
    }
    for (let i = 0; i < lines.length; i++) {
      const hits = new Set<string>();
      for (const c of candidateNames(lines[i])) {
        const label = index.get(sha256Hex(c));
        if (label) hits.add(label);
      }
      for (const label of hits) out.push(`${where}:${i + 1}: ${label}`);
    }
    return out;
  };
};

/** Every banned token in `text`, as `where:line: token` (private names are reported by number, never spelled out). */
const findBanned = makeScanner(PRIVATE_NAME_DIGESTS);

// ── Tarballs ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The regular files of a gzip'd ustar archive, in order: `[path, bytes]`. */
const untar = (tgz: Buffer): [string, Buffer][] => {
  const raw = gunzipSync(tgz);
  const out: [string, Buffer][] = [];
  let at = 0;
  while (at + 512 <= raw.length) {
    const h = raw.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (from: number, len: number) => h.subarray(from, from + len).toString('latin1').replace(/\0.*$/s, '');
    const name = str(0, 100);
    const prefix = str(345, 155);
    const size = parseInt(str(124, 12).trim(), 8);
    const type = String.fromCharCode(h[156]);
    if (!Number.isFinite(size) || size < 0) throw new Error(`untar: bad size for ${name}`);
    const body = raw.subarray(at + 512, at + 512 + size);
    if (type === '0' || type === '\0') out.push([prefix ? `${prefix}/${name}` : name, Buffer.from(body)]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};

/** Every banned token in a tarball's file names and contents. */
const scanTarball = (label: string, tgz: Buffer, scan: (where: string, text: string) => string[] = findBanned): string[] =>
  untar(tgz).flatMap(([name, body]) => [...scan(`${label}!${name} (name)`, name), ...scan(`${label}!${name}`, body.toString('utf8'))]);

// ── Markdown ────────────────────────────────────────────────────────────────────────────────────────────────────

/** GitHub's heading anchors for a Markdown file (duplicates get -1, -2…). */
const anchorsOf = (markdown: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
};

/** The relative links of a Markdown file that do not resolve (file, folder or heading anchor). */
const brokenLinks = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:)/.test(href)) continue;
    const [target, anchor] = href.split('#');
    const resolved = target ? path.resolve(path.dirname(file), target) : file;
    if (!existsSync(resolved)) {
      out.push(`${path.relative(APP, file)}: ${href} (no such file)`);
      continue;
    }
    if (anchor !== undefined) {
      if (!resolved.endsWith('.md') || statSync(resolved).isDirectory()) out.push(`${path.relative(APP, file)}: ${href} (an anchor into a non-Markdown file)`);
      else if (!anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)) out.push(`${path.relative(APP, file)}: ${href} (no such heading)`);
    }
  }
  return out;
};

const read = (file: string): string => readFileSync(file, 'utf8');

// ── The public-docs guard ───────────────────────────────────────────────────────────────────────────────────────

describe('the banned-token scanner', () => {
  // Stand-ins with the same shapes as the private names: a bare word, a folder path, file names, a two-segment path.
  const STANDINS = ['exampled', 'srv/inner/', 'gate.ts', 'store.ts', 'route-gate.ts', 'conn/service.ts', 'schema.dbx'];
  const scan = makeScanner(STANDINS.map(sha256Hex));

  it('holds ten private names as SHA-256 digests, never in plain text', () => {
    expect(PRIVATE_NAME_DIGESTS).toHaveLength(10);
    for (const d of PRIVATE_NAME_DIGESTS) expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(PRIVATE_NAME_DIGESTS).size).toBe(10);
  });

  it('finds every banned token, in any case where it should, and nothing in the near misses', () => {
    const planted = [
      'clone ExampleD first',
      'the exampled-worker deploys it',
      'see SRV/INNER/platform for the wiring',
      'wiring lives in srv/inner/',
      'fixed in cve-2026-0001',
      'advisory GHSA-abcd-efgh-ijkl',
      'gate.ts',
      'src/store.ts:12',
      '`route-gate.ts`',
      'lib/conn/service.ts',
      '(Store.TS)',
      'prisma/schema.dbx',
    ];
    const found = planted.map((line) => scan('t', line));
    for (let i = 0; i < planted.length; i++) expect(found[i], planted[i]).not.toEqual([]);
    // Every stand-in and both public patterns are caught by at least one planted line.
    const labels = new Set(found.flat().map((f) => f.replace(/^t:1: /, '')));
    for (let i = 1; i <= STANDINS.length; i++) expect(labels.has(`private name ${i}`), STANDINS[i - 1]).toBe(true);
    for (const { label } of BANNED_PATTERNS) expect(labels.has(label), label).toBe(true);

    const nearMisses = [
      'the Example skin and skins/example.ts',
      'inner/srv/x and srv/innerness',
      'ogate.ts, useStore.ts, stores.ts, gate.tsx, mygate.ts, x-store.ts',
      'schema.dbxy, CVEX, the GHSAx',
      'packages/platform-core/src/wire/crypto.ts',
    ];
    for (const line of nearMisses) expect(scan('t', line), line).toEqual([]);
  });

  it('reports a private name by number and never spells it out', () => {
    expect(scan('t', 'see srv/inner/x')).toEqual(['t:1: private name 2']);
  });

  it('reads the names and the contents of every file in a planted tarball (export.mjs tar + gzip)', () => {
    const tgz = gzipStored(
      tar([
        ['package/README.md', Buffer.from('# fine\n\nnothing here\n')],
        ['package/src/notes.ts', Buffer.from('// ok\n// wiring lives in srv/inner/platform\n')],
        ['package/src/gate.ts', Buffer.from('export const x = 1;\n')],
        [`package/src/${'deep/'.repeat(20)}long.md`, Buffer.from('see GHSA-0000-0000-0000\n')],
      ]),
    );
    expect(untar(tgz).map(([n]) => n)).toEqual([
      'package/README.md',
      'package/src/notes.ts',
      'package/src/gate.ts',
      `package/src/${'deep/'.repeat(20)}long.md`,
    ]);
    expect(scanTarball('planted.tgz', tgz, scan)).toEqual([
      'planted.tgz!package/src/notes.ts:2: private name 2',
      'planted.tgz!package/src/gate.ts (name):1: private name 3',
      `planted.tgz!package/src/${'deep/'.repeat(20)}long.md:1: GHSA-`,
    ]);
  });
});

describe('docs/platform is public: the wire contract only', () => {
  it('holds the four pages, all Markdown, and no file named for another product', () => {
    const files = readdirSync(DOCS, { recursive: true })
      .map(String)
      .filter((f) => statSync(path.join(DOCS, f)).isFile());
    for (const page of PAGES) expect(files).toContain(page);
    for (const f of files) {
      expect(f, f).toMatch(/\.md$/);
      expect(f, f).not.toMatch(/atlas/i);
    }
  });

  it('carries no banned token in docs/platform/** or ADR 0008', () => {
    const files = readdirSync(DOCS, { recursive: true }).map((f) => path.join(DOCS, String(f))).filter((f) => statSync(f).isFile());
    const problems = [...files, ADR].flatMap((f) => findBanned(path.relative(APP, f), read(f)));
    expect(problems).toEqual([]);
  });

  it('every relative link and anchor in the pages and the ADR resolves', () => {
    expect([...PAGES.map((p) => path.join(DOCS, p)), ADR].flatMap(brokenLinks)).toEqual([]);
  });

  it('ADR 0008 is Proposed and indexed, and the docs index links the platform pages', () => {
    expect(read(ADR)).toMatch(/^# 0008\. /);
    expect(read(ADR)).toMatch(/^- \*\*Status:\*\* Proposed$/m);
    expect(read(path.join(APP, 'docs/decisions/README.md'))).toMatch(/^\| 0008 \| \[[^\]]+\]\(0008-shared-platform\.md\).*\| Proposed \|$/m);
    expect(read(path.join(APP, 'docs/README.md'))).toContain('(platform/contract.md)');
  });

  it('the README documents the three flags with the code defaults', () => {
    const readme = read(path.join(DOCS, 'README.md'));
    const row = (flag: string) => readme.split('\n').find((l) => l.startsWith(`| \`${flag}\` |`)) ?? '';
    expect(row('PLATFORM_DOCS')).toMatch(/Server env/);
    expect(row('VITE_PLATFORM_DOCS')).toMatch(/build var/);
    expect(row('PLATFORM_DOCS_STAGE')).toMatch(new RegExp(`\`'${PLATFORM_DOCS_STAGE}'\` \\|$`));
  });
});

describe('contract.md matches the wire code', () => {
  const contract = read(path.join(DOCS, 'contract.md'));
  const section = (title: string): string => {
    const at = contract.indexOf(`## ${title}`);
    const next = contract.indexOf('\n## ', at + 1);
    return at === -1 ? '' : contract.slice(at, next === -1 ? undefined : next);
  };

  it('documents every header, label, tier, purpose, preview capability and job state', () => {
    for (const h of Object.values(PLATFORM_HEADERS)) expect(contract, h).toContain(`\`${h}\``);
    for (const l of Object.values(WIRE_KEY_LABELS)) expect(contract, l).toContain(`"${l}"`);
    for (const t of CLAIM_TIERS) expect(section('5. Claims'), t).toContain(`\`${t}\``);
    for (const p of USER_CLAIM_PURPOSES) expect(section('5. Claims'), p).toContain(`\`${p}\``);
    for (const c of PREVIEW_CAPABILITIES) expect(section('5. Claims'), c).toContain(`\`${c}\``);
    for (const s of JOB_STATES) expect(section('8. Endpoints, as the client sees them'), s).toContain(`\`${s}\``);
  });

  it('names no header the wire does not define', () => {
    const known = new Set<string>([...Object.values(PLATFORM_HEADERS), 'Content-Length', 'Content-Type']);
    const named = [...contract.matchAll(/`((?:X-[A-Za-z]+(?:-[A-Za-z]+)+|Idempotency-Key))`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(10);
    for (const h of named) expect(known.has(h), h).toBe(true);
  });

  /**
   * Each row of the limits table, and the values it states in order. A value is pinned to its own row, so a limit
   * that shares its number with another (300 s skew and the 300 s claim lifetime, 2,048 for the poll token and the
   * raw query) cannot be misstated while the other keeps the test green.
   */
  const LIMIT_ROWS: readonly [label: string, keys: readonly (keyof typeof WIRE_LIMITS | 'RENDER_MAX_BYTES')[]][] = [
    ['Timestamp skew', ['skewSeconds']],
    ['Claim lifetime', ['claimTtlMaxSeconds', 'claimTtlDefaultSeconds']],
    ['Poll-token lifetime', ['pollTtlMaxSeconds', 'pollTtlDefaultSeconds']],
    ['`Idempotency-Key`', ['idempotencyKeyMax']],
    ['Claim token / poll token', ['claimTokenMax', 'pollTokenMax']],
    ['Capabilities per claim', ['claimCapsMax']],
    ['Secret', ['secretMinBytes']],
    ['Path / raw query / query parameters', ['pathMax', 'queryMax', 'queryParamsMax']],
    ['Request body', ['maxRequestBytes']],
    ['Response body read by the client', ['maxResponseBytes', 'RENDER_MAX_BYTES']],
    ['`?maxPages=` on extract', ['extractDefaultPages', 'extractMaxPages']],
    ['Warnings read', ['warningsMax', 'warningMax']],
    ['File name', ['fileNameMax']],
    ['Error message kept', ['errorMessageMax']],
    ['Callback body', ['callbackBodyMax']],
  ];

  it('the limits table maps every WIRE_LIMITS key (and the render cap) to exactly one row', () => {
    const keys = LIMIT_ROWS.flatMap(([, k]) => k);
    expect([...keys].sort()).toEqual([...Object.keys(WIRE_LIMITS), 'RENDER_MAX_BYTES'].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every row of the limits table states its own WIRE_LIMITS values, in order', () => {
    const rows = section('10. Limits')
      .split('\n')
      .map((l) => /^\| (.+?) \| (.+) \|$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null && m[1] !== 'Limit' && !/^-+$/.test(m[1]));
    expect(rows.map((m) => m[1])).toEqual(LIMIT_ROWS.map(([label]) => label));
    const valueOf = (key: keyof typeof WIRE_LIMITS | 'RENDER_MAX_BYTES'): number => (key === 'RENDER_MAX_BYTES' ? RENDER_MAX_BYTES : WIRE_LIMITS[key]);
    for (const [label, keys] of LIMIT_ROWS) {
      const cell = rows.find((m) => m[1] === label)?.[2] ?? '';
      const stated = [...cell.replace(/(\d),(?=\d{3})/g, '$1').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      expect(stated, label).toEqual(keys.map(valueOf));
    }
  });

  it('the error table is PLATFORM_ERRORS, row by row, and its retry column holds only the retry rule', () => {
    const errors = section('9. Errors');
    expect(errors).toContain('| Code | HTTP | Retryable | Retry rule | Meaning |');
    const rows = errors
      .split('\n')
      .map((l) => /^\| `([a-z-]+)` \| (\d{3}) \| (yes|no) \| ([^|]+) \| ([^|]+) \|$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    expect(rows.map((m) => m[1])).toEqual([...PLATFORM_ERROR_CODES]);
    const RETRY_RULE: Record<RetryPolicy, string> = {
      no: '—',
      'after-reset': 'After the quota window resets',
      once: 'Once',
      yes: 'With backoff',
    };
    for (const m of rows) {
      const spec = PLATFORM_ERRORS[m[1] as keyof typeof PLATFORM_ERRORS];
      expect(Number(m[2]), m[1]).toBe(spec.status);
      expect(m[3] === 'yes', m[1]).toBe(spec.retryable);
      expect(m[4], m[1]).toBe(RETRY_RULE[spec.retry]);
    }
  });

  it('the bodyless status mapping it states is failureFromResponse, for every 3xx, 4xx and 5xx status', () => {
    const para = section('9. Errors')
      .split('\n\n')
      .find((p) => p.includes('without a platform body'));
    expect(para).toBeDefined();
    const text = (para ?? '').replace(/\s+/g, ' ');
    // What the page says: named examples, then (optionally) the whole table, then the fallback by class.
    const named = new Map([...text.matchAll(/(\d{3}) → `([a-z-]+)`/g)].map((m) => [Number(m[1]), m[2]] as const));
    const tableMapsOwn = text.includes('every status in the table above maps to its own code');
    const other4xx = /any other 4xx → `([a-z-]+)`/.exec(text)?.[1];
    const other3xx5xx = /any other 5xx or a 3xx → `([a-z-]+)`/.exec(text)?.[1];
    expect(other4xx).toBeDefined();
    expect(other3xx5xx).toBeDefined();
    const ownCode = (status: number) => PLATFORM_ERROR_CODES.find((c) => PLATFORM_ERRORS[c].status === status);
    const pageSays = (status: number): string | undefined =>
      named.get(status) ?? (tableMapsOwn ? ownCode(status) : undefined) ?? (status >= 400 && status < 500 ? other4xx : other3xx5xx);
    const wrong: string[] = [];
    for (let status = 300; status < 600; status++) {
      const code = failureFromResponse(status, null).code;
      if (pageSays(status) !== code) wrong.push(`${status}: page ${pageSays(status)}, code ${code}`);
    }
    expect(wrong).toEqual([]);
  });

  it('the reasons table is WIRE_REASON_CODES: every reason once, under its own code', () => {
    const lines = section('9. Errors').split('\n');
    const at = lines.indexOf('| Code | Reasons |');
    expect(at).toBeGreaterThan(-1);
    const rows: [string, string][] = [];
    for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const m = /^\| `([a-z-]+)` \| (.*) \|$/.exec(lines[i]);
      expect(m, lines[i]).not.toBeNull();
      rows.push([(m as RegExpExecArray)[1], (m as RegExpExecArray)[2]]);
    }
    expect(rows.map(([code]) => code)).toEqual(['unauthorized', 'forbidden', 'invalid', 'too-large', 'engine-failed']);
    const listed: string[] = [];
    for (const [code, cell] of rows) {
      for (const [, reason] of cell.matchAll(/`([a-z-]+)`/g)) {
        expect((WIRE_REASONS as readonly string[]).includes(reason), `${reason} is not a WIRE_REASON`).toBe(true);
        expect(WIRE_REASON_CODES[reason as keyof typeof WIRE_REASON_CODES], reason).toBe(code);
        listed.push(reason);
      }
    }
    expect([...listed].sort()).toEqual([...WIRE_REASONS].sort());
  });
});

describe('security.md and onboarding.md say what the plan and ADR 0008 decided', () => {
  const security = read(path.join(DOCS, 'security.md'));
  const onboarding = read(path.join(DOCS, 'onboarding.md'));
  const at = security.indexOf('\n## Threats and controls\n');
  const threatsSection = at < 0 ? '' : security.slice(at, security.indexOf('\n## ', at + 1));
  /** The threats table's rows: `[threat, control]`. */
  const threats = threatsSection
    .split('\n')
    .map((l) => /^\| \*\*(.+?)\*\*[^|]* \| (.+?) \| (.+?) \|$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]] as const);
  const control = (threat: string): string => threats.find(([t]) => t === threat)?.[1] ?? '';

  it("plan §9's last two rows have their own places: the public-repo paragraph and 'Holes fixed in wave 1'", () => {
    expect(security).toContain('**This repository is public.**');
    expect(security).toContain('\n## Holes fixed in wave 1\n');
  });

  it('the threats table has every other threat of plan §9, in order', () => {
    expect(threats.map(([t]) => t)).toEqual([
      'Agent output becomes code',
      'Agent writes or sends on its own',
      'Prompt injection from documents or threads',
      'Platform tools reached outside chat',
      'Forged, replayed or cross-tenant calls',
      'Impersonation',
      'Untrusted bytes at the gateway',
      'Hostile files in the engine',
      'Engine compromise',
      'Craft-specific',
      'Output poisoning',
      'SSRF',
      'XSS',
      'Cost and DoS',
      'Supply chain',
      'Data handling',
    ]);
  });

  it('the Craft-specific row carries each of its controls', () => {
    const row = control('Craft-specific');
    for (const part of [
      'GridCraft MCP is never used',
      'PhotoCraft runs only in the heavy pool',
      '`asset.normalize`',
      'the Limits patch',
      'never raw PSD, PSB, TIFF or HEIC',
      'only from our zip ≥ 9.0.5 build',
      'DeckCraft media insert is off',
      'PdfCraft ships no OCR models',
      '`*.rten` or `*.onnx`',
      '`PDFCRAFT_MODELS` is unset',
      'sign and print tools are not allowlisted',
      'stage `admins` until our attested build (W4.1)',
      '`run --script` takes only scripts the adapter generates',
      'MCP runs with per-job roots',
    ])
      expect(row, part).toContain(part);
  });

  it('keeps the plan\'s UNVERIFIED marks, with their fallbacks', () => {
    const marks: Record<string, string[]> = {
      'Untrusted bytes at the gateway': ['`crypto.DigestStream` behaviour UNVERIFIED', 'buffered hashing up to 25 MB, with larger inputs going through jobs'],
      'Hostile files in the engine': ['UNVERIFIED until its wave 2 test passes'],
      'Engine compromise': ['tmpfs and uid switching on Cloudflare Containers are UNVERIFIED', 'recycle the instance after every untrusted job'],
      'Output poisoning': ['the qpdf flags are UNVERIFIED', "the engine's own metadata setting"],
    };
    for (const [threat, parts] of Object.entries(marks)) for (const part of parts) expect(control(threat), `${threat}: ${part}`).toContain(part);
  });

  it('agent output carries no image (ADR 0008 (k)), on both pages', () => {
    expect(read(ADR)).toContain('**(k) A model never places an image anywhere.**');
    expect(control('Agent output becomes code')).toContain('Model-facing schemas carry no image and no asset reference at all (ADR 0008 (k))');
    expect(onboarding).toContain('Model-facing schemas carry no image and no asset reference.');
  });

  it('every host holds a sub secret (L2), DreamStream included; only the app key is outside DreamStream', () => {
    const row = onboarding.split('\n').find((l) => l.startsWith('| 2 |')) ?? '';
    expect(row).toContain('get an app key (**outside DreamStream only**)');
    expect(row).toContain('hold a sub secret (**every host**)');
    const at = onboarding.indexOf('### 2. ');
    const step2 = onboarding.slice(at, onboarding.indexOf('\n### ', at + 1));
    expect(step2.split('\n')[0]).not.toMatch(/outside DreamStream/i);
    expect(step2).toContain('the sub secret rules below\napply to every host, DreamStream included.');
    expect(step2).toContain('**Every host, DreamStream included, also creates and holds its own sub secret** (ADR 0008, L2)');
  });
});

describe('the release tarballs are public: the wire contract only', () => {
  let built: { version: string; files: Record<string, Buffer> };
  beforeAll(() => {
    built = buildExport({ pkg: PKG }) as unknown as { version: string; files: Record<string, Buffer> };
  }, SLOW);

  it('both flavours carry no banned token in any file name or content', () => {
    const tgzs = Object.keys(built.files).filter((n) => n.endsWith('.tgz'));
    expect(tgzs.sort()).toEqual([`platform-core-${built.version}.tgz`, `platform-core-bundler-${built.version}.tgz`]);
    expect(tgzs.flatMap((n) => scanTarball(n, built.files[n]))).toEqual([]);
    expect(findBanned('MANIFEST.json', built.files['MANIFEST.json'].toString('utf8'))).toEqual([]);
  });

  it('the scan reads every file MANIFEST.json lists, byte for byte', () => {
    const manifest = JSON.parse(built.files['MANIFEST.json'].toString('utf8'));
    for (const flavour of ['node16', 'bundler']) {
      const { file, files } = manifest.flavours[flavour] as { file: string; files: Record<string, string> };
      const entries = untar(built.files[file]);
      expect(entries.map(([n]) => n)).toEqual(Object.keys(files).map((p) => `package/${p}`));
      for (const [n, body] of entries) expect(createHash('sha256').update(body).digest('hex'), n).toBe(files[n.slice('package/'.length)]);
    }
  });
});

// ── The release workflow ────────────────────────────────────────────────────────────────────────────────────────

interface Step {
  name: string;
  id?: string;
  uses?: string;
  run?: string;
  env: Record<string, string>;
  with: Record<string, string>;
}

interface Job {
  name: string;
  text: string;
  permissions: Record<string, string>;
  needs?: string;
  steps: Step[];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

const dedent = (lines: string[]): string => {
  const kept = [...lines];
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const min = Math.min(...kept.filter((l) => l.trim()).map(indentOf));
  return kept.map((l) => l.slice(min)).join('\n') + '\n';
};

/** One step (`- key: value` with `run: |`, `env:` and `with:` blocks), as this workflow writes them. */
const parseStep = (lines: string[]): Step => {
  const norm = lines.map((l, i) => (i === 0 ? l.replace(/^(\s*)- /, '$1  ') : l));
  const base = indentOf(norm[0]);
  const step: Step = { name: '', env: {}, with: {} };
  for (let i = 0; i < norm.length; i++) {
    const line = norm[i];
    if (!line.trim()) continue;
    if (indentOf(line) !== base) throw new Error(`unexpected indentation: ${line}`);
    const m = /^\s*([a-z-]+):(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`unparsed step line: ${line}`);
    const key = m[1];
    const value = m[2] ?? '';
    const child: string[] = [];
    while (i + 1 < norm.length && (!norm[i + 1].trim() || indentOf(norm[i + 1]) > base)) child.push(norm[++i]);
    if (key === 'run') {
      if (value !== '|') throw new Error(`run: must be a | block (${step.name})`);
      step.run = dedent(child);
    } else if (key === 'env' || key === 'with') {
      for (const c of child.filter((l) => l.trim())) {
        const kv = /^\s*([A-Za-z0-9_-]+): (.*)$/.exec(c);
        if (!kv) throw new Error(`unparsed ${key} line: ${c}`);
        step[key][kv[1]] = kv[2].replace(/^'(.*)'$/, '$1');
      }
    } else if (key === 'name' || key === 'id' || key === 'uses') step[key] = value;
    else throw new Error(`unexpected step key ${key}`);
  }
  return step;
};

const parseWorkflow = (text: string): { jobs: Job[] } => {
  const lines = text.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  const starts = lines.map((l, i) => (i > jobsAt && /^ {2}[a-z][a-z0-9_-]*:$/.test(l) ? i : -1)).filter((i) => i !== -1);
  const jobs: Job[] = starts.map((start, k) => {
    const body = lines.slice(start, k + 1 < starts.length ? starts[k + 1] : lines.length);
    const job: Job = { name: body[0].trim().slice(0, -1), text: body.join('\n'), permissions: {}, steps: [] };
    const permAt = body.indexOf('    permissions:');
    for (let i = permAt + 1; permAt !== -1 && i < body.length && indentOf(body[i]) === 6 && body[i].trim(); i++) {
      const kv = /^\s*([a-z-]+): ([a-z]+)$/.exec(body[i]);
      if (kv) job.permissions[kv[1]] = kv[2];
    }
    const needs = body.find((l) => /^ {4}needs: /.test(l));
    if (needs) job.needs = needs.trim().slice('needs: '.length);
    const stepsAt = body.indexOf('    steps:');
    const stepStarts = body.map((l, i) => (i > stepsAt && /^ {6}- /.test(l) ? i : -1)).filter((i) => i !== -1);
    job.steps = stepStarts.map((s, j) => parseStep(body.slice(s, j + 1 < stepStarts.length ? stepStarts[j + 1] : body.length)));
    return job;
  });
  return { jobs };
};

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** The dry run needs what the ubuntu runner has: bash, coreutils' sha256sum, diff and git (CI always has them). */
const RUNNER_TOOLS = ['bash', 'sha256sum', 'diff', 'git'].every((cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0);

describe('release-platform-core.yml', () => {
  const text = read(WORKFLOW);
  const { jobs } = parseWorkflow(text);
  const job = (name: string): Job => {
    const j = jobs.find((x) => x.name === name);
    if (!j) throw new Error(`no job ${name}`);
    return j;
  };
  const step = (jobName: string, name: string): Step => {
    const s = job(jobName).steps.find((x) => x.name === name);
    if (!s) throw new Error(`no step "${name}" in ${jobName}`);
    return s;
  };

  it('runs only on a platform-core-v* tag', () => {
    const on = /^on:\n((?: {2,}.*\n)+)/m.exec(text)?.[1];
    expect(on).toBe("  push:\n    tags:\n      - 'platform-core-v*'\n");
  });

  it('is least-privilege: read-only by default, contents: read to pack, contents: write only on the release job', () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(jobs.map((j) => j.name)).toEqual(['pack', 'release']);
    expect(job('pack').permissions).toEqual({ contents: 'read' });
    expect(job('release').permissions).toEqual({ contents: 'write' });
    expect(job('release').needs).toBe('pack');
    const writes = text.split('\n').filter((l) => !l.trimStart().startsWith('#') && /: write\b/.test(l));
    expect(writes).toEqual(['      contents: write']);
    expect(text).not.toMatch(/secrets\./);
    // The token reaches exactly one step, the one that publishes.
    const withToken = jobs.flatMap((j) => j.steps.filter((s) => Object.values(s.env).some((v) => v.includes('github.token'))).map((s) => `${j.name}/${s.name}`));
    expect(withToken).toEqual(['release/Create the release']);
  });

  it('pins every action to a full SHA that another workflow here already uses, and runs Node 22', () => {
    const others = readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f) && f !== 'release-platform-core.yml')
      .map((f) => read(path.join(WORKFLOWS, f)))
      .join('\n');
    const steps = jobs.flatMap((j) => j.steps);
    const uses = steps.filter((s) => s.uses);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const s of uses) {
      expect(s.uses, s.name).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      expect(others, `${s.uses} is not the pin the other workflows use`).toContain(`uses: ${s.uses}`);
    }
    const setupNode = steps.filter((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setupNode).toHaveLength(2);
    for (const s of setupNode) expect(s.with['node-version']).toBe('22');
    const checkouts = steps.filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(2);
    for (const s of checkouts) expect(s.with['persist-credentials']).toBe('false');
  });

  it('puts no ${{ }} expression inside a run: script', () => {
    const runs = jobs.flatMap((j) => j.steps.filter((s) => s.run).map((s) => [`${j.name}/${s.name}`, s.run as string] as const));
    expect(runs.length).toBeGreaterThanOrEqual(6);
    for (const [where, run] of runs) expect(run, where).not.toContain('${{');
  });

  describe.skipIf(!RUNNER_TOOLS)('dry run of its own steps (bash, sha256sum, diff and git, as on the ubuntu runner)', () => {
    const version = JSON.parse(read(path.join(PKG, 'package.json'))).version as string;
    const tag = `platform-core-v${version}`;
    const files = [`platform-core-${version}.tgz`, `platform-core-bundler-${version}.tgz`, 'MANIFEST.json', 'SHA256SUMS'].sort();
    const head = (() => {
      const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : 'unknown';
    })();
    let tmp = '';
    let n = 0;
    let bin = '';
    let packA = '';

    const fresh = (label: string): string => {
      const dir = path.join(tmp, `${label}-${n++}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    /** Run one step's script as Actions does (`bash --noprofile --norc -eo pipefail`), from the repository root. */
    const run = (s: Step, env: Record<string, string>) => {
      const script = path.join(tmp, `step-${n++}.sh`);
      writeFileSync(script, s.run as string);
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: SLOW,
        // A minimal environment: in CI, the runner's own GITHUB_* values must not leak into the dry run.
        env: {
          PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? tmp,
          LANG: 'C.UTF-8',
          GITHUB_REF_NAME: tag,
          GITHUB_SHA: head,
          GITHUB_REPOSITORY: 'example/comic2',
          GITHUB_OUTPUT: path.join(tmp, `output-${n++}.txt`),
          ...env,
        },
      });
    };

    const pack = (jobName: string, runnerTemp: string): string => {
      const r = run(step(jobName, 'Pack both flavours'), { RUNNER_TEMP: runnerTemp });
      expect(r.status, r.stderr).toBe(0);
      return path.join(runnerTemp, 'platform-core');
    };

    /** A copy of pack A whose MANIFEST.json says what `manifest` says, with SHA256SUMS rewritten to match. */
    const staged = (patch: (manifest: Record<string, unknown>) => void, tamper?: (dir: string) => void): string => {
      const runnerTemp = fresh('staged');
      const dir = path.join(runnerTemp, 'platform-core');
      cpSync(packA, dir, { recursive: true });
      const manifest = JSON.parse(read(path.join(dir, 'MANIFEST.json')));
      patch(manifest);
      writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
      const sums = ['MANIFEST.json', ...files.filter((f) => f.endsWith('.tgz'))]
        .sort()
        .map((f) => `${sha256(readFileSync(path.join(dir, f)))}  ${f}\n`)
        .join('');
      writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
      tamper?.(dir);
      return runnerTemp;
    };

    const verify = (runnerTemp: string, env: Record<string, string> = {}) => {
      const output = path.join(runnerTemp, 'github-output.txt');
      writeFileSync(output, '');
      const r = run(step('pack', 'Verify the release files'), { RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output, ...env });
      return { ...r, output: read(output) };
    };

    beforeAll(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'release-dry-run-'));
      bin = path.join(tmp, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" > "$FAKE_GH_LOG"\n');
      chmodSync(path.join(bin, 'gh'), 0o755);
      packA = pack('pack', fresh('pack-a'));
    }, SLOW);

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it('packs twice into byte-identical artifacts: both flavours, MANIFEST.json and SHA256SUMS', () => {
      const packB = pack('pack', fresh('pack-b'));
      expect(readdirSync(packA).sort()).toEqual(files);
      expect(readdirSync(packB).sort()).toEqual(files);
      for (const f of files) expect(readFileSync(packA + '/' + f).equals(readFileSync(packB + '/' + f)), f).toBe(true);
    }, SLOW);

    it('"Pack again and compare" passes on a real pack and fails when the first pack was altered', () => {
      const runnerTemp = path.dirname(packA);
      const ok = run(step('pack', 'Pack again and compare'), { RUNNER_TEMP: runnerTemp });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('byte-identical');

      const altered = fresh('altered');
      cpSync(packA, path.join(altered, 'platform-core'), { recursive: true });
      const tgz = path.join(altered, 'platform-core', `platform-core-${version}.tgz`);
      const bytes = readFileSync(tgz);
      bytes[bytes.length - 20] ^= 0xff;
      writeFileSync(tgz, bytes);
      const bad = run(step('pack', 'Pack again and compare'), { RUNNER_TEMP: altered });
      expect(bad.status).not.toBe(0);
    }, SLOW);

    it('the verify step passes a clean pack of the tagged commit and hands on the version and the SHA256SUMS digest', () => {
      const runnerTemp = staged((m) => {
        m.clean = true;
        m.gitSha = head;
      });
      const r = verify(runnerTemp);
      expect(r.status, r.stderr).toBe(0);
      const sums = sha256(readFileSync(path.join(runnerTemp, 'platform-core/SHA256SUMS')));
      expect(r.output).toBe(`version=${version}\nsums=${sums}\n`);
      expect(r.stdout).toContain(`platform-core-${version}.tgz: OK`); // sha256sum -c ran too
    }, SLOW);

    const refusals: [string, (m: Record<string, unknown>) => void, Record<string, string>, ((dir: string) => void) | undefined, RegExp][] = [
      ['a dirty package folder (clean: false)', (m) => ((m.clean = false), (m.gitSha = head)), {}, undefined, /clean is false/],
      ['an export outside git (clean: null)', (m) => ((m.clean = null), (m.gitSha = head)), {}, undefined, /clean is null/],
      ['a pack of another commit', (m) => ((m.clean = true), (m.gitSha = '0'.repeat(40))), {}, undefined, /not the tagged commit/],
      ['a tag for another version', (m) => ((m.clean = true), (m.gitSha = head)), { GITHUB_REF_NAME: 'platform-core-v9.9.9' }, undefined, /package\.json says/],
      ['a tag that is not semver', (m) => ((m.clean = true), (m.gitSha = head)), { GITHUB_REF_NAME: 'platform-core-vnext' }, undefined, /not platform-core-v<semver>/],
      [
        'a tarball that differs from MANIFEST.json',
        (m) => ((m.clean = true), (m.gitSha = head)),
        {},
        (dir) => {
          const f = path.join(dir, `platform-core-${version}.tgz`);
          const b = readFileSync(f);
          b[b.length - 20] ^= 0xff;
          writeFileSync(f, b);
          const sums = read(path.join(dir, 'SHA256SUMS')).replace(/^[0-9a-f]{64}(  platform-core-\d)/m, `${sha256(b)}$1`);
          writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
        },
        /does not match MANIFEST\.json/,
      ],
      [
        'SHA256SUMS that does not match',
        (m) => ((m.clean = true), (m.gitSha = head)),
        {},
        (dir) => writeFileSync(path.join(dir, 'SHA256SUMS'), read(path.join(dir, 'SHA256SUMS')).replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0'))),
        /SHA256SUMS does not match/,
      ],
      ['an extra file', (m) => ((m.clean = true), (m.gitSha = head)), {}, (dir) => writeFileSync(path.join(dir, 'notes.txt'), 'x'), /expected exactly/],
    ];

    it.each(refusals)('the verify step refuses %s', (_label, patch, env, tamper, message) => {
      const r = verify(staged(patch, tamper), env);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(message);
      expect(r.output).toBe('');
    }, SLOW);

    it('the release job refuses a rebuild whose SHA256SUMS is not the verified one', () => {
      const runnerTemp = fresh('release');
      pack('release', runnerTemp);
      const check = step('release', 'Check the rebuild matches the pack job');
      expect(check.env).toEqual({ PACKED_SUMS: '${{ needs.pack.outputs.sums }}' });
      const verified = sha256(readFileSync(path.join(packA, 'SHA256SUMS')));
      const ok = run(check, { RUNNER_TEMP: runnerTemp, PACKED_SUMS: verified });
      expect(ok.status, ok.stderr + ok.stdout).toBe(0);
      for (const wrong of ['0'.repeat(64), '']) {
        const bad = run(check, { RUNNER_TEMP: runnerTemp, PACKED_SUMS: wrong });
        expect(bad.status, `PACKED_SUMS=${wrong}`).not.toBe(0);
        expect(bad.stdout).toContain('::error::');
      }
    }, SLOW);

    it('publishes the tag with all four files through gh, and marks a pre-release as one', () => {
      const runnerTemp = fresh('publish');
      const dir = pack('release', runnerTemp);
      const create = step('release', 'Create the release');
      expect(Object.keys(create.env).sort()).toEqual(['GH_TOKEN', 'VERSION']);
      const publish = (v: string) => {
        const log = path.join(tmp, `gh-${n++}.log`);
        const r = run(create, { RUNNER_TEMP: runnerTemp, VERSION: v, GH_TOKEN: 'fake-token', FAKE_GH_LOG: log });
        expect(r.status, r.stderr).toBe(0);
        return read(log).split('\0').slice(0, -1);
      };

      const args = publish(version);
      expect(args.slice(0, 3)).toEqual(['release', 'create', tag]);
      expect(args).toContain('--verify-tag');
      expect(args[args.indexOf('--repo') + 1]).toBe('example/comic2');
      expect(args[args.indexOf('--title') + 1]).toBe(`platform-core ${version}`);
      expect(args[args.indexOf('--notes') + 1]).toContain('sha256sum -c SHA256SUMS');
      expect(args).not.toContain('--prerelease');
      const attached = args.slice(-4);
      expect(attached.map((a) => path.basename(a)).sort()).toEqual(files);
      for (const a of attached) expect(path.dirname(a)).toBe(dir);
      for (const a of attached) expect(existsSync(a), a).toBe(true);

      expect(publish('1.1.0-rc.1')).toContain('--prerelease');
    }, SLOW);
  });
});
