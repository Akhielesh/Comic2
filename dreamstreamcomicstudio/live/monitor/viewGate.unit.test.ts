// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DC_STALE_MS, HIDDEN_GRACE_MS, pictureOff, ViewGate } from './viewGate';

describe('viewGate: tell the room when the screen is hidden, at once and only on change', () => {
  it('hidden and shown are said at once — the receivers apply the grace', () => {
    const g = new ViewGate();
    expect(g.due(0)).toEqual({ vis: true, dc: false });
    expect(g.due(1000)).toBeNull();
    g.setShown(false);
    expect(g.due(2000)).toEqual({ vis: false, dc: false });
    expect(g.due(3000)).toBeNull();
    g.setShown(true);
    expect(g.due(4000)).toEqual({ vis: true, dc: false });
  });

  it('the data channel counts while it delivers, and not after DC_STALE_MS of silence', () => {
    const g = new ViewGate();
    g.due(0);
    g.dcMessage(1000);
    expect(g.due(1000)).toEqual({ vis: true, dc: true });
    g.dcMessage(3000);
    expect(g.due(3000 + DC_STALE_MS - 1)).toBeNull();
    expect(g.due(3000 + DC_STALE_MS)).toEqual({ vis: true, dc: false });
    g.dcMessage(20_000);
    g.dcClosed();
    expect(g.due(20_000)).toBeNull(); // closed is not delivering: no change from false
  });

  it('a new room connection hears it again', () => {
    const g = new ViewGate(false);
    expect(g.due(0)).toEqual({ vis: false, dc: false });
    g.reset();
    expect(g.due(1)).toEqual({ vis: false, dc: false });
  });

  it('the picture goes only after the grace', () => {
    expect(pictureOff(null, 1e9)).toBe(false);
    expect(pictureOff(0, HIDDEN_GRACE_MS - 1)).toBe(false);
    expect(pictureOff(0, HIDDEN_GRACE_MS)).toBe(true);
  });
});
