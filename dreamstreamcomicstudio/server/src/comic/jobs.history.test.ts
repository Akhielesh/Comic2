// @vitest-environment node
// Comic History H2 wave note 1 (REQUIRED before COMIC_HISTORY=1): jobs.ts startAction runs every action inside
// withHistoryAction, and approveGate runs the approved action inside its own, so every commit an action makes (renders
// it starts in the background included) reaches the recorder with that action: a UI-started "Plan the pages" is the
// AI's, a panel fix names its panel, a fitted image is the editor's. With COMIC_HISTORY unset nothing changes: the
// session holds the no-op hooks and the store is never called. Real session, H1's fake store, fakes only: no paid call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, pageSpecHash, type AssetRef, type ComicDoc, type PanelCuts } from '../../../shared/comic/doc.js';
import type { OpsOrigin } from '../../../shared/comic/events.js';
import type { DocOp, StudioAction } from '../../../shared/comic/ops.js';
import type { PanelMomentAction } from '../../../shared/comic/history/describe.js';
import type { HistoryActor } from '../../../shared/comic/history/types.js';
import { opActor } from '../../../shared/comic/history/touched.js';
import { compileFixPanel, finishFixPanel, fixPanelMeta, fixPanelProblem } from './actions/panelFix.js';
import { NOOP_HISTORY_HOOKS } from './history/hooks.js';
import { classifyBatch } from './history/policy.js';
import { currentHistoryAction } from './history/recorder.js';
import { createFakeHistoryStore, type FakeHistoryStore } from './history/store.fake.js';
import { __setHistoryStoreForTests } from './history/store.js';
import { JOB_TIMINGS, PAGE_REFERENCE_PATH, PANEL_REFERENCE_PATH, resolveJobFor, runAction, runPinOf } from './jobs.js';
import { fakeDocStore, plannedDoc, testContext, type FakeDocStore } from './orchestrator.fakes.js';
import { cropForPanel } from './panelize/raster.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import { StudioSession, __resetSessionsForTests, getStudioSession } from './session.js';
import { analyzePageRender } from './vision.js';
import { writePagePlan } from './writer.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn() };
});
vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});
vi.mock('./actions/panelFix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions/panelFix.js')>();
  return {
    ...actual,
    fixPanelProblem: vi.fn(actual.fixPanelProblem),
    compileFixPanel: vi.fn(actual.compileFixPanel),
    finishFixPanel: vi.fn(actual.finishFixPanel),
    fixPanelMeta: vi.fn(actual.fixPanelMeta)
  };
});
vi.mock('./panelize/raster.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./panelize/raster.js')>();
  return { ...actual, cropForPanel: vi.fn(actual.cropForPanel) };
});

const USER = 'user-1';
const TIMINGS = { ...JOB_TIMINGS };
const own = (name: string) => `u/${USER}/p/proj-1/img/${name}.webp`;
const QC = { score: 0.9, issues: [] as string[], checkedAt: 1, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] };
const CUTS: PanelCuts = {
  status: 'ok',
  by: 'detect',
  at: 1,
  cuts: QC.panelBoxes.map((box, i) => ({ panelId: `pn_1_${i + 1}`, drawn: i + 1, box, conf: 0.9 }))
};
const art = (name: string, w = 800, h = 1200): AssetRef => ({ path: own(name), source: 'generated', at: 1, w, h, safety: { assessed: 'G', at: 1 } });

/** plannedDoc, plan approved, cast drawn, page 1 drawn (checked, with detector cuts). */
const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.planStatus = 'approved';
  doc.cast = doc.cast.map((c) => ({ ...c, sheet: { ...emptyRender(), status: 'ready', asset: art(`sheet-${c.id}`) } }));
  doc.pages[0] = { ...doc.pages[0], render: { ...emptyRender(), status: 'ready', asset: art('p1'), qc: { ...QC }, cuts: CUTS } };
  return doc;
};
/** Page 1 drawn square in a 4:5 book: "Fit to 4:5" has work to do. */
const squareDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.format = { ...doc.format, pageAspect: '4:5' };
  doc.pages[0] = {
    ...doc.pages[0],
    render: { ...emptyRender(), status: 'ready', asset: art('p1', 1024, 1024), specHash: pageSpecHash(doc, doc.pages[0]), qc: { ...QC } },
    balloons: [{ lineId: 'ln_1_2', x: 0.1, y: 0.1, w: 0.3 }]
  };
  return doc;
};
/** What the B8 hooks will do once filled (the stubs refuse): one panel drawn, pasted into a copy of the page. */
const fillPanelFix = () => {
  vi.mocked(fixPanelProblem).mockReturnValue(null);
  vi.mocked(compileFixPanel).mockImplementation((doc) => {
    const { spec, resolution } = resolveJobFor(runPinOf(doc), 'panel');
    return { spec, resolution, aspect: '2:3', prompt: 'PANEL FIX test prompt', references: [{ label: 'Image 1', path: PANEL_REFERENCE_PATH }, { label: 'Image 2', path: PAGE_REFERENCE_PATH }] } as never;
  });
  vi.mocked(cropForPanel).mockResolvedValue('data:image/png;base64,CROP');
  vi.mocked(finishFixPanel).mockImplementation(async ({ base }) => `${await base()}#pasted`);
  vi.mocked(fixPanelMeta).mockImplementation((doc) => ({ cuts: doc.pages[0].render.cuts }));
};

let fake: FakeHistoryStore;
let docs: FakeDocStore;
/** What the recorder was handed at each commit: the action in scope, the ops, the origin, and how policy.ts classified
 *  it (the batch's actor; whether it set a drawing; the actor of its QC report alone). */
let seen: {
  action: PanelMomentAction | undefined;
  ops: string[];
  origin: OpsOrigin | undefined;
  actor: HistoryActor | null;
  drawing: boolean;
  qcActor?: HistoryActor | null;
}[];

const open = async (doc: ComicDoc) => {
  docs.docs.set(doc.id, { userId: USER, doc });
  const session = await getStudioSession(doc.id, USER, docs, { saveDebounceMs: 5 });
  const hooks = session.history;
  const onCommit = hooks.onCommit.bind(hooks);
  (hooks as { onCommit: typeof hooks.onCommit }).onCommit = (before, next, ops, origin, label) => {
    const action = currentHistoryAction();
    const patchOf = (o: DocOp) => (o as { patch?: { asset?: unknown; qc?: unknown } }).patch;
    const qc = ops.find((o) => o.op === 'render' && patchOf(o)?.qc && !patchOf(o)?.asset);
    seen.push({
      action,
      ops: ops.map((o) => o.op),
      origin,
      actor: classifyBatch(ops, origin, before, next, action?.type, label).actor,
      drawing: ops.some((o) => o.op === 'render' && !!patchOf(o)?.asset),
      ...(qc ? { qcActor: opActor(qc, origin, next, action?.type) } : {})
    });
    onCommit(before, next, ops, origin, label);
  };
  await session.flush();
  return session;
};
const rowsOf = (session: StudioSession) => fake.rows({ projectId: session.projectId, userId: USER }).reverse();
/** The action the recorder saw on the commits carrying this op. */
const actionsAt = (op: DocOp['op']) => seen.filter((s) => s.ops.includes(op)).map((s) => s.action);
/** The stream's own path for a UI click: confirmed, origin 'user', then its renders, then its flush. */
const click = async (session: StudioSession, ctx: ReturnType<typeof testContext>, action: StudioAction, opts: { confirmed?: boolean } = {}) => {
  await runAction(ctx, action, { confirmed: opts.confirmed ?? true, origin: 'user' });
  await ctx.settled();
  await session.flush();
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.mocked(analyzePageRender).mockResolvedValue({ qc: { ...QC }, balloons: [] } as never);
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  fake = createFakeHistoryStore();
  __setHistoryStoreForTests(fake);
  docs = fakeDocStore();
  seen = [];
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  __resetSessionsForTests();
  __setHistoryStoreForTests(null);
  vi.mocked(writePagePlan).mockReset();
  for (const fn of [analyzePageRender, onRenderVerdict, checkRenderSafety, fixPanelProblem, compileFixPanel, finishFixPanel, fixPanelMeta, cropForPanel]) {
    (fn as unknown as { mockRestore?: () => void }).mockRestore?.();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('with COMIC_HISTORY on, each action reaches the recorder with its commits', () => {
  beforeEach(() => {
    vi.stubEnv('COMIC_HISTORY', '1');
  });

  it('a UI-started "Plan the pages": the writer’s commit carries plan_pages, and the rows are the AI’s (before_ai + ai)', async () => {
    const session = await open(plannedDoc());
    // A line of yours first: the run's before_ai row keeps it as yours.
    session.commit([{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'My own line first' } }], { origin: 'user' });
    vi.mocked(writePagePlan).mockImplementation(async ({ doc }) => ({ pages: doc.pages.map((p) => ({ ...p, summary: `Rewritten ${p.n}` })), newCast: [], model: 'w' }));
    await click(session, testContext(session), { type: 'plan_pages' });
    expect(actionsAt('pages')).toEqual([{ type: 'plan_pages' }]);
    expect(seen.filter((s) => s.ops.includes('pages')).map((s) => s.origin)).toEqual(['user']);
    const rows = rowsOf(session);
    expect(rows.map((r) => r.kind)).toEqual(['start', 'before_ai', 'ai']);
    expect(rows[1].changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_1'] })]);
    expect(rows[2]).toMatchObject({ actor: 'ai', parentId: rows[1].id });
    expect(rows[2].label).toMatch(/^AI /);
    expect(rows[2].changes.every((c) => c.by === 'ai')).toBe(true);
  });

  it('a UI-started fix_panel (stub): its refusal reaches the recorder as fix_panel and changes nothing, so no row', async () => {
    const session = await open(drawnDoc());
    const ctx = testContext(session);
    await click(session, ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' });
    expect(actionsAt('message')).toEqual([{ type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix' }]);
    expect(rowsOf(session).map((r) => r.kind)).toEqual(['start']);
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('fix_panel once B8 fills the hooks: the background render carries the action, so the AI rows name the panel', async () => {
    fillPanelFix();
    const session = await open(drawnDoc());
    const ctx = testContext(session);
    await click(session, ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const fix = { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix' };
    expect(actionsAt('render').length).toBeGreaterThan(0);
    expect(actionsAt('render').every((a) => JSON.stringify(a) === JSON.stringify(fix))).toBe(true);
    // Nothing changed before the run: its ai row's parent is the head (the start row).
    const rows = rowsOf(session);
    expect(rows.map((r) => r.kind)).toEqual(['start', 'ai']);
    expect(rows[1]).toMatchObject({ actor: 'ai', label: 'AI redrew panel 2 on page 1', parentId: rows[0].id });
  });

  it('fix_panel once B8 fills the hooks: render statuses and the QC report stay "system", the run starts at the drawing, and a late check after your edit opens no AI run', async () => {
    fillPanelFix();
    // The page check is held until your edit has landed (a slow vision reply).
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let checking!: () => void;
    const checkStarted = new Promise<void>((resolve) => (checking = resolve));
    vi.mocked(analyzePageRender).mockImplementation(async () => {
      checking();
      await held;
      return { qc: { ...QC }, balloons: [] } as never;
    });
    const session = await open(drawnDoc());
    const ctx = testContext(session);
    const running = runAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' }, { confirmed: true, origin: 'user' });
    await checkStarted;
    // Your edit, made outside the action while its page is being checked: it closes the AI run.
    session.commit([{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'My line while it checks' } }], { origin: 'user' });
    release();
    await running;
    await ctx.settled();
    await session.flush({ final: true });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const fix = seen.filter((s) => s.action?.type === 'fix_panel');
    // 'queued' and 'rendering' (and every other status-only commit) carry the action and stay 'system'.
    const statuses = fix.filter((s) => s.ops.join() === 'render' && !s.drawing);
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.every((s) => s.actor === 'system')).toBe(true);
    // The run starts at the drawing (its before_ai is taken there), not at the 'queued' commit.
    expect(fix.find((s) => s.actor === 'ai')).toMatchObject({ drawing: true });
    // The late check: its QC report is 'system' and the free balloon placement the editor's; nothing in it is the AI's.
    const check = fix.find((s) => s.qcActor !== undefined)!;
    expect(check).toMatchObject({ qcActor: 'system', actor: 'editor' });
    expect(seen.find((s) => s.ops.includes('line') && s.origin === 'user')).toMatchObject({ action: undefined, actor: 'you' });
    // One AI run, closed by your edit; no second "Before the AI…" row for the late check; then where you left off.
    const rows = rowsOf(session);
    expect(rows.map((r) => r.kind)).toEqual(['start', 'ai', 'edits']);
    expect(rows[1]).toMatchObject({ actor: 'ai', label: 'AI redrew panel 2 on page 1' });
    expect(rows.filter((r) => r.kind === 'before_ai')).toEqual([]);
    // The last row holds your line; the check's statuses and placement never read as a second panel redraw.
    expect(rows[2].changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_1'] })]);
  });

  it('an approved fix_panel gate: the run carries the gated action, not approve_gate', async () => {
    fillPanelFix();
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = await open(doc);
    const ctx = testContext(session);
    // The director's (unconfirmed) start stops at a gate; the UI approves it.
    await runAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_3', mode: 'redraw' }, { confirmed: false, origin: 'director' });
    const gate = session.doc.gate!;
    expect(gate.status).toBe('open');
    await click(session, ctx, { type: 'approve_gate', gateId: gate.id });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const fix = { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_3', mode: 'redraw' };
    expect(actionsAt('render').every((a) => JSON.stringify(a) === JSON.stringify(fix))).toBe(true);
    // The approval's own commit (the gate turning 'approved') is approve_gate's.
    expect(seen.find((s) => s.ops.includes('gate') && s.action?.type === 'approve_gate')).toBeTruthy();
    expect(rowsOf(session).at(-1)).toMatchObject({ kind: 'ai', label: 'AI redrew panel 3 on page 1' });
  });

  it('a UI-started fit_render: the fitted image and its remapped balloons carry fit_render and are the editor’s', async () => {
    const session = await open(squareDoc());
    await click(session, testContext(session), { type: 'fit_render', target: { kind: 'page', id: 'pg_1' }, mode: 'pad' });
    expect(actionsAt('render')).toEqual([{ type: 'fit_render', mode: 'pad' }]);
    expect(actionsAt('balloons')).toEqual([{ type: 'fit_render', mode: 'pad' }]);
    expect(session.doc.pages[0].render.origin).toBe('derived');
    await session.flush({ final: true });
    const rows = rowsOf(session);
    expect(rows.map((r) => r.kind)).toEqual(['start', 'edits']);
    expect(rows[1].actor).toBe('editor');
    expect(rows[1].changes.length).toBeGreaterThan(0);
    expect(rows[1].changes.every((c) => c.by === 'editor')).toBe(true);
  });
});

describe('with COMIC_HISTORY unset', () => {
  it('the same actions make zero store calls: the session holds the no-op hooks', async () => {
    vi.stubEnv('COMIC_HISTORY', '');
    fillPanelFix();
    vi.mocked(writePagePlan).mockImplementation(async ({ doc }) => ({ pages: doc.pages.map((p) => ({ ...p, summary: `Rewritten ${p.n}` })), newCast: [], model: 'w' }));
    for (const [doc, action] of [
      [plannedDoc(), { type: 'plan_pages' }],
      [drawnDoc(), { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix' }],
      [squareDoc(), { type: 'fit_render', target: { kind: 'page', id: 'pg_1' }, mode: 'pad' }]
    ] as [ComicDoc, StudioAction][]) {
      const session = await getStudioSession(doc.id, USER, (docs.docs.set(doc.id, { userId: USER, doc }), docs), { saveDebounceMs: 5 });
      expect(session.history).toBe(NOOP_HISTORY_HOOKS);
      await click(session, testContext(session), action);
      await session.flush({ final: true });
      __resetSessionsForTests();
    }
    expect(fake.calls).toEqual([]);
  });
});
