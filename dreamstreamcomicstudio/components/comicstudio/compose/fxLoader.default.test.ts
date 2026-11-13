// PE-COMPOSE wave note 5 (S2b integration, collisions B-7): compose's effect loader defaults to PE-FX's generators module
// as a dynamic import, so an effect page draws without any caller setting a loader, and the drawings stay their own lazy
// chunk (compose.test.tsx forbids a static import). Before the load renderFx draws nothing; one ensureFxDrawings call
// registers them for the whole app.
import { describe, expect, it } from 'vitest';
import { renderFx } from '../../../shared/comic/fx/registry';
import type { LayerFx } from '../../../shared/comic/fx';
import { ensureFxDrawings, fxDrawingsPending } from './pageNodes';
import { LAYERS, layeredDoc } from './__fixtures__/composeDocs';

describe('the default effect loader (PE-COMPOSE wave note 5)', () => {
  it('is set: an effect page waits for the drawings, one load registers them, and they draw', async () => {
    const page = layeredDoc([LAYERS.effect]).pages[0];
    const fx = (LAYERS.effect as { fx: LayerFx }).fx;
    expect(renderFx(fx, { aspect: 1 })).toEqual([]);
    expect(fxDrawingsPending(page)).toBe(true);
    expect(await ensureFxDrawings(page)).toBe(true);
    expect(fxDrawingsPending(page)).toBe(false);
    expect(renderFx(fx, { aspect: 1 }).length).toBeGreaterThan(0);
    // Once loaded, nothing more waits or loads again.
    expect(await ensureFxDrawings(page)).toBe(false);
  });
});
