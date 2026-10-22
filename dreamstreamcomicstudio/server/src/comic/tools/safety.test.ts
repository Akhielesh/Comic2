// Director tool group "safety": the two tools, the §6.1 prompt block and the summary lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender } from '../../../../shared/comic/doc.js';
import { RATING_RULES } from '../../../../shared/comic/safety.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { installSafetyFakes, resetSafety, type SafetyFakes } from '../safety/testkit.js';
import { createDirectorTurn } from '../tools.js';
import { safetyToolGroup } from './safety.js';

let fakes: SafetyFakes;
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fakes = installSafetyFakes();
});
afterEach(() => {
  resetSafety();
  vi.restoreAllMocks();
});

const toolsFor = (doc = plannedDoc(), caps?: { ratingCeiling: 'G' | 'PG' | 'PG-13' }) => {
  const ctx = testContext(newSession(doc), caps ? { caps: { ...(caps as object) } as never } : {});
  const turn = createDirectorTurn();
  const tools = safetyToolGroup.tools(ctx, turn);
  const byName = Object.fromEntries(tools.map((t) => [t.spec.function.name, t]));
  return { ctx, turn, tools, byName };
};

describe('safety tool group', () => {
  it('is always on, offers exactly the two free tools and labels their activity', () => {
    const { tools } = toolsFor();
    expect(safetyToolGroup.when).toBeUndefined();
    expect(tools.map((t) => t.spec.function.name)).toEqual(['set_content_rating', 'request_safety_review']);
    expect(tools.every((t) => t.cost === 'free' && t.spec.function.description.startsWith('FREE — '))).toBe(true);
    expect(safetyToolGroup.activity).toEqual({ set_content_rating: 'Setting the rating', request_safety_review: 'Asking for a second look' });
  });

  it('set_content_rating stores the wish when allowed and explains the cap when not', async () => {
    const { ctx, byName } = toolsFor();
    expect(await byName.set_content_rating.execute({ rating: 'PG' })).toMatch(/^Rating set to PG/);
    expect(ctx.session.doc.settings.rating).toBe('PG');
    expect(await byName.set_content_rating.execute({ rating: 'R' })).toMatch(/^Error: rating must be/);

    const kids = plannedDoc();
    kids.brief.audience = 'kids ages 4–8';
    const k = toolsFor(kids);
    expect(await k.byName.set_content_rating.execute({ rating: 'PG-13' })).toBe('Kept at PG — the audience is "kids ages 4–8", which caps at PG. Change the audience to go higher.');
    expect(k.ctx.session.doc.settings.rating).toBeUndefined();

    const young = toolsFor(plannedDoc(), { ratingCeiling: 'PG' });
    expect(await young.byName.set_content_rating.execute({ rating: 'PG-13' })).toBe('Kept at PG — this account caps at PG.');
  });

  it('request_safety_review resolves the target and reports the second look', async () => {
    const doc = plannedDoc();
    doc.settings.rating = 'PG';
    doc.pages[1].render = { ...emptyRender(), status: 'ready', asset: { path: 'p2.webp', source: 'generated', at: 1, safety: { assessed: 'PG-13', at: 1 } } };
    const { byName } = toolsFor(doc);
    fakes.llm.script.writer = [{ rating: 'PG', categories: [], notes: [], photo: false, minorLikely: false, subject: 'other', view: 'none', caption: '', multipleSubjects: false }];
    expect(await byName.request_safety_review.execute({ target: 'page', page: 2 })).toBe("Second look: Page 2 is fine (PG) — it's back.");
    expect(await byName.request_safety_review.execute({ target: 'page', page: 9 })).toMatch(/^Error: There is no page 9/);
    expect(await byName.request_safety_review.execute({ target: 'sheet', character: 'Nobody' })).toMatch(/Cast: Maya, Arjun/);
  });

  it('the prompt block carries the rating rule, the welcome for action/horror and the ceiling', () => {
    const kids = plannedDoc();
    kids.brief.audience = 'kids 2–6';
    toolsFor(kids);
    const rules = safetyToolGroup.promptRules!(kids)!;
    expect(rules).toContain('CONTENT RATING — this comic is G (little-kids audience).');
    expect(rules).toContain(RATING_RULES.G.story);
    expect(rules).toMatch(/monsters, villains and peril are welcome/);
    expect(rules).toContain('cannot go above G');
  });

  it('summary lines show the rating, the cap and flagged renders', () => {
    const doc = plannedDoc();
    doc.brief.audience = 'kids 8-10';
    doc.settings.rating = 'PG-13';
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p1.webp', source: 'generated', at: 1, safety: { assessed: 'X', categories: ['graphic_gore'], at: 1 } } };
    const { turn } = toolsFor(doc);
    const lines = safetyToolGroup.summaryLines!(doc, { ...turn, rating: 'PG' });
    expect(lines[0]).toBe('Rating: PG — you set PG-13; kids audience → up to PG');
    expect(lines[1]).toMatch(/^Safety: Page 1 needs a safer redraw \(graphic injury\)/);
  });
});
