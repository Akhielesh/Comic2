// @vitest-environment node
//
// The capability registry, the product manifests and consent (plan §5.3, §5.4, §5.6; W1.4):
// - the registry holds the plan's rows, every one with engines, limits and a gate, and nothing named like it sends;
// - every product's tools exist and need only capabilities the product lists; a bad manifest throws;
// - an external write runs only with a fresh consent from the same user for the very payload that was drafted.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_IDS, capabilityRegistryProblems, capabilitiesUpToWave, getCapability, isCapabilityId } from './capabilities.js';
import {
  ATLAS_PRODUCT,
  CHAT_PRODUCT,
  COMIC_PRODUCT,
  DREAMSTREAM_PLATFORM_STUDIOS,
  PRODUCTS,
  STREAM_PRODUCT,
  ProductDefinitionError,
  defineProduct,
  getProduct,
  productForStudio,
  productRegistryProblems,
} from './products.js';
import { getPlatformTool } from './tools/registry.js';
import { CONSENT_TTL_MS, ConsentError, createDraftAction, executeExternalWrite, recordConsent } from './gates/consent.js';
import { inputHash } from './audit/inputHash.js';

describe('the capability registry (plan §5.3)', () => {
  it('holds every planned capability exactly once, sound', () => {
    expect(CAPABILITIES.map((c) => c.id)).toEqual([...CAPABILITY_IDS]);
    expect(capabilityRegistryProblems()).toEqual([]);
    expect(isCapabilityId('email.render')).toBe(true);
    expect(isCapabilityId('email.send')).toBe(false);
  });

  it('wave 1 is the no-infrastructure slice: core and browser only', () => {
    expect(capabilitiesUpToWave(1).map((c) => [c.id, c.where])).toEqual([
      ['email.render', 'core'],
      ['richdoc.export', 'browser'],
      ['deck.export', 'browser'],
    ]);
  });

  it('pins the plan’s engines, trust and gates', () => {
    expect(getCapability('richdoc.export')!.engines).toEqual([{ id: 'docx', version: '9.15.0' }]);
    expect(getCapability('deck.export')!.engines).toEqual([{ id: 'pptxgenjs', version: '4.0.1+ds1' }]);
    for (const id of ['pdf.inspect', 'pdf.fill', 'pdf.redact', 'pdf.organize', 'doc.thumbnail']) {
      expect(getCapability(id), id).toMatchObject({ engines: [{ id: 'pdfcraft', version: '0.15.0' }], trust: 'untrusted-ok', gate: 'quota', stageCeiling: 'admins' });
    }
    expect(getCapability('pdf.fill')!.copyOnUserContent).toBe(true);
    expect(getCapability('pdf.inspect')!.copyOnUserContent).toBe(false);
    expect(getCapability('print.book')).toMatchObject({ where: 'engine-heavy', trust: 'own', plans: ['studio', 'admin'] });
    expect(getCapability('print.book')!.engines[1]).toMatchObject({ id: 'designcraft', maturity: 'trial' });
    expect(getCapability('image.psd')!.engines.map((e) => e.id)).toEqual(['ag-psd', 'photocraft']);
  });

  it('catches a broken entry', () => {
    const base = CAPABILITIES[0];
    expect(capabilityRegistryProblems([base, base]).join()).toMatch(/duplicate/);
    expect(capabilityRegistryProblems([{ ...base, engines: [] }]).join()).toMatch(/no engine/);
    expect(capabilityRegistryProblems([{ ...base, limits: { maxBytes: 0, timeoutMs: 1 } }]).join()).toMatch(/limits/);
    expect(capabilityRegistryProblems([{ ...base, engines: [{ id: 'x', version: '1', maturity: 'trial' }] }]).join()).toMatch(/non-trial/);
    // A placeholder engine version needs a provisional note; a blank note is not one.
    expect(capabilityRegistryProblems([{ ...base, engines: [{ id: 'poppler', version: 'pinned' }], provisional: undefined }]).join()).toMatch(/no pinned version/);
    expect(capabilityRegistryProblems([{ ...base, engines: [{ id: 'poppler', version: 'pinned' }], provisional: 'version pending (owner W2.4)' }])).toEqual([]);
    expect(capabilityRegistryProblems([{ ...base, provisional: ' ' }]).join()).toMatch(/provisional note/);
  });

  it('marks every number the plan does not give as provisional, with its owner, and derives the rest from the spec', () => {
    // The entries carrying a number (or a placeholder version) the plan does not give; ADR 0008 confirms each.
    expect(CAPABILITIES.filter((c) => c.provisional).map((c) => c.id)).toEqual([
      'email.render',
      'richdoc.export',
      'deck.export',
      'pdf.sanitize',
      'pdf.inspect',
      'pdf.fill',
      'pdf.redact',
      'pdf.organize',
      'asset.normalize',
      'print.book',
      'print.preflight',
      'doc.convert',
      'image.psd',
      'layout.idml',
      'comic.cbz',
      'comic.epub',
      'comic.strip',
    ]);
    for (const c of CAPABILITIES) if (c.provisional) expect(c.provisional, c.id).toMatch(/owner W\d\.\d.*ADR 0008/);
    // §5.9: extract ≤ 50 MB and 300 pages; render ≤ 10 MB; convert ≤ 50 MB; every synchronous call within 25 s.
    expect(getCapability('doc.extract')!.limits).toEqual({ maxBytes: 50000000, maxPages: 300, timeoutMs: 25000 });
    expect(getCapability('richdoc.render')!.limits).toEqual({ maxBytes: 10000000, timeoutMs: 25000 });
    expect(getCapability('deck.render')!.limits).toEqual({ maxBytes: 10000000, timeoutMs: 25000 });
    expect(getCapability('doc.convert')!.limits).toEqual({ maxBytes: 50000000, timeoutMs: 25000 });
    // W1.8's deck cap.
    expect(getCapability('deck.export')!.limits.maxBytes).toBe(40000000);
    // The PDF tools follow the extract cap instead of an invented one.
    for (const id of ['pdf.sanitize', 'pdf.inspect', 'pdf.fill', 'pdf.redact', 'pdf.organize']) expect(getCapability(id)!.limits, id).toEqual({ maxBytes: 50000000, maxPages: 300, timeoutMs: 25000 });
  });

  it('gates plan-tier features as §10 packages them', () => {
    for (const id of ['comic.cbz', 'comic.epub', 'comic.strip', 'image.psd']) expect(getCapability(id)!.plans, id).toEqual(['creator', 'studio', 'admin']);
    for (const id of ['print.book', 'layout.idml']) expect(getCapability(id)!.plans, id).toEqual(['studio', 'admin']);
    for (const c of CAPABILITIES) if (c.plans) expect(c.plans, c.id).not.toContain('free');
  });
});

describe('products (plan §5.4)', () => {
  it('holds the four manifests of the plan', () => {
    expect(PRODUCTS.map((p) => [p.id, p.studio, p.app])).toEqual([
      ['comic', 'comic_studio', 'dreamstream'],
      ['chat', 'chat_studio', 'dreamstream'],
      ['stream', 'stream_studio', 'dreamstream'],
      ['atlas', null, 'atlas'],
    ]);
    expect(productRegistryProblems()).toEqual([]);
    expect(COMIC_PRODUCT.policy).toEqual({ app: 'dreamstream', confirm: 'big', bigSpendUsd: 0.5 });
    expect(CHAT_PRODUCT.policy).toEqual({ app: 'dreamstream', confirm: 'always' });
    expect(ATLAS_PRODUCT.policy).toEqual({ app: 'atlas', approval: 'before_write' });
    expect(STREAM_PRODUCT.templates).toEqual(['event_recap', 'sponsor_thanks']);
    expect([COMIC_PRODUCT, CHAT_PRODUCT, STREAM_PRODUCT].every((p) => p.governedWording)).toBe(true);
    expect(ATLAS_PRODUCT.governedWording).toBe(false);
    expect(DREAMSTREAM_PLATFORM_STUDIOS).toEqual(['comic_studio', 'chat_studio', 'stream_studio']);
    expect(productForStudio('chat_studio')).toBe(CHAT_PRODUCT);
    expect(productForStudio('baby_monitor')).toBeUndefined();
    expect(getProduct('atlas')).toBe(ATLAS_PRODUCT);
  });

  it('every tool a product lists exists and needs only capabilities the product lists', () => {
    for (const p of PRODUCTS) {
      for (const name of p.tools) {
        const tool = getPlatformTool(name);
        expect(tool, `${p.id}: ${name}`).toBeDefined();
        if (tool!.capability) expect(p.capabilities, `${p.id}: ${name}`).toContain(tool!.capability);
      }
    }
  });

  it('manifests are frozen', () => {
    expect(Object.isFrozen(COMIC_PRODUCT)).toBe(true);
    expect(Object.isFrozen(COMIC_PRODUCT.tools)).toBe(true);
    expect(() => (COMIC_PRODUCT.tools as string[]).push('email_handoff')).toThrow();
  });

  it.each([
    ['an unknown capability', { capabilities: ['email.send'] }, /unknown entry/],
    ['an unknown tool', { tools: ['email_send'] }, /unknown entry/],
    ['a duplicate tool', { tools: ['email_draft', 'email_draft'] }, /twice/],
    ['a tool without its capability', { capabilities: ['email.render'], tools: ['deck_create'] }, /needs capability deck.export/],
    ['an unknown flow', { flows: ['send_all'] }, /unknown entry/],
    ['another app’s policy', { policy: { app: 'atlas', approval: 'none' } }, /policy/],
    ['a DreamStream product without a studio', { studio: null }, /belongs to a studio/],
    ['an id named like it sends', { id: 'auto_send' }, /id/],
  ])('refuses %s', (_name, over, message) => {
    const run = () => defineProduct({ ...CHAT_PRODUCT, id: 'probe', studio: 'probe_studio', ...(over as object) } as never);
    expect(run).toThrow(ProductDefinitionError);
    expect(run).toThrow(message);
  });
});

describe('consent (plan §5.6)', () => {
  const payload = { subject: 'Launch', to: ['ana@example.com'], body: 'Hello' };
  const action = createDraftAction({ id: 'da-1', kind: 'provider-draft', summary: 'Save this draft to Gmail', target: 'gmail', payload, now: 1000 });
  const consent = recordConsent(action, { userId: 'user-1', at: 2000, surface: 'chat-card', payloadHash: action.payloadHash });

  it('a draft action carries the payload hash, never the payload', () => {
    expect(action).toEqual({ id: 'da-1', kind: 'provider-draft', summary: 'Save this draft to Gmail', payloadHash: inputHash(payload), target: 'gmail', createdAt: 1000 });
    expect(JSON.stringify(action)).not.toContain('ana@example.com');
    expect(() => createDraftAction({ id: 'da-2', kind: 'send' as never, summary: 's', target: 'gmail', payload, now: 1 })).toThrow(ConsentError);
    expect(() => createDraftAction({ id: 'da-2', kind: 'provider-draft', summary: 's', target: 'https://evil.example/', payload, now: 1 })).toThrow(ConsentError);
  });

  it('a consent must name the drafted payload and come after it', () => {
    expect(consent).toEqual({ draftActionId: 'da-1', userId: 'user-1', at: 2000, surface: 'chat-card', payloadHash: action.payloadHash });
    expect(() => recordConsent(action, { userId: 'user-1', at: 2000, surface: 'chat-card', payloadHash: inputHash({ ...payload, to: ['evil@example.com'] }) })).toThrow(ConsentError);
    expect(() => recordConsent(action, { userId: 'user-1', at: 500, surface: 'chat-card', payloadHash: action.payloadHash })).toThrow(ConsentError);
    expect(() => recordConsent(action, { userId: '', at: 2000, surface: 'chat-card', payloadHash: action.payloadHash })).toThrow(ConsentError);
  });

  it('executeExternalWrite writes only with a matching, fresh consent from the same user for the same payload', async () => {
    const writes: unknown[] = [];
    const write = async (p: unknown) => (writes.push(p), 'draft-id-123');
    const run = (over: Partial<Parameters<typeof executeExternalWrite>[0]>) => executeExternalWrite({ action, consent, payload, userId: 'user-1', now: 3000, ...over }, write);
    expect(await run({})).toEqual({ ok: true, result: 'draft-id-123' });
    expect(await run({ consent: null })).toMatchObject({ ok: false, code: 'forbidden', reason: 'no-consent' });
    expect(await run({ userId: 'user-2' })).toMatchObject({ ok: false, code: 'forbidden', reason: 'wrong-user' });
    expect(await run({ payload: { ...payload, to: ['evil@example.com'] } })).toMatchObject({ ok: false, code: 'conflict', reason: 'payload-changed' });
    expect(await run({ consent: { ...consent, draftActionId: 'da-other' } })).toMatchObject({ ok: false, reason: 'wrong-action' });
    expect(await run({ now: 2000 + CONSENT_TTL_MS + 1 })).toMatchObject({ ok: false, reason: 'consent-expired' });
    expect(writes).toHaveLength(1);
    expect(await executeExternalWrite({ action, consent, payload, userId: 'user-1', now: 3000 }, async () => Promise.reject(new Error('provider 500')))).toMatchObject({ ok: false, code: 'engine-failed' });
  });
});
