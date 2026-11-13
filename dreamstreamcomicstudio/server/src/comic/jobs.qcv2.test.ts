// @vitest-environment node
// P5-QC (COMIC_QC_V2) through the real job runner: an edit whose page check comes back with collapsed heads keeps the
// marks of the version it was made from (jobs.ts letterPage → vision.ts lastTrustedMarks), so a balloon tail never
// aims at the page corner. With the flag off — or at 'admins' for someone who is not an admin — the request and the
// stored report are today's. Fakes only: no paid call, no network, a synthetic doc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc, type Page, type QcReport, type SpeakerMark } from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { JOB_TIMINGS, runAction } from './jobs.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { VISION_SCHEMA, VISION_SCHEMA_V2 } from './vision.js';

const PAGE_PATH = 'u/user-1/p/proj-1/img/page1.webp';
/** The marks the first drawing's check left: Maya's head in panel 2, a face box around it. */
const GOOD_HEADS: SpeakerMark[] = [{ panel: 2, characterId: 'c_maya', head: { x: 0.31, y: 0.62 }, mouth: { x: 0.31, y: 0.65 } }];
const GOOD_KEEP: QcReport['keepOut'] = [{ panel: 2, kind: 'face', box: { x: 0.26, y: 0.57, w: 0.1, h: 0.1 } }];

/** The edited page's check: panels and balloons fine, but one head on the 0–1000 grid and one as a fraction. The
 *  fraction (panel 2) collapses under the grid's scale and is dropped; panel 3's fresh head is good and is kept. */
const collapsedReply = {
  panels: [
    { n: 1, box: { x: 0.02, y: 0.02, w: 0.96, h: 0.38 }, beat: 1, crosses: false },
    { n: 2, box: { x: 0.02, y: 0.42, w: 0.47, h: 0.56 }, beat: 2, crosses: false },
    { n: 3, box: { x: 0.51, y: 0.42, w: 0.47, h: 0.56 }, beat: 3, crosses: false }
  ],
  issues: [],
  textFound: [],
  extraOrMissingCharacters: [],
  score: 0.93,
  balloons: [{ lineId: 'ln_1_2', x: 0.1, y: 0.45, w: 0.2, tailX: 0.3, tailY: 0.6 }],
  safety: { rating: 'G', categories: [], notes: [] },
  keepOut: [],
  heads: [
    { panel: 2, name: 'Maya', head: { x: 0.31, y: 0.62 }, mouth: { x: 0.31, y: 0.65 } },
    { panel: 3, name: 'Maya', head: { x: 700, y: 600 }, mouth: { x: 700, y: 620 } }
  ],
  acting: [],
  inscriptions: []
};

const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.planStatus = 'approved';
  const p: Page = doc.pages[0];
  doc.pages[0] = {
    ...p,
    render: {
      ...emptyRender(),
      status: 'ready',
      asset: { path: PAGE_PATH, source: 'generated', at: 1, w: 1024, h: 1536 },
      qc: { score: 0.9, issues: [], checkedAt: 1, boxesFrom: 'vision', keepOut: GOOD_KEEP, heads: GOOD_HEADS }
    }
  };
  return doc;
};

const editOnce = async (opts: { env?: string; caps?: StudioCaps } = {}) => {
  if (opts.env === undefined) delete process.env.COMIC_QC_V2;
  else process.env.COMIC_QC_V2 = opts.env;
  const session = newSession(drawnDoc());
  const reply = () => ({ json: collapsedReply, text: JSON.stringify(collapsedReply) });
  const llm = scriptedLlm({ vision: [reply(), reply()] });
  const ctx = testContext(session, { llm, ...(opts.caps ? { caps: opts.caps } : {}) });
  ctx.assetsFake.files.set(PAGE_PATH, 'data:image/png;base64,Q1VSUkVOVA==');
  await runAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Make the lantern brighter' }, { confirmed: true });
  await ctx.settled();
  const page = session.doc.pages[0];
  const vision = llm.calls.find((c) => c.role === 'vision');
  return { page, qc: page.render.qc as QcReport & Record<string, unknown>, vision };
};

const ADMIN: StudioCaps = { ...DEFAULT_CAPS, admin: true };
const ENV = process.env.COMIC_QC_V2;
const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  if (ENV === undefined) delete process.env.COMIC_QC_V2;
  else process.env.COMIC_QC_V2 = ENV;
  vi.restoreAllMocks();
});

describe('letterPage with COMIC_QC_V2: an edit with collapsed heads keeps the last trusted marks', () => {
  it('the edit is a new version made from the drawn page (the parent keeps its check)', async () => {
    const { page } = await editOnce({ env: 'admins', caps: ADMIN });
    expect(page.render.parentPath).toBe(PAGE_PATH);
    expect(page.render.history[0]).toMatchObject({ path: PAGE_PATH, qc: { heads: GOOD_HEADS } });
  });

  it('flag on for an admin: the panel that lost its head keeps the previous marks, the fresh good head stays, and the check asked the v2 questions', async () => {
    const { qc, vision } = await editOnce({ env: 'admins', caps: ADMIN });
    expect(qc.heads).toEqual([...GOOD_HEADS, { panel: 3, characterId: 'c_maya', head: { x: 0.7, y: 0.6 }, mouth: { x: 0.7, y: 0.62 } }]);
    expect(qc.keepOut).toEqual(GOOD_KEEP);
    expect(vision?.jsonSchema?.schema).toBe(VISION_SCHEMA_V2);
    // Every stored head is a real head: nothing aims at the page corner.
    for (const h of qc.heads || []) expect(h.head.x > 0.01 && h.head.y > 0.01).toBe(true);
  });

  it("flag off: today's check and today's report (the collapsed head is stored as the reply gave it)", async () => {
    const off = await editOnce();
    expect(off.vision?.jsonSchema?.schema).toBe(VISION_SCHEMA);
    expect(off.qc.heads?.map((h) => h.head)).toEqual([
      { x: 0.0003, y: 0.0006 },
      { x: 0.7, y: 0.6 }
    ]);
    expect(off.qc).not.toHaveProperty('sides');
    // 'admins' for someone who is not an admin is the same as off, byte for byte (but the time of the check).
    const notAdmin = await editOnce({ env: 'admins', caps: DEFAULT_CAPS });
    const strip = (q: Record<string, unknown>) => ({ ...q, checkedAt: 0 });
    expect(strip(notAdmin.qc)).toEqual(strip(off.qc));
    // The request too, once the per-call random fence tag (S14) is set aside.
    const request = (r: typeof off.vision) => JSON.stringify(r?.messages).replace(/SCRIPT-[0-9A-F]+/g, 'SCRIPT-TAG');
    expect(request(notAdmin.vision)).toEqual(request(off.vision));
  });
});
