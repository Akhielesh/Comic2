// @vitest-environment node
// M1-DIRECTOR-MODELS (models.md §3.8, §3.4 #6; reliability.md §2 Director): the director suggests image models
// with real numbers and never switches. Fakes only: the merged catalog over the public 17:51Z OpenRouter fixture,
// the fake model-health port, scripted model replies. No network, $0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { makeLakeComic } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { JOB_TIMINGS } from '../jobs.js';
import { newSession, plannedDoc, testContext, type TestContext } from '../orchestrator.fakes.js';
import { buildDirectorTools, createDirectorTurn, type DirectorTool, type DirectorTurn } from '../tools.js';

let ctx: TestContext;
let turn: DirectorTurn;
let tools: Map<string, DirectorTool>;
let ops: DocOp[];
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args);

const setup = (doc: ComicDoc, userText = 'the user message') => {
  ctx = testContext(newSession(doc));
  ops = [];
  ctx.session.subscribe((e) => {
    if (e.type === 'ops') ops.push(...e.ops);
  });
  turn = createDirectorTurn({ userText });
  tools = new Map(buildDirectorTools(ctx, turn).map((t) => [t.spec.function.name, t]));
};

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('set_settings on a locked comic (models.md §3.4 #6)', () => {
  it('refuses a tier change with the lock copy: resolution is the user\'s call, the model stays, nothing is committed', async () => {
    const doc = makeLakeComic((d) => {
      d.settings = { ...d.settings, quality: 'standard' };
      d.imageModel = { modelId: 'nano-banana-2.1', lockedAt: 1, origin: 'first_render' };
    });
    setup(doc);
    const out = await call('set_settings', { quality: 'draft' });
    expect(out).toMatch(/^Error: Locked comic: resolution changes are the user's call\. Offer the quality chip\./);
    expect(out).toContain('stays on Nano Banana 2.1');
    expect(out).toContain('draft would only draw new pages at 1K');
    expect(out).toContain('No tool can change the image model');
    expect(ctx.session.doc.settings.quality).toBe('standard');
    expect(ops.filter((o) => o.op === 'settings')).toEqual([]);
    // Other tightening still works on a locked comic.
    expect(await call('set_settings', { budgetUsd: 3 })).toContain('budget $3.00');
  });

  it('a legacy comic locks through its generated assets (deriveLock): even a Pro-tier comic keeps its drawn model', async () => {
    const doc = makeLakeComic((d) => {
      d.settings = { ...d.settings, quality: 'pro' };
    });
    expect(doc.imageModel).toBeUndefined();
    setup(doc);
    const out = await call('set_settings', { quality: 'standard' });
    expect(out).toMatch(/^Error: Locked comic: resolution changes are the user's call/);
    expect(out).toContain('stays on Nano Banana 2.1');
    expect(ctx.session.doc.settings.quality).toBe('pro');
  });

  it('style swatches never lock: before the first comic image the director may still lower the tier', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, quality: 'standard' };
    doc.style.options = [
      { id: 'so_1', name: 'Ink', spec: 'Bold ink', render: { ...emptyRender(), status: 'ready', asset: { path: 'u/s1.webp', source: 'generated', at: 1, model: 'nano-banana-2.1' } } }
    ];
    setup(doc);
    expect(await call('set_settings', { quality: 'draft' })).toMatch(/^Settings: draft quality;/);
    expect(ctx.session.doc.settings.quality).toBe('draft');
  });

  it('never takes a model argument: the schema has no model field and an extra one changes nothing', async () => {
    const doc = makeLakeComic();
    setup(doc);
    const spec = tools.get('set_settings')!.spec.function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(spec.properties).sort()).toEqual(['bigSpendUsd', 'budgetUsd', 'confirm', 'quality']);
    await call('set_settings', { imageModelOverride: 'nano-banana-pro', budgetUsd: 2 } as Record<string, unknown>);
    expect(ctx.session.doc.settings.imageModelOverride).toBeUndefined();
    expect(ops.some((o) => o.op === 'settings' && 'imageModelOverride' in (o.patch as Record<string, unknown>))).toBe(false);
  });
});
