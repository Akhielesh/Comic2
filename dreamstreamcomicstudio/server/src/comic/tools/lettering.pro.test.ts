// @vitest-environment node
// PE-LETTER wave notes 4, 5 and 21 on B-TOOL's director lettering (S2b integration). With PRO_EDIT_OPS_PATCHABLE off
// (the shipped state) set_lettering_style offers and accepts the 8 base looks only, exactly as before; with it on
// (flipped locally here) it also offers the 16 Pro looks by id or name, passes allowPro to the sanitizers, and the
// "switch to the horror lettering" ask (replies.ts PRO_PRESET_ALIASES) is recognised. A reset on a doc whose stored look
// is a Pro look names it through letteringPresetOf instead of throwing.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ on: false }));
vi.mock('../../../../shared/comic/ops.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/comic/ops.js')>();
  return {
    ...real,
    get PRO_EDIT_OPS_PATCHABLE() {
      return sw.on;
    }
  };
});

import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { LETTERING_PRESET_IDS, PRO_LETTERING_PRESET_IDS } from '../../../../shared/comic/lettering/style.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { requestedLetteringPreset } from '../replies.js';
import { createDirectorTurn } from '../tools.js';
import { letteringToolGroup } from './lettering.js';

afterEach(() => {
  sw.on = false;
});

const setup = (mutate?: (doc: ComicDoc) => void) => {
  const doc = plannedDoc();
  mutate?.(doc);
  const ctx = testContext(newSession(doc));
  const tools = letteringToolGroup.tools(ctx, createDirectorTurn());
  const tool = tools.find((t) => t.spec.function.name === 'set_lettering_style')!;
  return { ctx, tool, call: (args: Record<string, unknown>) => tool.execute(args) };
};
const presetEnum = (tool: ReturnType<typeof setup>['tool']) =>
  (tool.spec.function.parameters as { properties: { preset: { enum: string[] } } }).properties.preset.enum;

describe('set_lettering_style and the Pro looks (PE-LETTER #4, #21)', () => {
  it('switch off: the enum, the description and the parser stay on the 8 base looks; a Pro look is refused', async () => {
    const { tool, call, ctx } = setup();
    expect(presetEnum(tool)).toEqual([...LETTERING_PRESET_IDS]);
    expect(tool.spec.function.description).toContain('(classic, manga, storybook, noir, webtoon, retro_pulp, minimal, handwritten)');
    expect(tool.spec.function.description).not.toContain('shonen');
    // A tool argument error comes back as the tool's reply ("Error: …"), never a thrown call.
    const refused = String(await call({ preset: 'horror' }));
    expect(refused).toMatch(/^Error: Unknown lettering preset "horror"\. Choose one of: classic \(/);
    expect(refused).not.toMatch(/shonen/);
    expect(ctx.session.doc.letterStyle?.presetId ?? 'classic').toBe('classic');
  });

  it('switch on: the 16 Pro looks join the enum and the description, a Pro look is picked by id or by name and stored', async () => {
    sw.on = true;
    const { tool, call, ctx } = setup();
    expect(presetEnum(tool)).toEqual([...LETTERING_PRESET_IDS, ...PRO_LETTERING_PRESET_IDS]);
    expect(tool.spec.function.description).toContain('handwritten, shonen, horror');
    const res = await call({ preset: 'horror' });
    expect(ctx.session.doc.letterStyle?.presetId).toBe('horror');
    expect(String(res)).toMatch(/Lettering is now \*/);
    await call({ preset: 'Shonen action' });
    expect(ctx.session.doc.letterStyle?.presetId).toBe('shonen');
    expect(String(await call({ preset: 'nonsense' }))).toMatch(/^Error: Unknown lettering preset .*shonen \(Shonen action\).*zine \(Zine\)\.$/);
  });

  it('a reset on a doc that stores a Pro look names that look instead of throwing (letteringPresetOf)', async () => {
    const { call } = setup((d) => {
      d.letterStyle = { presetId: 'horror' as never, base: { textColor: '#222222' } };
    });
    const res = await call({ reset: true });
    expect(String(res)).toMatch(/back to the .+ preset/);
  });
});

describe('requestedLetteringPreset and the Pro aliases (PE-LETTER #5)', () => {
  it('switch off: Pro words never name a look; the base asks are unchanged', () => {
    expect(requestedLetteringPreset('switch to the horror lettering')).toBeUndefined();
    expect(requestedLetteringPreset('use the action manga lettering')).toBe('manga');
    expect(requestedLetteringPreset('handwritten fonts please')).toBe('handwritten');
  });

  it('switch on: a Pro alias names its look, and the more specific Pro phrase wins over a base word', () => {
    sw.on = true;
    expect(requestedLetteringPreset('switch to the horror lettering')).toBe('horror');
    expect(requestedLetteringPreset('use the spooky lettering')).toBe('horror');
    expect(requestedLetteringPreset('use the action manga lettering')).toBe('shonen');
    expect(requestedLetteringPreset('sci-fi lettering please')).toBe('sci_fi');
    expect(requestedLetteringPreset('use the manga lettering')).toBe('manga');
    expect(requestedLetteringPreset('set in a scary city, use big fonts')).toBeUndefined();
  });
});
