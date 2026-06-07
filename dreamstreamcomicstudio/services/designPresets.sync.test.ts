import { describe, it, expect } from 'vitest';
import { DESIGN_PRESETS as CLIENT } from './designPresets';
import { DESIGN_PRESETS as SERVER } from '../server/src/ai/studio/designSystem';

// The client picker mirror (id + name) must stay in lock-step with the server's DESIGN_PRESETS,
// so a pinned preset id always resolves on the server.
describe('design preset client/server sync', () => {
  it('client mirror matches the server ids + names exactly', () => {
    const serverById = new Map(SERVER.map((p) => [p.id, p.name]));
    expect(CLIENT.length).toBe(SERVER.length);
    for (const c of CLIENT) {
      expect(serverById.has(c.id)).toBe(true);
      expect(c.name).toBe(serverById.get(c.id));
    }
  });
});
