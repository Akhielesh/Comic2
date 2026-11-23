import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import { delegatesComic, runDirectorDraft } from './directorDraft.js';
import { pendingUsdOf, runAction } from './jobs.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { writePagePlan } from './writer.js';

vi.mock('./writer.js', async (load) => ({ ...(await load<typeof import('./writer.js')>()), writePagePlan: vi.fn() }));

const idea = 'A fox delivers the final letter before the spring flood.';
function setup() {
  const doc = createEmptyDoc('p');
  doc.directorDraft = { status: 'planning', idea };
  doc.settings.confirm = 'never';
  const session = newSession(doc);
  return { session, ctx: testContext(session) };
}
const plan = () => ({ pages: plannedDoc().pages, newCast: [], model: 'test-writer' });
beforeEach(() => { vi.mocked(writePagePlan).mockReset().mockResolvedValue(plan()); });

describe('the explicitly requested director draft', () => {
  it.each([
    ['A twenty-four-page graphic novel about a courier.', 24],
    ['Create a comic with thirty two pages.', 32],
    ['Draw a 16-page historical mystery about a storm.', 16]
  ])('uses the requested book length in the normal writer call: %s', async (brief, pages) => {
    const {ctx} = setup();
    await runDirectorDraft(ctx, brief as string);
    expect(vi.mocked(writePagePlan).mock.calls[0][0].doc.format.pageCount).toBe(pages);
  });
  it('stores the complete source, drafts a free look and quotes every planned page and the cover even with confirmations off', async () => {
    const { ctx, session } = setup();
    const script = idea + '\n\n' + 'A long scene. '.repeat(5000);
    const result = await runDirectorDraft(ctx, script);
    expect(session.doc.pages[0].id).toBe(result.pageId);
    expect(session.doc.source.script).toBe(script);
    expect(session.doc.style.presetId).toBeTruthy();
    expect(session.doc.brief.title).not.toBe('Untitled comic');
    expect(session.doc.planStatus).toBe('draft');
    expect(session.doc.conversation.some(msg => msg.text.includes('omitted part of the middle'))).toBe(true);
    expect(session.doc.gate).toMatchObject({ status: 'open', reason: 'plan_review', action: { type: 'render_pages', includeCover: true, pageIds: session.doc.pages.map(p => p.id) } });
    expect(session.doc.gate?.estimateUsd).toBeGreaterThan(0);
    expect(ctx.callsFake.rows).toHaveLength(0);
    await expect(runDirectorDraft(ctx, script)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(writePagePlan).toHaveBeenCalledTimes(1);
  });

  it('draws the private pages and cover on one approval and refuses a repeat approval', async () => {
    const { ctx, session } = setup();
    await runDirectorDraft(ctx, idea);
    const id = session.doc.gate!.id;
    expect(ctx.imagesFake.calls).toHaveLength(0);
    await runAction(ctx, { type: 'approve_gate', gateId: id }, { confirmed: true });
    expect(session.doc.pages.every(p => p.render.status === 'ready' && p.render.asset)).toBe(true);
    expect(session.doc.cover.render.status).toBe('ready');
    expect(session.doc.publication).toBeFalsy();
    const calls = ctx.imagesFake.calls.length;
    await expect(runAction(ctx, { type: 'approve_gate', gateId: id }, { confirmed: true })).rejects.toThrow();
    expect(ctx.imagesFake.calls).toHaveLength(calls);
  });

  it('recognizes direct delegation and leaves ordinary dialogue and questions in the conversation', () => {
    for (const text of ['U decide', 'A courier finds a second moon. You decide the rest.', 'Take it from here!', 'Make my whole comic for me.']) expect(delegatesComic(text)).toBe(true);
    for (const text of ['Could you decide which pencil to use?', 'A fox asks “you decide”.', 'Show the reader how you choose a brush.', 'You decide the villain only.']) expect(delegatesComic(text)).toBe(false);
  });

  it('runs the production page writer and records its cost without invoking an image provider', async () => {
    const realWriter = await vi.importActual<typeof import('./writer.js')>('./writer.js');
    vi.mocked(writePagePlan).mockImplementation(realWriter.writePagePlan);
    const { session } = setup();
    session.commit([{ op: 'format', patch: { pageCount: 1, panelsPerPage: 2 } }]);
    const panels = ['The fox tests the current.', 'The letter arrives on the far bank.'].map((action, i) => ({
      n: i + 1, size: 'medium', shot: i ? 'close' : 'wide', angle: '', action, castIds: [], placeId: '', mood: '', lines: []
    }));
    const text = JSON.stringify({ pages: [{ n: 1, summary: 'River Mail', turnHook: 'A new letter arrives.', layout: '', panels }], newCast: [] });
    const held: number[] = [];
    const reply = () => {
      held.push(pendingUsdOf(session));
      return { text, costUsd: 0.012 };
    };
    const llm = scriptedLlm({ writer: [reply, reply] });
    const ctx = testContext(session, { llm });
    const result = await runDirectorDraft(ctx, idea);
    expect(session.doc.pages[0].id).toBe(result.pageId);
    expect(session.doc.pages[0].panels.map(panel => panel.action)).toEqual(panels.map(panel => panel.action));
    expect(session.doc.spend.totalUsd).toBeGreaterThan(0);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(usd => usd > 0)).toBe(true);
    expect(pendingUsdOf(session)).toBe(0);
    expect(ctx.callsFake.rows).toHaveLength(0);
    expect(session.doc.gate?.status).toBe('open');
  });

  it('honors the requested book length in both the saved format and the writer input', async () => {
    const { ctx, session } = setup();
    await runDirectorDraft(ctx, 'A two-page comic about a kingfisher.');
    expect(session.doc.format.pageCount).toBe(2);
    expect(vi.mocked(writePagePlan).mock.calls[0][0].doc.format.pageCount).toBe(2);
  });

  it.each([
    ['30-page manga, portrait, right to left', 'Black-and-white manga. Dense ink and screen tones.', 30, 'manga', '2:3', 'rtl', 'bw'],
    ['20-page comic, landscape, left to right', 'Western travel poster. Use ochre and indigo.', 20, 'comic', '3:2', 'ltr', 'color']
  ])('passes the editable gallery format and art direction through to the writer and drawing quote', async (layout, art, pageCount, kind, pageAspect, readingDirection, colorMode) => {
    const { ctx, session } = setup();
    await runDirectorDraft(ctx, `A letter arrives by train.\nFormat: ${layout}.\nArt direction: ${art}`);
    const doc = vi.mocked(writePagePlan).mock.calls[0][0].doc;
    expect(doc.format).toMatchObject({ pageCount, kind, pageAspect, readingDirection, colorMode });
    expect(doc.style.spec).toBe(art);
    expect(doc.brief.title).toBe('A letter arrives by train.');
    expect(session.doc.gate?.status).toBe('open');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('preserves an existing title and source and includes the separate direction in the writer input', async () => {
    const { ctx, session } = setup();
    session.commit([{ op: 'brief', patch: { title: 'River Mail' } }, { op: 'source', patch: { script: 'Original script' } }]);
    await runDirectorDraft(ctx, idea, 'SAFETY NOTE: adapt the scene to the account rating.');
    expect(session.doc.brief.title).toBe('River Mail');
    expect(session.doc.source.script).toBe('Original script');
    expect(vi.mocked(writePagePlan).mock.calls[0][0].doc.source.script).toBe('Original script\n\n' + idea);
    expect(vi.mocked(writePagePlan).mock.calls[0][0].instructions).toContain('SAFETY NOTE: adapt the scene to the account rating.');
  });

  it('rejects insufficient positive headroom before a writer call', async () => {
    const { ctx, session } = setup();
    session.commit([{ op: 'settings', patch: { budgetUsd: 0.001 } }]);
    await expect(runDirectorDraft(ctx, idea)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(writePagePlan).not.toHaveBeenCalled();
    expect(session.doc.pages).toHaveLength(0);
  });

  it('keeps an independently edited plan and saves no late draft or quote after takeover', async () => {
    for (const takeOver of [false, true]) {
      const { ctx, session } = setup();
      vi.mocked(writePagePlan).mockImplementationOnce(async () => {
        if (takeOver) session.abort.abort();
        else session.commit([{ op: 'pages', pages: [{ ...plannedDoc().pages[0], id: 'handmade' }] }]);
        return plan();
      });
      await expect(runDirectorDraft(ctx, idea)).rejects.toMatchObject({ code: takeOver ? 'CANCELLED' : 'CONFLICT' });
      expect(session.doc.pages.map(page => page.id)).toEqual(takeOver ? [] : ['handmade']);
      expect(session.doc.gate?.status).not.toBe('open');
      expect(ctx.callsFake.rows).toHaveLength(0);
    }
  });
});
