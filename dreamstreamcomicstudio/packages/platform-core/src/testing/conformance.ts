/**
 * The conformance kit (plan §6): eleven checks a host runs against ITS OWN ports. Each check is a plain async
 * function returning pass, fail (with the reason) or skip (a port the host has not wired yet), so it runs under any
 * test runner:
 *
 *     for (const c of CONFORMANCE_CHECKS) it(c.title, async () => expect(await c.run(subject)).toEqual({ status: 'pass' }));
 *
 * or all at once with `runConformance(subject)`. `conformance/kit.test.ts` proves every check passes on correct fakes
 * and FAILS on a port that breaks its rule.
 */
import type { CapabilityId } from '../capabilities.js';
import type { EmailDoc, EmailReview, EmailReviewContext } from '../contract/email.js';
import { base64urlDecode, hmacSha256Hex, utf8Decode } from '../audit/inputHash.js';
import { usageLabel, costLabel, governText } from '../cost/wording.js';
import { ALL_POLICIES, decideGate, isExplicitNever } from '../gates/gates.js';
import type { HostPolicy } from '../gates/gates.js';
import type { IdentityPort, MeterPort } from '../gates/ports.js';
import { SERVICE_PREVIEW_CAPS } from '../gates/ports.js';
import type { ProductManifest } from '../products.js';
import { PLATFORM_TOOLS } from '../tools/registry.js';
import { toolsForProduct } from '../tools/projections.js';
import type { PlatformWave } from '../tools/types.js';
import { CURRENT_WAVE } from '../tools/types.js';
import { runFlow } from '../flows/run.js';
import type { FlowDefinition, FlowPorts } from '../flows/types.js';
import { s } from '../schema/index.js';
import { createFakeClock, createIdSequence, scriptedModel } from './fakePorts.js';

export interface ConformanceSubject {
  /** The host's name, for messages. */
  name: string;
  manifest: ProductManifest;
  /** The policy the host applies (default: the manifest's). */
  policy?: HostPolicy;
  /** The wave the host ships (default: this package's). */
  wave?: PlatformWave;
  /** The host's own tool catalogue (DreamStream: KNOWN_TOOL_NAMES), every name once per entry. */
  catalogue: readonly string[];
  /** The host's identity port for a request with (`true`) or without (`false`) an authenticated session. */
  identity(authenticated: boolean): IdentityPort;
  /** The host's ledger for a user, optionally with the ledger unreachable. */
  meter(options: { governed: boolean; ledgerDown: boolean }): MeterPort;
  /** The host's plan-token key (at least 32 bytes). */
  planKey: string | Uint8Array;
  /** The host's HMAC-SHA256 (its own crypto), hex. */
  hmacSha256Hex(key: string, message: string): string | Promise<string>;
  /** The host's own governed usage wording, when it has one beside core's. */
  usageText?(usd: number, governed: boolean): string;
  /** `reviewEmail` as the host calls it. */
  reviewEmail?(doc: EmailDoc, ctx: EmailReviewContext): EmailReview;
  /** The attributes of the host's email preview iframe. */
  emailPreviewAttributes?(): { [name: string]: string | undefined };
  clock?(): number;
}

export type ConformanceOutcome = { status: 'pass' } | { status: 'fail'; reason: string } | { status: 'skip'; reason: string };

export interface ConformanceCheck {
  id: number;
  title: string;
  run(subject: ConformanceSubject): Promise<ConformanceOutcome>;
}

const PASS: ConformanceOutcome = { status: 'pass' };
const failed = (reason: string): ConformanceOutcome => ({ status: 'fail', reason });

/** mulberry32: a seeded PRNG, so a failing amount is reproducible. */
export const seededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 1,000 amounts for seed `seed`: tiny, cents, dollars, huge, negative, zero, NaN and ±Infinity among them. */
export const seededAmounts = (seed = 20261102, count = 1000): number[] => {
  const rnd = seededRandom(seed);
  const out: number[] = [0, -0, -1, NaN, Infinity, -Infinity, 1e-12, 0.004999, 0.005, 0.01, 9.99, 10, 1e9, Number.MAX_VALUE];
  while (out.length < count) {
    const r = rnd();
    const scale = Math.pow(10, Math.floor(rnd() * 12) - 6);
    out.push((r < 0.1 ? -1 : 1) * r * scale * 1000);
  }
  return out.slice(0, count);
};

const decodePayload = (claim: string): { [k: string]: unknown } | null => {
  if (typeof claim !== 'string') return null;
  const dot = claim.indexOf('.');
  if (dot < 1) return null;
  const raw = base64urlDecode(claim.slice(0, dot));
  const text = raw ? utf8Decode(raw) : null;
  try {
    const v = text ? JSON.parse(text) : null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

const rejects = async (p: () => Promise<unknown>): Promise<boolean> => {
  try {
    await p();
    return false;
  } catch {
    return true;
  }
};

const policiesOf = (subject: ConformanceSubject): HostPolicy[] => [subject.policy || subject.manifest.policy, ...ALL_POLICIES];

const nowOf = (subject: ConformanceSubject): number => (subject.clock ? subject.clock() : Date.now());

/** RFC 4231 test cases 1 and 2, plus a long-key case (keys over 64 bytes are hashed first). */
export const HMAC_GOLDEN_VECTORS: readonly { key: string; message: string; hex: string }[] = [
  { key: '\u000b'.repeat(20), message: 'Hi There', hex: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7' },
  { key: 'Jefe', message: 'what do ya want for nothing?', hex: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843' },
  { key: 'k'.repeat(100), message: 'platform-plan-v1', hex: '' },
];

/** A two-call flow the kit runs with the host's ledger and key. */
const KIT_FLOW: FlowDefinition<{ summary: string }> = {
  id: 'conformance_probe',
  version: '1',
  title: 'Conformance probe',
  instructions: 'Answer with a one-line summary.',
  parameters: [{ key: 'topic', input_type: 'string', requirement: 'required', max: 200 }],
  tools: [],
  limits: { maxSteps: 2, maxModelCalls: 2, maxSeconds: 60, maxEstimateUsd: 0.05 },
  output: s.object({ summary: s.text({ max: 200 }) }),
};

const kitFlowPorts = (subject: ConformanceSubject, meter: MeterPort, clock: () => number): FlowPorts => ({
  callModel: scriptedModel([{ kind: 'final', output: { summary: 'ok' }, usd: 0.001 }]),
  meter,
  tools: { run: async () => ({ ok: false, code: 'forbidden', message: 'no tools in the probe' }) },
  clock,
  newId: createIdSequence('kit'),
  planKey: subject.planKey,
  sub: 'conformance-subject',
  app: subject.manifest.app,
  product: subject.manifest.id,
  policy: { app: 'dreamstream', confirm: 'always' },
  estimate: () => 0.01,
});

export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 1,
    title: 'a user claim cannot be minted without a session',
    async run(subject) {
      const caps: CapabilityId[] = ['email.render'];
      if (!(await rejects(() => subject.identity(false).mintUserClaim('compose', caps)))) return failed('mintUserClaim succeeded for a request with no session');
      let claim: string;
      try {
        claim = await subject.identity(true).mintUserClaim('compose', caps);
      } catch (e) {
        return failed(`mintUserClaim failed for an authenticated request: ${e instanceof Error ? e.message : String(e)}`);
      }
      const p = decodePayload(claim);
      if (!p || p.kind !== 'user' || p.purpose !== 'compose' || typeof p.sub !== 'string' || !p.sub) return failed('the user claim does not carry kind user, the purpose and a subject');
      const exp = typeof p.exp === 'number' ? p.exp : NaN;
      if (!(exp <= Math.floor(nowOf(subject) / 1000) + 300 + 5)) return failed('the user claim lives longer than 300 s');
      return PASS;
    },
  },
  {
    id: 2,
    title: 'service claims carry only preview capabilities',
    async run(subject) {
      const identity = subject.identity(true);
      if (!identity.mintServiceClaim) return PASS; // a host that never previews in the background mints none
      const mint = identity.mintServiceClaim.bind(identity);
      if (!(await rejects(() => mint('preview', ['pdf.fill'] as unknown as ('doc.extract')[])))) return failed('a service claim was minted with pdf.fill');
      if (!(await rejects(() => mint('render' as 'preview', ['doc.extract'])))) return failed('a service claim was minted for a purpose other than preview');
      const claim = await mint('preview', ['doc.extract']);
      const p = decodePayload(claim);
      if (!p || p.kind !== 'service' || p.purpose !== 'preview') return failed('the service claim is not kind service, purpose preview');
      if ('sub' in p) return failed('a service claim carries a user subject');
      const caps = Array.isArray(p.caps) ? (p.caps as unknown[]) : [];
      if (!caps.length || caps.some((c) => (SERVICE_PREVIEW_CAPS as readonly unknown[]).indexOf(c) === -1)) return failed('the service claim carries a non-preview capability');
      return PASS;
    },
  },
  {
    id: 3,
    title: 'governed usage wording never shows $',
    async run(subject) {
      for (const usd of seededAmounts()) {
        const texts = [
          usageLabel({ governed: true, fractionLeft: 1 - usd / 10, units: { count: Math.abs(usd), label: 'standard comic pages' } }),
          costLabel(usd, { governed: true, pctPerUsd: 10 }),
          costLabel(usd, { governed: true }),
          governText(`That costs $${usd} (about $${Math.abs(usd).toFixed(2)}).`, { governed: true, pctPerUsd: 10 }),
        ];
        if (subject.usageText) texts.push(subject.usageText(usd, true));
        for (const t of texts) if (t.indexOf('$') !== -1) return failed(`governed wording for ${usd} shows a dollar sign: ${t}`);
      }
      return PASS;
    },
  },
  {
    id: 4,
    title: 'an external write resolves to confirm under every policy',
    async run(subject) {
      const tools = PLATFORM_TOOLS.filter((t) => t.mode === 'external-write');
      for (const policy of policiesOf(subject)) {
        for (const estimateUsd of [undefined, 0, 0.01, 5]) {
          const d = decideGate({ tool: { mode: 'external-write', gate: 'external-write' }, policy, estimateUsd, target: 'external' });
          if (d !== 'confirm') return failed(`an external write under ${JSON.stringify(policy)} decided ${d}`);
          for (const t of tools) {
            const dt = decideGate({ tool: t, policy, estimateUsd, target: t.target });
            if (dt !== 'confirm') return failed(`${t.name} under ${JSON.stringify(policy)} decided ${dt}`);
          }
        }
      }
      return PASS;
    },
  },
  {
    id: 5,
    title: 'MeterPort.reserve fails closed with the ledger down',
    async run(subject) {
      const up = subject.meter({ governed: true, ledgerDown: false });
      const ok = await up.reserve({ operation: 'platform_probe', estimateFloorUsd: 0.002, metadata: { platform: { app: subject.manifest.app, product: subject.manifest.id } } });
      if (!ok.ok) return failed('reserve refused with the ledger up (the check would pass vacuously)');
      await up.release(ok.reservationId).catch(() => undefined);
      const down = subject.meter({ governed: true, ledgerDown: true });
      let r;
      try {
        r = await down.reserve({ operation: 'platform_probe', estimateFloorUsd: 0.002, metadata: { platform: { app: subject.manifest.app, product: subject.manifest.id } } });
      } catch {
        return failed('reserve threw with the ledger down (it must answer {ok:false})');
      }
      if (r.ok !== false) return failed('reserve allowed a governed spend with the ledger down');
      return PASS;
    },
  },
  {
    id: 6,
    title: 'tool names are unique and present in the host catalogue',
    async run(subject) {
      const names = toolsForProduct(subject.manifest, subject.wave || CURRENT_WAVE).map((t) => t.name);
      for (const n of names) {
        const count = subject.catalogue.filter((c) => c === n).length;
        if (count === 0) return failed(`${n} is missing from the host catalogue`);
        if (count > 1) return failed(`${n} is in the host catalogue ${count} times`);
      }
      return PASS;
    },
  },
  {
    id: 7,
    title: "the HMAC golden vectors verify with the host's crypto",
    async run(subject) {
      for (const v of HMAC_GOLDEN_VECTORS) {
        const expected = v.hex || hmacSha256Hex(v.key, v.message);
        if (hmacSha256Hex(v.key, v.message) !== expected) return failed(`core HMAC differs on ${JSON.stringify(v.message)}`);
        const host = await subject.hmacSha256Hex(v.key, v.message);
        if (host !== expected) return failed(`host HMAC differs on ${JSON.stringify(v.message)}`);
      }
      return PASS;
    },
  },
  {
    id: 8,
    title: 'reviewEmail never pre-fills a model-only address',
    async run(subject) {
      if (!subject.reviewEmail) return { status: 'skip', reason: 'reviewEmail is not wired into this subject' };
      const doc: EmailDoc = {
        v: 1,
        mode: 'compose',
        subject: 'Hello',
        to: [{ address: 'alice@example.com' }, { address: 'stranger@example.net' }],
        blocks: [{ type: 'paragraph', id: 'p1', runs: [{ text: 'Hi' }] }],
      };
      const ctx: EmailReviewContext = { mode: 'compose', participants: [{ address: 'alice@example.com' }], userTyped: [] };
      const review = subject.reviewEmail(doc, ctx);
      const prefilled = review.prefill.to.concat(review.prefill.cc, review.prefill.bcc).map((r) => r.address.toLowerCase());
      if (prefilled.indexOf('stranger@example.net') !== -1) return failed('a model-only address was pre-filled');
      if (!review.flagged.some((f) => f.address.toLowerCase() === 'stranger@example.net' && f.reason === 'model-only')) return failed('a model-only address was not flagged');
      if (prefilled.indexOf('alice@example.com') === -1) return failed('a participant was not pre-filled (the check would pass vacuously)');
      const reply = subject.reviewEmail({ ...doc, mode: 'reply' }, { ...ctx, mode: 'reply' });
      if (reply.prefill.to.length + reply.prefill.cc.length + reply.prefill.bcc.length !== 0) return failed('a reply pre-filled recipients (the provider decides them)');
      return PASS;
    },
  },
  {
    id: 9,
    title: 'email previews use sandbox=""',
    async run(subject) {
      if (!subject.emailPreviewAttributes) return { status: 'skip', reason: 'the email preview is not wired into this subject' };
      const attrs = subject.emailPreviewAttributes();
      if (attrs.sandbox !== '') return failed(`the email preview iframe has sandbox=${JSON.stringify(attrs.sandbox)}`);
      if (attrs.src !== undefined) return failed('the email preview loads a src instead of srcdoc');
      return PASS;
    },
  },
  {
    id: 10,
    title: 'a flow with maxModelCalls > 1 resolves to propose unless the user chose never',
    async run(subject) {
      for (const policy of policiesOf(subject)) {
        for (const estimateUsd of [undefined, 0, 0.01, 0.49, 5]) {
          const d = decideGate({ flow: { maxModelCalls: 2 }, policy, estimateUsd, target: 'own-draft' });
          if (isExplicitNever(policy) ? d === 'propose' : d !== 'propose') return failed(`a 2-call flow under ${JSON.stringify(policy)} decided ${d}`);
        }
      }
      const clock = createFakeClock(nowOf(subject));
      const r = await runFlow(KIT_FLOW, { topic: 'x' }, kitFlowPorts(subject, subject.meter({ governed: true, ledgerDown: false }), clock));
      if (r.status !== 'awaiting_approval' || !r.planToken) return failed(`a 2-call flow ran without approval (status ${r.status})`);
      return PASS;
    },
  },
  {
    id: 11,
    title: 'a resume with an expired planToken or an already-used reservation is refused',
    async run(subject) {
      const clock = createFakeClock(nowOf(subject));
      const meter = subject.meter({ governed: true, ledgerDown: false });
      const ports = kitFlowPorts(subject, meter, clock);
      const first = await runFlow(KIT_FLOW, { topic: 'x' }, ports);
      if (!first.plan || !first.planToken) return failed('the probe flow did not stop for approval');
      const approved = { plan: first.plan, planToken: first.planToken };
      const once = await runFlow(KIT_FLOW, { topic: 'x' }, { ...ports, callModel: scriptedModel([{ kind: 'final', output: { summary: 'ok' } }]) }, approved);
      if (once.status !== 'done') return failed(`the first resume did not run (${once.status}: ${once.error ? once.error.reason : ''})`);
      const twice = await runFlow(KIT_FLOW, { topic: 'x' }, { ...ports, callModel: scriptedModel([{ kind: 'final', output: { summary: 'ok' } }]) }, approved);
      if (twice.status !== 'failed' || !twice.error || twice.error.status !== 409) return failed('a second resume of the same plan was not refused with 409');
      const second = await runFlow(KIT_FLOW, { topic: 'x' }, ports);
      if (!second.plan || !second.planToken) return failed('the probe flow did not stop for approval');
      clock.advance(16 * 60 * 1000);
      const late = await runFlow(KIT_FLOW, { topic: 'x' }, { ...ports, callModel: scriptedModel([{ kind: 'final', output: { summary: 'ok' } }]) }, { plan: second.plan, planToken: second.planToken });
      if (late.status !== 'failed' || !late.error || late.error.status !== 403) return failed('an expired plan token was not refused with 403');
      return PASS;
    },
  },
];

export interface ConformanceReportRow {
  id: number;
  title: string;
  status: ConformanceOutcome['status'];
  reason?: string;
}

/** Run every check; a check that throws is a failure. */
export const runConformance = async (subject: ConformanceSubject): Promise<ConformanceReportRow[]> => {
  const out: ConformanceReportRow[] = [];
  for (const c of CONFORMANCE_CHECKS) {
    let o: ConformanceOutcome;
    try {
      o = await c.run(subject);
    } catch (e) {
      o = failed(`threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    out.push(o.status === 'pass' ? { id: c.id, title: c.title, status: 'pass' } : { id: c.id, title: c.title, status: o.status, reason: o.reason });
  }
  return out;
};
