/**
 * The capability registry (plan §5.3): everything the platform can do to a document, which engines do it (in order:
 * the gateway picks the first healthy one allowed for the input's trust), what it accepts and how it is gated.
 *
 * There is deliberately no `email.send`, no `connector.*` and no `sheet.*`: the platform renders, extracts and
 * converts; hosts own connectors and nothing sends. `assertCapabilityRegistry` (run by the tests) fails on a name
 * that sends, a duplicate id, an empty engine list or a missing limit.
 */
import type { GateClass } from './gates/gates.js';
import type { PlatformWave } from './tools/types.js';
import { FORBIDDEN_NAME } from './tools/types.js';

export const CAPABILITY_IDS = [
  'email.render',
  'richdoc.export',
  'deck.export',
  'doc.extract',
  'pdf.sanitize',
  'pdf.inspect',
  'pdf.fill',
  'pdf.redact',
  'pdf.organize',
  'doc.thumbnail',
  'asset.normalize',
  'print.book',
  'print.preflight',
  'richdoc.render',
  'deck.render',
  'doc.convert',
  'image.psd',
  'layout.idml',
  'comic.cbz',
  'comic.epub',
  'comic.strip',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type CapabilityKind = 'render' | 'extract' | 'convert' | 'pdf' | 'image' | 'print';

/** `core` runs inside the host (pure); `browser` in the user's browser; `engine` / `engine-heavy` in the two pools. */
export type CapabilityWhere = 'core' | 'browser' | 'engine' | 'engine-heavy';

/** `own`: only a container format our code produced. `untrusted-ok`: user files, after the engine's preflight. */
export type CapabilityTrust = 'own' | 'untrusted-ok';

export type CapabilityMaturity = 'adopt' | 'trial' | 'lab';

/** The plan tiers a user claim carries (wire claims, plan §5.8). */
export type PlanTier = 'free' | 'creator' | 'studio' | 'admin' | 'atlas-beta';

/** Rollout stages (`PLATFORM_DOCS_STAGE`). */
export type PlatformStage = 'off' | 'admins' | 'everyone';

export interface EngineRef {
  /** Engine id as `engines.lock.json` names it (`pdfcraft`, `docx`, `core.renderEmail`). */
  id: string;
  version: string;
  /** A TRIAL engine runs only where its capability says, and never as the only engine for a user's file. */
  maturity?: 'adopt' | 'trial';
  /** Which inputs this engine takes when the capability splits by format (`.doc/.rtf`, `DOCX`). */
  inputs?: readonly string[];
}

export interface CapabilityLimits {
  /** Largest input (or, for exports, output) in bytes (10^6 per MB). */
  maxBytes: number;
  maxPages?: number;
  timeoutMs: number;
}

export interface CapabilitySpec {
  id: CapabilityId;
  kind: CapabilityKind;
  where: CapabilityWhere;
  /** Ordered: the first healthy engine allowed for the input's trust runs. */
  engines: readonly EngineRef[];
  trust: CapabilityTrust;
  gate: GateClass;
  /** Plan tiers that may use it (absent: every tier). The host's plan check, before its quota check. */
  plans?: readonly PlanTier[];
  /** The widest rollout stage allowed until the evidence lands (absent: no ceiling beyond the platform's own). */
  stageCeiling?: PlatformStage;
  /** Results on user content are copies; a person confirms before the copy is made (the tool proposes). */
  copyOnUserContent?: boolean;
  limits: CapabilityLimits;
  maturity: CapabilityMaturity;
  wave: PlatformWave;
  /** What must be true before it moves up (a bake-off, an owner decision, an attested build). */
  evidence?: string;
  /** The date this entry was added or last changed (YYYY-MM-DD). */
  since: string;
}

const MB = 1000000;
const SINCE = '2026-10-30';
const PRINT_PLANS: readonly PlanTier[] = ['studio', 'admin'];

const define = (spec: CapabilitySpec): Readonly<CapabilitySpec> => Object.freeze({ ...spec, engines: Object.freeze(spec.engines.map((e) => Object.freeze({ ...e }))) });

/** Plan §5.3, row by row. */
export const CAPABILITIES: readonly Readonly<CapabilitySpec>[] = Object.freeze([
  define({
    id: 'email.render',
    kind: 'render',
    where: 'core',
    engines: [{ id: 'core.renderEmail', version: '1' }],
    trust: 'own',
    gate: 'none',
    limits: { maxBytes: 2 * MB, timeoutMs: 2000 },
    maturity: 'adopt',
    wave: 1,
    since: SINCE,
  }),
  define({
    id: 'richdoc.export',
    kind: 'render',
    where: 'browser',
    engines: [{ id: 'docx', version: '9.15.0' }],
    trust: 'own',
    gate: 'none',
    limits: { maxBytes: 40 * MB, timeoutMs: 60000 },
    maturity: 'adopt',
    wave: 1,
    since: SINCE,
  }),
  define({
    id: 'deck.export',
    kind: 'render',
    where: 'browser',
    engines: [{ id: 'pptxgenjs', version: '4.0.1+ds1' }],
    trust: 'own',
    gate: 'none',
    limits: { maxBytes: 40 * MB, timeoutMs: 120000 },
    maturity: 'adopt',
    wave: 1,
    evidence: 'The deck cap (40 MB) keeps a phone from running out of memory; over it the export says so.',
    since: SINCE,
  }),
  define({
    id: 'doc.extract',
    kind: 'extract',
    where: 'engine',
    engines: [
      { id: 'mammoth', version: '1.13.0', inputs: ['docx'] },
      { id: 'unpdf', version: '2.1.0', inputs: ['pdf'] },
    ],
    trust: 'untrusted-ok',
    gate: 'quota',
    limits: { maxBytes: 50 * MB, maxPages: 300, timeoutMs: 25000 },
    maturity: 'adopt',
    wave: 2,
    since: SINCE,
  }),
  define({
    id: 'pdf.sanitize',
    kind: 'pdf',
    where: 'engine',
    engines: [{ id: 'qpdf', version: '12.4.2' }],
    trust: 'untrusted-ok',
    gate: 'quota',
    limits: { maxBytes: 50 * MB, maxPages: 200, timeoutMs: 25000 },
    maturity: 'adopt',
    wave: 2,
    evidence: 'The JSON v2 round trip is unverified until its wave 2 test passes.',
    since: SINCE,
  }),
  ...(['pdf.inspect', 'pdf.fill', 'pdf.redact', 'pdf.organize'] as const).map((id) =>
    define({
      id,
      kind: 'pdf',
      where: 'engine',
      engines: [{ id: 'pdfcraft', version: '0.15.0' }],
      trust: 'untrusted-ok',
      gate: 'quota',
      stageCeiling: 'admins',
      copyOnUserContent: id !== 'pdf.inspect',
      limits: { maxBytes: 50 * MB, maxPages: 200, timeoutMs: 25000 },
      maturity: 'adopt',
      wave: 2,
      evidence: 'Owner decision D2; stage admins until our attested build (W4.1).',
      since: SINCE,
    }),
  ),
  define({
    id: 'doc.thumbnail',
    kind: 'render',
    where: 'engine',
    engines: [{ id: 'pdfcraft', version: '0.15.0' }],
    trust: 'untrusted-ok',
    gate: 'quota',
    stageCeiling: 'admins',
    limits: { maxBytes: 50 * MB, maxPages: 1, timeoutMs: 25000 },
    maturity: 'adopt',
    wave: 2,
    evidence: 'Owner decision D2; stage admins until our attested build (W4.1).',
    since: SINCE,
  }),
  define({
    id: 'asset.normalize',
    kind: 'image',
    where: 'engine',
    engines: [{ id: 'sharp', version: '0.35.5' }],
    trust: 'untrusted-ok',
    gate: 'none',
    limits: { maxBytes: 50 * MB, timeoutMs: 25000 },
    maturity: 'adopt',
    wave: 2,
    evidence: 'Sniffed, at most 50 MP and 12,000 px, re-encoded to PNG or WebP; the output is tagged origin=generated.',
    since: SINCE,
  }),
  define({
    id: 'print.book',
    kind: 'print',
    where: 'engine-heavy',
    engines: [
      { id: 'pdfkit', version: '0.20.2+sharp-cmyk' },
      { id: 'designcraft', version: '0.14.0', maturity: 'trial' },
    ],
    trust: 'own',
    gate: 'quota',
    plans: PRINT_PLANS,
    limits: { maxBytes: 150 * MB, maxPages: 800, timeoutMs: 300000 },
    maturity: 'adopt',
    wave: 2,
    evidence: 'A passing KDP and Lulu file check and a physical proof before print is sold.',
    since: SINCE,
  }),
  define({
    id: 'print.preflight',
    kind: 'print',
    where: 'engine-heavy',
    engines: [
      { id: 'poppler', version: 'pinned' },
      { id: 'designcraft', version: '0.14.0', maturity: 'trial' },
    ],
    trust: 'own',
    gate: 'none',
    limits: { maxBytes: 150 * MB, maxPages: 800, timeoutMs: 120000 },
    maturity: 'adopt',
    wave: 2,
    since: SINCE,
  }),
  define({
    id: 'richdoc.render',
    kind: 'render',
    where: 'engine',
    engines: [
      { id: 'wordcraft-cli', version: '0.12.0', inputs: ['pdf', 'png'] },
      { id: 'docx', version: '9.15.0', inputs: ['docx'] },
    ],
    trust: 'own',
    gate: 'quota',
    limits: { maxBytes: 10 * MB, timeoutMs: 25000 },
    maturity: 'adopt',
    wave: 4,
    evidence: 'Owner decision D2.',
    since: SINCE,
  }),
  define({
    id: 'deck.render',
    kind: 'render',
    where: 'engine',
    engines: [{ id: 'deckcraft-cli', version: '0.12.0' }],
    trust: 'own',
    gate: 'quota',
    limits: { maxBytes: 10 * MB, timeoutMs: 25000 },
    maturity: 'adopt',
    wave: 4,
    evidence: 'Owner decision D2.',
    since: SINCE,
  }),
  define({
    id: 'doc.convert',
    kind: 'convert',
    where: 'engine',
    engines: [
      { id: 'wordcraft-cli', version: '0.12.0', inputs: ['doc', 'rtf'] },
      { id: 'craft-forks-zip9', version: 'pending', inputs: ['docx', 'odt', 'pptx'] },
    ],
    trust: 'untrusted-ok',
    gate: 'quota',
    limits: { maxBytes: 50 * MB, timeoutMs: 25000 },
    maturity: 'trial',
    wave: 4,
    evidence: 'Legacy formats: a hostile corpus passes and they are at least 2% of uploads. OOXML/ODT: the zip >= 9.0.5 build (D3). Anything else answers 415.',
    since: SINCE,
  }),
  define({
    id: 'image.psd',
    kind: 'image',
    where: 'engine-heavy',
    engines: [
      { id: 'ag-psd', version: '31.0.3' },
      { id: 'photocraft', version: '0.17.0', maturity: 'trial' },
    ],
    trust: 'own',
    gate: 'quota',
    plans: ['creator', 'studio', 'admin'],
    limits: { maxBytes: 150 * MB, timeoutMs: 120000 },
    maturity: 'adopt',
    wave: 5,
    evidence: 'PhotoCraft moves up only when upstream ships memory and duration budgets.',
    since: SINCE,
  }),
  define({
    id: 'layout.idml',
    kind: 'print',
    where: 'engine-heavy',
    engines: [{ id: 'designcraft', version: '0.14.0', maturity: 'trial' }],
    trust: 'own',
    gate: 'quota',
    plans: PRINT_PLANS,
    limits: { maxBytes: 150 * MB, timeoutMs: 120000 },
    maturity: 'trial',
    wave: 5,
    evidence: 'Wins the print bake-off.',
    since: SINCE,
  }),
  ...(['comic.cbz', 'comic.epub', 'comic.strip'] as const).map((id) =>
    define({
      id,
      kind: 'render',
      where: 'browser',
      engines: [{ id: 'jszip', version: '3.10.1' }],
      trust: 'own',
      gate: 'none',
      limits: { maxBytes: 200 * MB, timeoutMs: 120000 },
      maturity: 'adopt',
      wave: 3,
      since: SINCE,
    }),
  ),
]);

export const isCapabilityId = (value: unknown): value is CapabilityId =>
  typeof value === 'string' && (CAPABILITY_IDS as readonly string[]).indexOf(value) !== -1;

/** The spec for `id`, or `undefined`. */
export const getCapability = (id: string): Readonly<CapabilitySpec> | undefined => {
  for (const c of CAPABILITIES) if (c.id === id) return c;
  return undefined;
};

/** Capabilities shipped by `wave` (inclusive). */
export const capabilitiesUpToWave = (wave: PlatformWave): readonly Readonly<CapabilitySpec>[] => CAPABILITIES.filter((c) => c.wave <= wave);

/**
 * Every rule the registry must hold; returns the problems (empty when sound). Tests assert it is empty, and
 * `defineProduct` relies on it.
 */
export const capabilityRegistryProblems = (list: readonly CapabilitySpec[] = CAPABILITIES): string[] => {
  const problems: string[] = [];
  const seen: string[] = [];
  for (const c of list) {
    if (seen.indexOf(c.id) !== -1) problems.push(`${c.id}: duplicate id`);
    seen.push(c.id);
    if (!isCapabilityId(c.id)) problems.push(`${c.id}: not in CAPABILITY_IDS`);
    if (FORBIDDEN_NAME.test(c.id) || FORBIDDEN_NAME.test(c.kind)) problems.push(`${c.id}: a capability may never send`);
    if (!c.engines.length) problems.push(`${c.id}: no engine`);
    for (const e of c.engines) if (FORBIDDEN_NAME.test(e.id)) problems.push(`${c.id}: engine ${e.id} is named like it sends`);
    if (!(c.limits.maxBytes > 0) || !(c.limits.timeoutMs > 0)) problems.push(`${c.id}: limits need maxBytes and timeoutMs`);
    if (c.limits.maxPages !== undefined && !(c.limits.maxPages > 0)) problems.push(`${c.id}: maxPages must be positive`);
    if (c.engines.every((e) => e.maturity === 'trial') && c.maturity === 'adopt') problems.push(`${c.id}: an adopted capability needs a non-trial engine`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.since)) problems.push(`${c.id}: since must be YYYY-MM-DD`);
  }
  for (const id of CAPABILITY_IDS) if (list === CAPABILITIES && seen.indexOf(id) === -1) problems.push(`${id}: listed in CAPABILITY_IDS but not defined`);
  return problems;
};
