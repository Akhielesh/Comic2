// The safety seams end to end with fakes (safety.md §14 #1–27, #32, #34–36). Nothing here spends
// or touches the network: the platform LLM, the store and the asset store are in-memory fakes.
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type AssetRef, type ComicDoc, type RefAsset } from '../../../../shared/comic/doc.js';
import { CLIENT_PATCHABLE_OPS, applyOp, type DocOp } from '../../../../shared/comic/ops.js';
import { effectiveRating, safetyStatusOf, type SafetyVerdict } from '../../../../shared/comic/safety.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { safetyPatchScreen } from '../sanitize/safety.js';
import { StudioError } from '../types.js';
import { cleanAnswer, fakeSafetyLlm } from './fakes.js';
import {
  accountCeilingFor,
  ageFromDob,
  checkRenderSafety,
  cooldownFor,
  isServableToOwner,
  onRenderVerdict,
  prefilterText,
  requireActiveUser,
  respondBlocked,
  screenPatch,
  screenTurnInput,
  screenUploadPreview,
  takeRenderSafetyFollowups,
  verdictFromVision
} from './index.js';
import { FIXTURES, TERMS, expand, installSafetyFakes, resetSafety, type SafetyFakes } from './testkit.js';

let fakes: SafetyFakes;
const logs: string[] = [];

beforeEach(() => {
  logs.length = 0;
  for (const m of ['info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  fakes = installSafetyFakes();
});
afterEach(() => {
  resetSafety();
  vi.restoreAllMocks();
});

const USER = '11111111-1111-4111-8111-111111111111';
const ctxFor = (doc: ComicDoc = plannedDoc(), rating?: 'G' | 'PG' | 'PG-13') => testContext(newSession(doc, undefined, USER), rating ? { rating } : {});
const textCalls = () => fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_text');
const imageCalls = () => fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image');
const textAnswer = (o: Record<string, unknown>) => ({ assessed: 'G', categories: [], adaptable: true, suggestion: '', ip: [], spans: [], ...o });
const imageAnswer = (o: Record<string, unknown>) => ({ ...cleanAnswer({ role: 'vision', messages: [], jsonSchema: { name: 'comic_safety_image', schema: {} } }), ...o });
const webp = async (color: { r: number; g: number; b: number }) =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).webp().toBuffer();

describe('screenTurnInput', () => {
  it('#35 the 12 must-allow fixtures cost $0: the classifier is called 0 times', async () => {
    for (const f of FIXTURES.mustAllow) {
      const doc = plannedDoc();
      if (f.audience) doc.brief.audience = f.audience;
      const r = await screenTurnInput(ctxFor(doc), { text: f.text, attachments: [], rating: f.rating });
      expect(r, `#${f.id}`).toMatchObject({ decision: 'allow', strike: 0, blockedAttachmentPaths: [] });
    }
    expect(fakes.llm.calls).toHaveLength(0);
    expect(fakes.store.costs).toHaveLength(0);
  });

  it('#13/#16 a hard block is free, strikes, and the reply has no thematic options for sexual content', async () => {
    const ctx = ctxFor();
    const r = await screenTurnInput(ctx, { text: expand(FIXTURES.mustBlock[0].text), attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'block', strike: 1, categories: ['sexual'] });
    expect(fakes.llm.calls).toHaveLength(0);
    expect(fakes.store.events.at(-1)).toMatchObject({ surface: 'message', layer: 'prefilter', decision: 'block', severity: 1 });
    await respondBlocked(ctx, { userMsgId: 'm1' }, r);
    const reply = ctx.session.doc.conversation.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.text).toMatch(/stay PG-13 with no sexual content/);
    expect(reply.text).toContain('“Spice Run”');
    const options = reply.cards?.find((c) => c.type === 'options');
    expect(options && options.type === 'options' ? options.choices.map((c) => c.label) : []).toEqual(['Continue the story', 'Plan the next page']);
    expect(reply.text).not.toContain(TERMS['<SEXUAL_TERM>']);
  });

  it('#14 minors near a sexual term: severe block, account restricted, a moderator case, no options', async () => {
    const ctx = ctxFor();
    const r = await screenTurnInput(ctx, { text: expand(FIXTURES.mustBlock[1].text), attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'block', strike: 3 });
    expect(r.categories).toContain('minor_sexual');
    expect(fakes.store.statuses.get(USER)).toBe('restricted');
    expect(fakes.store.cases.some((c) => c.kind === 'auto' && /severe/.test(c.reason))).toBe(true);
    await respondBlocked(ctx, { userMsgId: 'm1' }, r);
    const reply = ctx.session.doc.conversation.at(-1)!;
    expect(reply.text).toBe("I can't help with that.");
    expect(reply.cards).toBeUndefined();
  });

  it('#15 dangerous instructions: blocked with an off-panel alternative', async () => {
    const ctx = ctxFor();
    const r = await screenTurnInput(ctx, { text: FIXTURES.mustBlock[2].text, attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'block', categories: ['dangerous'], strike: 1 });
    await respondBlocked(ctx, { userMsgId: 'm1' }, r);
    const reply = ctx.session.doc.conversation.at(-1)!;
    expect(reply.text).toMatch(/off-panel/);
    expect(JSON.stringify(reply.cards)).toContain('Keep it in the story, off-panel');
  });

  it('self-harm in the first person: a caring reply, no strike', async () => {
    const ctx = ctxFor();
    const r = await screenTurnInput(ctx, { text: 'how to kill myself', attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'block', strike: 0 });
    expect(r.note).toMatch(/you matter/);
    expect(fakes.store.statuses.get(USER)).toBeUndefined();
  });

  it('#19 gore → classifier X but adaptable → adapt with a SAFETY NOTE (no strike)', async () => {
    fakes.llm.script.safety = [textAnswer(FIXTURES.adapt[0].classifier)];
    const r = await screenTurnInput(ctxFor(), { text: FIXTURES.adapt[0].text, attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'adapt', strike: 0, categories: ['graphic_gore'] });
    expect(r.note).toMatch(/^SAFETY NOTE: this request goes beyond PG-13/);
    expect(r.note).toContain('the bite happens off-panel');
    expect(textCalls()).toHaveLength(1);
    expect(fakes.store.costs).toHaveLength(1);
    expect(fakes.store.costs[0]).toMatchObject({ operation: 'comic.safety.text' });
  });

  it('#20 kids audience: "shoots" → adapt to a freeze ray (PG)', async () => {
    const doc = plannedDoc();
    doc.brief.audience = FIXTURES.adapt[1].audience!;
    const rating = effectiveRating(doc).rating;
    expect(rating).toBe('PG');
    fakes.llm.script.safety = [textAnswer(FIXTURES.adapt[1].classifier)];
    const r = await screenTurnInput(ctxFor(doc), { text: FIXTURES.adapt[1].text, attachments: [], rating });
    expect(r.decision).toBe('adapt');
    expect(r.note).toContain('freeze ray');
  });

  it("a parent's negated instruction is allowed by the classifier, never struck", async () => {
    fakes.llm.script.safety = [textAnswer({ assessed: 'G' })];
    const r = await screenTurnInput(ctxFor(), { text: expand("no <SEXUAL_TERM> stuff please, it's for kids"), attachments: [], rating: 'G' });
    expect(r).toMatchObject({ decision: 'allow', strike: 0 });
    expect(textCalls()).toHaveLength(1);
    expect(fakes.store.statuses.get(USER)).toBeUndefined();
  });

  it('classifier unavailable: ambiguous wording fails open to adapt (never a strike)', async () => {
    resetSafety();
    fakes = installSafetyFakes({ llm: null });
    const r = await screenTurnInput(ctxFor(), { text: FIXTURES.adapt[0].text, attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'adapt', strike: 0 });
    expect(fakes.store.events.at(-1)).toMatchObject({ layer: 'classifier_unavailable' });
  });

  it('swearing at the tool is fine in chat: a language note, no classifier, no strike', async () => {
    const r = await screenTurnInput(ctxFor(), { text: expand(FIXTURES.language[0].text), attachments: [], rating: 'PG-13' });
    expect(r).toMatchObject({ decision: 'allow', strike: 0 });
    expect(r.note).toMatch(/^LANGUAGE NOTE/);
    expect(fakes.llm.calls).toHaveLength(0);
  });

  it('a pasted script goes to the classifier once and leaves neutral adapt notes (no excerpts)', async () => {
    fakes.llm.script.safety = [textAnswer({ assessed: 'PG-13', categories: ['graphic_gore'], spans: [{ where: 'chapter 3', category: 'graphic_gore' }] })];
    const ctx = ctxFor();
    const script = 'Chapter 1. The village.\n'.repeat(20);
    const r = await screenTurnInput(ctx, { text: 'Here is my script', attachments: [], sourceText: script, rating: 'PG-13' });
    expect(r.decision).toBe('allow');
    expect(textCalls()).toHaveLength(1);
    expect(ctx.session.doc.safety?.source).toMatchObject({ adaptNotes: ['chapter 3: graphic injury'], categories: ['graphic_gore'] });
  });

  it('caps classifier spend at 60 per hour per user, then the pre-filter decides alone', async () => {
    const ctx = ctxFor();
    for (let i = 0; i < 61; i += 1) await screenTurnInput(ctx, { text: FIXTURES.adapt[0].text, attachments: [], rating: 'PG-13' });
    expect(textCalls()).toHaveLength(60);
  });

  it('attachments: a clean image gets its verdict; a blocked one is quarantined and dropped', async () => {
    const ctx = ctxFor();
    const ok: RefAsset = { path: 'u/user-1/p/proj-1/ref/ok.webp', source: 'upload', at: 1 };
    const bad: RefAsset = { path: 'u/user-1/p/proj-1/ref/bad.webp', source: 'upload', at: 2 };
    ctx.assetsFake.files.set(ok.path, `data:image/webp;base64,${(await webp({ r: 10, g: 200, b: 10 })).toString('base64')}`);
    ctx.assetsFake.files.set(bad.path, `data:image/webp;base64,${(await webp({ r: 200, g: 10, b: 10 })).toString('base64')}`);
    ctx.session.commit([{ op: 'message', msg: { id: 'mu', role: 'user', text: 'x', at: 1, attachments: [ok, bad] } }]);
    fakes.llm.script.vision = [imageAnswer({ rating: 'G' }), imageAnswer({ rating: 'X', categories: ['graphic_gore'], notes: ['open wound in the centre'] })];
    const r = await screenTurnInput(ctx, { text: 'use these for the hero', attachments: [ok, bad], rating: 'PG-13' });
    expect(r.decision).toBe('allow');
    expect(r.blockedAttachmentPaths).toEqual([bad.path]);
    expect(ctx.assetsFake.quarantined.map((q) => q.path)).toEqual([bad.path]);
    const att = ctx.session.doc.conversation.find((m) => m.id === 'mu')!.attachments!;
    expect(att[0].safety).toMatchObject({ assessed: 'G', by: 'upload' });
    expect(att[1].safety).toMatchObject({ assessed: 'X', quarantined: true });
    expect(fakes.store.quarantine.get(bad.path)).toMatch(/^q\//);
  });
});

describe('screenTurnInput: review fixes', () => {
  it('innocent wording near "kids" never strikes or restricts the account', async () => {
    const ctx = ctxFor();
    const r = await screenTurnInput(ctx, { text: 'the kids could barely make out the castle in the fog', attachments: [], rating: 'PG' });
    expect(r).toMatchObject({ decision: 'allow', strike: 0 });
    expect(fakes.store.statuses.get(USER)).toBeUndefined();
    expect(fakes.store.events.filter((e) => e.severity > 0)).toEqual([]);
    expect(fakes.llm.calls).toHaveLength(0);
  });

  it('every image a message may carry is screened (12), not only the first 6', async () => {
    const ctx = ctxFor();
    const data = `data:image/webp;base64,${(await webp({ r: 30, g: 60, b: 90 })).toString('base64')}`;
    const atts: RefAsset[] = Array.from({ length: 12 }, (_, i) => ({ path: `u/user-1/p/proj-1/ref/a${i}.webp`, source: 'upload' as const, at: i + 1 }));
    for (const a of atts) ctx.assetsFake.files.set(a.path, data);
    fakes.llm.script.vision = [...Array.from({ length: 11 }, () => imageAnswer({ rating: 'G' })), imageAnswer({ rating: 'X', categories: ['graphic_gore'] })];
    const r = await screenTurnInput(ctx, { text: 'use these', attachments: atts, rating: 'PG-13' });
    expect(imageCalls()).toHaveLength(12);
    expect(r.blockedAttachmentPaths).toEqual([atts[11].path]);
  });

  it('first-person crisis wording that is not an instruction reaches the director with a care note', async () => {
    const ctx = ctxFor();
    const r = await screenTurnInput(ctx, { text: 'honestly I want to die, nothing works', attachments: [], rating: 'PG-13' });
    expect(r.decision).toBe('allow');
    expect(fakes.llm.calls).toHaveLength(0);
    expect(r.strike).toBe(0);
    expect(r.note).toMatch(/^CARE NOTE:/m);
    expect(r.note).toMatch(/helpline/);
  });
});

describe('client patches', () => {
  const linePatch = (text: string): DocOp => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text } });
  const sctx = (rating: 'G' | 'PG' | 'PG-13') => ({ userId: USER, caps: { ratingCeiling: 'PG-13' } as never, rating, now: 1 });

  it('#16 a slur in dialogue is refused with CONTENT_POLICY 422; the doc is unchanged', async () => {
    const ctx = ctxFor();
    const before = JSON.stringify(ctx.session.doc);
    let err: unknown;
    try {
      safetyPatchScreen(ctx.session.doc, [linePatch(expand('You <SLUR>!'))], sctx('PG-13'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ code: 'CONTENT_POLICY', status: 422 });
    expect((err as StudioError).userMessage).not.toContain(TERMS['<SLUR>']);
    expect(JSON.stringify(ctx.session.doc)).toBe(before);
    await vi.waitFor(() => expect(fakes.store.events.at(-1)).toMatchObject({ surface: 'patch', decision: 'block', severity: 1 }));
  });

  it('strong language in a line → 409 with a grawlix rewrite and the rating hint', () => {
    const doc = plannedDoc();
    let err: StudioError | undefined;
    try {
      safetyPatchScreen(doc, [linePatch(expand('Get out, you <PROFANITY>!'))], sctx('PG'));
    } catch (e) {
      err = e as StudioError;
    }
    expect(err).toMatchObject({ code: 'CONTENT_POLICY', status: 409 });
    expect(err!.userMessage).toMatch(/goes past PG \(strong language\)\. Try: “Get out, you [@#$%&*!]{3,}!”, or change the comic's rating\./);
  });

  it('action words in dialogue and ordinary edits pass; non-dialogue gore waits for publish', () => {
    const doc = plannedDoc();
    const ops: DocOp[] = [linePatch('I will stop you, villain!'), { op: 'brief', patch: { premise: 'A zombie ripping out guts in the finale' } }, { op: 'note_add', text: 'make it spooky' }];
    expect(safetyPatchScreen(doc, ops, sctx('PG-13'))).toBe(ops);
  });

  it('a client translation gloss or review issue is screened too (a client may now send them)', () => {
    const doc = plannedDoc();
    const tr = (patch: Record<string, unknown>): DocOp =>
      ({ op: 'translation', lang: 'hi', lineId: 'ln_1_2', patch: { text: 'नमस्ते', status: 'edited', sourceHash: 'abcd1234', at: 1, ...patch } }) as DocOp;
    const refused = (ops: DocOp[], rating: 'G' | 'PG' | 'PG-13' = 'PG-13') => {
      try {
        safetyPatchScreen(doc, ops, sctx(rating));
      } catch (e) {
        return e as StudioError;
      }
      return undefined;
    };
    for (const patch of [
      { gloss: expand('Hello, <SLUR>') },
      { issue: { severity: 'minor', note: expand('Means <SLUR> here') } },
      { issue: { severity: 'major', note: 'Wrong register', suggestion: expand('You <SLUR>!') } }
    ]) {
      expect(refused([tr(patch)]), JSON.stringify(Object.keys(patch))).toMatchObject({ code: 'CONTENT_POLICY', status: 422 });
    }
    // A suggestion is offered as the line's words, so the dialogue rule holds for it…
    expect(refused([tr({ issue: { severity: 'minor', note: 'Too mild', suggestion: expand('Get out, you <PROFANITY>!') } })], 'PG')).toMatchObject({ status: 409 });
    // …while a gloss or a review note only explains the words (never published): hard blocks only.
    const explained = [tr({ gloss: expand('Literally: get out, you <PROFANITY>'), issue: { severity: 'minor', note: expand('Softens “<PROFANITY>”') } })];
    expect(refused(explained, 'PG')).toBeUndefined();
    // Enum and hash fields stay unscreened.
    expect(refused([tr({ status: 'edited', sourceHash: 'ffffffff' })])).toBeUndefined();
  });

  it('screenPatch (async seam) applies the same rules', async () => {
    const ctx = ctxFor(plannedDoc(), 'PG-13');
    await expect(screenPatch(ctx, [linePatch('hello')], 'PG-13')).resolves.toBeUndefined();
    await expect(screenPatch(ctx, [{ op: 'character', id: 'c_maya', patch: { name: expand('<SEXUAL_TERM> queen') } }], 'PG-13')).rejects.toMatchObject({ status: 422 });
  });
});

describe('uploads', () => {
  it('a clean preview is allowed with a description for ref ranking', async () => {
    fakes.llm.script.vision = [imageAnswer({ rating: 'G', subject: 'animal', view: 'front', caption: 'a small brown dog facing the camera' })];
    const out = await screenUploadPreview(ctxFor(), await webp({ r: 120, g: 80, b: 40 }), 'upload');
    expect(out).toMatchObject({ decision: 'allow', verdict: { assessed: 'G', by: 'upload' }, describe: { subject: 'animal', view: 'front', caption: 'a small brown dog facing the camera' } });
  });

  it('a blocked preview is denylisted: the next near-duplicate is blocked for free', async () => {
    fakes.llm.script.vision = [imageAnswer({ rating: 'X', categories: ['nudity'] })];
    const buf = await webp({ r: 1, g: 2, b: 3 });
    const ctx = ctxFor();
    expect((await screenUploadPreview(ctx, buf, 'upload')).decision).toBe('block');
    expect(fakes.store.hashes).toHaveLength(1);
    const calls = fakes.llm.calls.length;
    const again = await screenUploadPreview(ctx, buf, 'attachment');
    expect(again).toMatchObject({ decision: 'block', verdict: { assessed: 'X' } });
    expect(fakes.llm.calls.length).toBe(calls);
    expect(fakes.store.events.at(-1)).toMatchObject({ layer: 'hash', severity: 3 });
  });

  it('no platform key or not an image → unavailable (the reference gate re-checks later)', async () => {
    expect((await screenUploadPreview(ctxFor(), Buffer.from('not an image'), 'upload')).decision).toBe('unavailable');
    resetSafety();
    fakes = installSafetyFakes({ llm: null });
    expect((await screenUploadPreview(ctxFor(), await webp({ r: 9, g: 9, b: 9 }), 'upload')).decision).toBe('unavailable');
  });
});

describe('render verdicts', () => {
  const asset = (path: string, safety?: SafetyVerdict): AssetRef => ({ path, source: 'generated', at: 1, ...(safety ? { safety } : {}) });

  it('vision QC: a missing or malformed safety block is unchecked, never a pass', () => {
    expect(verdictFromVision(undefined)).toBeUndefined();
    expect(verdictFromVision({ rating: 'maybe' })).toBeUndefined();
    expect(verdictFromVision({ rating: 'PG', categories: ['violence', 'nope'], notes: ['a', 'b', 'c'] }, 'flash')).toMatchObject({ assessed: 'PG', categories: ['violence'], notes: ['a', 'b'], by: 'qc', model: 'flash' });
    // Anything sexual has no PG-13 version: the rating can never understate it.
    expect(verdictFromVision({ rating: 'PG-13', categories: ['nudity'], notes: [] })?.assessed).toBe('X');
  });

  it('#24 blocked: quarantined, the previous passing version is back, chips to redraw safer or check again', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: asset('u/user-1/p/proj-1/img/new.webp'), history: [{ ...asset('u/user-1/p/proj-1/img/good.webp', { assessed: 'G', at: 1 }) }] };
    const ctx = ctxFor(doc);
    await onRenderVerdict(ctx, { kind: 'page', id: 'pg_1' }, doc.pages[0].render.asset!, { assessed: 'X', categories: ['graphic_gore'], by: 'qc', at: 2 });
    expect(ctx.assetsFake.quarantined[0].path).toBe('u/user-1/p/proj-1/img/new.webp');
    const page = ctx.session.doc.pages[0];
    expect(page.render.asset?.path).toBe('u/user-1/p/proj-1/img/good.webp');
    const blocked = page.render.history.find((v) => v.path.endsWith('new.webp'))!;
    expect(blocked.safety).toMatchObject({ assessed: 'X', quarantined: true });
    expect(isServableToOwner(blocked)).toBe(false);
    const f = takeRenderSafetyFollowups(ctx.session);
    expect(f.notices[0]).toMatchObject({ type: 'notice', tone: 'warn' });
    expect(f.steps.map((s) => s.label)).toEqual(['Redraw it safer', 'This looks fine — check again']);
    expect(f.steps[0].action).toEqual({ type: 'render_pages', pageIds: ['pg_1'], force: true, safe: true });
    expect(takeRenderSafetyFollowups(ctx.session).notices).toEqual([]);
  });

  it('over the rating: kept for the owner with a warning and the change-rating chip when allowed', async () => {
    const doc = plannedDoc();
    doc.settings.rating = 'PG';
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: asset('u/user-1/p/proj-1/img/cover.webp') };
    const ctx = ctxFor(doc);
    await onRenderVerdict(ctx, { kind: 'cover' }, doc.cover.render.asset!, { assessed: 'PG-13', categories: ['violence'], by: 'check', at: 2 });
    expect(ctx.session.doc.cover.render.asset?.safety).toMatchObject({ assessed: 'PG-13' });
    expect(ctx.assetsFake.quarantined).toEqual([]);
    const f = takeRenderSafetyFollowups(ctx.session);
    expect(f.notices[0]).toMatchObject({ text: 'Cover came out PG-13 — this comic is PG. Redraw it safer, or set the rating to PG-13.' });
    expect(f.steps.map((s) => s.label)).toContain('Set the rating to PG-13');
  });

  it('the standalone check runs on the platform key and records the cost (billable 0)', async () => {
    fakes.llm.script.vision = [imageAnswer({ rating: 'PG' })];
    const ctx = ctxFor();
    ctx.assetsFake.files.set('u/user-1/p/proj-1/img/s.webp', `data:image/webp;base64,${(await webp({ r: 5, g: 5, b: 5 })).toString('base64')}`);
    const v = await checkRenderSafety(ctx, { kind: 'sheet', id: 'c_maya' }, asset('u/user-1/p/proj-1/img/s.webp'));
    expect(v).toMatchObject({ assessed: 'PG', by: 'check' });
    expect(fakes.store.costs[0]).toMatchObject({ operation: 'comic.safety.render', costUsd: 0.0002 });
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('no platform key: the render stays unchecked (the job runner fails open for the owner only)', async () => {
    resetSafety();
    fakes = installSafetyFakes({ llm: null });
    expect(await checkRenderSafety(ctxFor(), { kind: 'cover' }, asset('x.webp'))).toBeUndefined();
  });
});

describe('accounts: strikes, cooldowns, moderation status, age ceiling', () => {
  it('#32 three minor blocks → a 15-minute cooldown that expires; 6 points in a week → 24 h', async () => {
    const ctx = ctxFor();
    for (let i = 0; i < 3; i += 1) await screenTurnInput(ctx, { text: expand(FIXTURES.mustBlock[0].text), attachments: [], rating: 'PG-13' });
    const cd = await cooldownFor(USER);
    expect(cd?.until).toBe(fakes.clock.now + 15 * 60_000);
    fakes.clock.now += 16 * 60_000;
    expect(await cooldownFor(USER)).toBeNull();
    for (let i = 0; i < 3; i += 1) await screenTurnInput(ctx, { text: expand(FIXTURES.mustBlock[0].text), attachments: [], rating: 'PG-13' });
    expect((await cooldownFor(USER))?.until).toBe(fakes.clock.now + 24 * 3_600_000);
    expect(fakes.store.cases.some((c) => c.kind === 'auto' && /6 points/.test(c.reason))).toBe(true);
  });

  it('requireActiveUser: suspended → 403; restricted may read and chat but not upload or publish', async () => {
    const run = async (user: string | undefined, method: string, url: string) => {
      const res = { statusCode: 200, body: undefined as unknown, locals: {} as Record<string, unknown>, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
      const next = vi.fn();
      requireActiveUser()({ user: user ? { id: user } : undefined, method, originalUrl: url } as never, res as never, next);
      await vi.waitFor(() => expect(next.mock.calls.length + (res.body ? 1 : 0)).toBeGreaterThan(0));
      return { res, next };
    };
    expect((await run(undefined, 'GET', '/api/comic/projects/p')).next).toHaveBeenCalledWith();
    fakes.store.statuses.set('u-s', 'suspended');
    expect((await run('u-s', 'GET', '/api/comic/projects/p')).res.statusCode).toBe(403);
    fakes.store.statuses.set('u-r', 'restricted');
    const read = await run('u-r', 'POST', '/api/comic/projects/p/stream');
    expect(read.next).toHaveBeenCalled();
    expect(read.res.locals.moderationStatus).toBe('restricted');
    expect((await run('u-r', 'POST', '/api/comic/projects/p/refs?to=inbox')).res.statusCode).toBe(403);
    expect((await run('u-r', 'POST', '/api/comic/projects/p/publication')).res.statusCode).toBe(403);
    expect((await run('u-r', 'DELETE', '/api/comic/projects/p/publication')).next).toHaveBeenCalled();
  });

  it('account-age ceiling: under 13 → PG, unknown → PG-13, a failed lookup throws (never lifts the ceiling)', async () => {
    fakes.store.dobs.set('kid', '2016-01-01');
    fakes.store.dobs.set('teen', '2010-01-01');
    expect(await accountCeilingFor('kid')).toBe('PG');
    expect(await accountCeilingFor('teen')).toBe('PG-13');
    expect(await accountCeilingFor('nobody')).toBe('PG-13');
    fakes.store.dobFails = true;
    await expect(accountCeilingFor('other')).rejects.toThrow();
    expect(ageFromDob('2013-10-23', Date.UTC(2026, 9, 22))).toBe(12);
    expect(ageFromDob('2013-10-22', Date.UTC(2026, 9, 22))).toBe(13);
  });
});

describe('logging (#34): no input text in logs or rows', () => {
  it('blocked, adapted and allowed text never reaches a log line or an event row', async () => {
    fakes.llm.script.safety = [textAnswer(FIXTURES.adapt[0].classifier)];
    const ctx = ctxFor();
    const inputs = [expand(FIXTURES.mustBlock[0].text), FIXTURES.adapt[0].text, FIXTURES.mustAllow[0].text];
    for (const text of inputs) await screenTurnInput(ctx, { text, attachments: [], rating: 'PG-13' });
    const serialized = JSON.stringify([logs, fakes.store.events, fakes.store.cases, fakes.store.costs]);
    for (const text of inputs) {
      expect(serialized).not.toContain(text);
      for (const word of text.split(/\s+/).filter((w) => w.length > 5)) expect(serialized).not.toContain(word);
    }
    expect(serialized).not.toContain(TERMS['<SEXUAL_TERM>']);
  });
});

describe('shared rules (#21–23, #36)', () => {
  it('#21 effective rating: kids 2–6 → G; storybook → G/PG; a PG-13 wish with a kids audience → PG; an under-13 account → PG', () => {
    const doc = createEmptyDoc('d', 'T', 1);
    doc.brief.audience = 'kids 2–6';
    expect(effectiveRating(doc).rating).toBe('G');
    const story = createEmptyDoc('s', 'T', 1);
    story.format.kind = 'storybook';
    expect(['G', 'PG']).toContain(effectiveRating(story).rating);
    const kids = createEmptyDoc('k', 'T', 1);
    kids.brief.audience = 'kids 8-10';
    kids.settings.rating = 'PG-13';
    expect(effectiveRating(kids)).toEqual({ rating: 'PG', reason: 'kids_audience' });
    const adult = createEmptyDoc('a', 'T', 1);
    expect(effectiveRating(adult, 'PG')).toEqual({ rating: 'PG', reason: 'account_age' });
  });

  it('#22 safetyStatusOf truth table', () => {
    expect(safetyStatusOf(undefined, 'PG')).toBe('unchecked');
    expect(safetyStatusOf({ pending: true, at: 1 }, 'PG')).toBe('pending');
    expect(safetyStatusOf({ assessed: 'G', at: 1 }, 'PG')).toBe('pass');
    expect(safetyStatusOf({ assessed: 'PG-13', at: 1 }, 'PG')).toBe('over_rating');
    expect(safetyStatusOf({ assessed: 'X', at: 1 }, 'PG-13')).toBe('blocked');
    expect(safetyStatusOf({ assessed: 'G', quarantined: true, at: 1 }, 'PG-13')).toBe('blocked');
  });

  it('#23 asset verdicts update the current asset, history and refs; idempotent; a blocked version cannot be restored', () => {
    const doc = plannedDoc();
    const a: AssetRef = { path: 'p/a.webp', source: 'generated', at: 1 };
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p/b.webp', source: 'generated', at: 2 }, history: [a] };
    doc.cast[0].refs = [{ ...a, source: 'upload' }];
    const op: DocOp = { op: 'asset_meta', path: 'p/a.webp', patch: { safety: { assessed: 'X', at: 3 } } };
    const once = applyOp(doc, op);
    const twice = applyOp(once, op);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(once.pages[0].render.history[0].safety?.assessed).toBe('X');
    expect(once.cast[0].refs[0].safety?.assessed).toBe('X');
    const restored = applyOp(once, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'p/a.webp', at: 4 });
    expect(restored.pages[0].render.asset?.path).toBe('p/b.webp');
  });

  it('#36 safety ops are server-only; settings (the rating wish) stays patchable', () => {
    expect(CLIENT_PATCHABLE_OPS.has('asset_meta' as never)).toBe(false);
    expect(CLIENT_PATCHABLE_OPS.has('safety' as never)).toBe(false);
    expect(CLIENT_PATCHABLE_OPS.has('settings')).toBe(true);
  });

  it('prefilterText keeps the seam shape', () => {
    expect(prefilterText('anything', 'PG-13')).toEqual({ decision: 'clear', categories: [], ip: [] });
    expect(prefilterText('Shin-chan dances', 'PG-13').ip).toEqual(['Shin-chan']);
  });

  it('fakes never touch billing', () => {
    expect(fakeSafetyLlm().calls).toEqual([]);
  });
});
