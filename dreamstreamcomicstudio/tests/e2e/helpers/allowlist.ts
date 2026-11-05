// Allowlist for the layout & device harness (P1-QA). Pure (Node side, no browser).
//
// tests/e2e/allowlist.json has three lists:
//   falsePositives     accepted results that are correct by design (visualqa.md §3) — kept for good;
//   knownFailures      real findings on TODAY's UI, each tagged with the package that owns the fix
//                      (`owner`) and `removeBy: "wave3"`; P3-OVERFLOW empties this list for new components;
//   knownTestFailures  behavioural specs that cannot pass yet (feature not built / owned elsewhere):
//                      `mode: "fail"` runs them as expected failures (an unexpected pass is reported so the
//                      entry gets removed), `mode: "skip"` skips them.
// A finding that matches an entry is reported as an annotation, never silently dropped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECK_IDS = [
  'overflow',
  'offscreen',
  'clip',
  'self-clip',
  'spill',
  'input-clip',
  'textarea-clip',
  'collision',
  'popover',
  'balloon-outside',
  'balloon-collision',
  'editor-aside',
  'phone-content',
  'hit-target',
  'hover-only',
  'safe-area',
  'hinge',
  'landmarks',
  'layout-class',
  'axe',
  'console'
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface Finding {
  check: CheckId;
  /** tag.class1.class2… of the offending element. */
  sig: string;
  /** Accessible name or visible text (≤ 60 chars). */
  label: string;
  /** Nearest labelled ancestors ("Page tools < Page 1 editor"). */
  ctx: string;
  /** Closest data-testid (self or ancestor). */
  testid?: string;
  /** [left, top, width, height] in CSS px. */
  rect?: number[];
  /** Check-specific numbers ("right=412 vw=360", "38x30 stolen by button.…"). */
  detail?: string;
}

export interface AllowEntry {
  id: string;
  check: CheckId | '*';
  owner: string;
  reason: string;
  /** Glob patterns over project names (default: every project). */
  projects?: string[];
  surfaces?: string[];
  scenes?: string[];
  fixtures?: string[];
  /** Case-insensitive regular expressions; every given field must match. */
  match?: Partial<Record<'sig' | 'label' | 'ctx' | 'testid' | 'detail', string>>;
  removeBy?: string;
}

export interface KnownTestFailure {
  id: string;
  /** Case-insensitive regex over "<file> › <title path>". */
  test: string;
  projects?: string[];
  owner: string;
  reason: string;
  mode: 'fail' | 'skip';
  removeBy?: string;
}

export interface Allowlist {
  version: 1;
  falsePositives: AllowEntry[];
  knownFailures: AllowEntry[];
  knownTestFailures: KnownTestFailure[];
}

export interface Where {
  project: string;
  surface: string;
  scene: string;
  fixture?: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ALLOWLIST_PATH = path.resolve(HERE, '../allowlist.json');

let cached: Allowlist | null = null;
export const loadAllowlist = (file = ALLOWLIST_PATH): Allowlist => {
  if (cached && file === ALLOWLIST_PATH) return cached;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Allowlist;
  const list: Allowlist = { version: 1, falsePositives: parsed.falsePositives || [], knownFailures: parsed.knownFailures || [], knownTestFailures: parsed.knownTestFailures || [] };
  if (file === ALLOWLIST_PATH) cached = list;
  return list;
};

const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const globMatch = (globs: string[] | undefined, value: string) => !globs || globs.length === 0 || globs.some((g) => globRe(g).test(value));

export const entryMatches = (e: AllowEntry, f: Finding, w: Where): boolean => {
  if (e.check !== '*' && e.check !== f.check) return false;
  if (!globMatch(e.projects, w.project) || !globMatch(e.surfaces, w.surface) || !globMatch(e.scenes, w.scene) || !globMatch(e.fixtures, w.fixture || '')) return false;
  for (const [field, pattern] of Object.entries(e.match || {})) {
    if (pattern === undefined) continue;
    const value = (f as unknown as Record<string, string | undefined>)[field] ?? '';
    if (!new RegExp(pattern, 'i').test(value)) return false;
  }
  return true;
};

export interface Triage {
  fresh: Finding[];
  allowed: Array<{ finding: Finding; entry: AllowEntry; kind: 'false-positive' | 'known-failure' }>;
}

/** Split findings into new failures and allowlisted ones (false positives first, then known failures). */
export const triage = (findings: Finding[], w: Where, list: Allowlist = loadAllowlist()): Triage => {
  const out: Triage = { fresh: [], allowed: [] };
  for (const f of findings) {
    const fp = list.falsePositives.find((e) => entryMatches(e, f, w));
    if (fp) {
      out.allowed.push({ finding: f, entry: fp, kind: 'false-positive' });
      continue;
    }
    const kf = list.knownFailures.find((e) => entryMatches(e, f, w));
    if (kf) out.allowed.push({ finding: f, entry: kf, kind: 'known-failure' });
    else out.fresh.push(f);
  }
  return out;
};

export const knownTestFailure = (titlePath: string, project: string, list: Allowlist = loadAllowlist()): KnownTestFailure | undefined =>
  list.knownTestFailures.find((k) => new RegExp(k.test, 'i').test(titlePath) && globMatch(k.projects, project));

const OWNER_RE = /^P[0-9]-[A-Z0-9-]+$/;

/** Schema and hygiene checks (run by harness.selftest.spec.ts). Returns human-readable problems. */
export const validateAllowlist = (list: Allowlist): string[] => {
  const problems: string[] = [];
  const ids = new Set<string>();
  const checkEntry = (e: AllowEntry, kind: 'falsePositives' | 'knownFailures') => {
    const at = `${kind}/${e.id || '?'}`;
    if (!e.id || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) problems.push(`${at}: id must be kebab-case`);
    if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (e.check !== '*' && !(CHECK_IDS as readonly string[]).includes(e.check)) problems.push(`${at}: unknown check "${e.check}"`);
    if (!OWNER_RE.test(e.owner || '')) problems.push(`${at}: owner must be a package id like P1-SHELL`);
    if (!e.reason || e.reason.length < 12) problems.push(`${at}: reason is required`);
    if (kind === 'knownFailures' && !e.removeBy) problems.push(`${at}: known failures need removeBy (e.g. "wave3")`);
    if (kind === 'knownFailures' && (!e.match || Object.keys(e.match).length === 0) && !(e.surfaces?.length || e.scenes?.length || e.fixtures?.length))
      problems.push(`${at}: a known failure must be scoped (match, surfaces, scenes or fixtures) — never allowlist a whole check everywhere`);
    for (const [field, pattern] of Object.entries(e.match || {})) {
      try {
        new RegExp(pattern as string, 'i');
      } catch {
        problems.push(`${at}: match.${field} is not a valid regex`);
      }
    }
  };
  list.falsePositives.forEach((e) => checkEntry(e, 'falsePositives'));
  list.knownFailures.forEach((e) => checkEntry(e, 'knownFailures'));
  for (const k of list.knownTestFailures) {
    const at = `knownTestFailures/${k.id || '?'}`;
    if (ids.has(k.id)) problems.push(`${at}: duplicate id`);
    ids.add(k.id);
    if (!OWNER_RE.test(k.owner || '')) problems.push(`${at}: owner must be a package id like P1-LETTER-UI`);
    if (k.mode !== 'fail' && k.mode !== 'skip') problems.push(`${at}: mode must be "fail" or "skip"`);
    if (!k.removeBy) problems.push(`${at}: removeBy is required`);
    try {
      new RegExp(k.test, 'i');
    } catch {
      problems.push(`${at}: test is not a valid regex`);
    }
  }
  return problems;
};

/** One line per finding, for failure messages. */
export const describeFinding = (f: Finding): string =>
  `[${f.check}] ${f.sig}${f.label ? ` "${f.label}"` : ''}${f.testid ? ` {${f.testid}}` : ''}${f.ctx ? ` in ${f.ctx}` : ''}${f.detail ? ` — ${f.detail}` : ''}${f.rect ? ` @${f.rect.join(',')}` : ''}`;
