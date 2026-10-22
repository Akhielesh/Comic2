// Keys, taps and wheel (reader.md §2.3): direction-aware arrows, Space/PageUp/PageDown, Home/End,
// G/F/P/?/Esc, modifier chords ignored, webtoon scrolling, tap zones, double-tap, wheel accumulation
// with cooldown and RTL mirroring.
import { describe, expect, it } from 'vitest';
import { inOuterGrabZone, isDoubleTap, keyCommand, SHORTCUTS, tapCommand, WheelAccumulator } from './readerInput';

const book = { rtl: false, layout: 'single' as const };
const manga = { rtl: true, layout: 'spread' as const };
const column = { rtl: false, layout: 'scroll' as const };

describe('keyCommand', () => {
  it('arrows follow the reading direction', () => {
    expect(keyCommand({ key: 'ArrowRight' }, book)).toEqual({ type: 'step', delta: 1 });
    expect(keyCommand({ key: 'ArrowLeft' }, book)).toEqual({ type: 'step', delta: -1 });
    expect(keyCommand({ key: 'ArrowRight' }, manga)).toEqual({ type: 'step', delta: -1 });
    expect(keyCommand({ key: 'ArrowLeft' }, manga)).toEqual({ type: 'step', delta: 1 });
  });

  it('Space / Shift+Space / PageDown / PageUp, Home / End', () => {
    expect(keyCommand({ key: ' ' }, book)).toEqual({ type: 'step', delta: 1 });
    expect(keyCommand({ key: ' ', shiftKey: true }, book)).toEqual({ type: 'step', delta: -1 });
    expect(keyCommand({ key: 'PageDown' }, manga)).toEqual({ type: 'step', delta: 1 });
    expect(keyCommand({ key: 'PageUp' }, book)).toEqual({ type: 'step', delta: -1 });
    expect(keyCommand({ key: 'Home' }, book)).toEqual({ type: 'home' });
    expect(keyCommand({ key: 'End' }, book)).toEqual({ type: 'end' });
  });

  it('G / F / P / ? / Esc', () => {
    expect(keyCommand({ key: 'g' }, book)).toEqual({ type: 'guided' });
    expect(keyCommand({ key: 'G' }, book)).toEqual({ type: 'guided' });
    expect(keyCommand({ key: 'f' }, book)).toEqual({ type: 'fullscreen' });
    expect(keyCommand({ key: 'P' }, book)).toEqual({ type: 'play' });
    expect(keyCommand({ key: '?' }, book)).toEqual({ type: 'shortcuts' });
    expect(keyCommand({ key: 'Escape' }, book)).toEqual({ type: 'escape' });
  });

  it('leaves browser shortcuts alone and ignores unknown keys', () => {
    expect(keyCommand({ key: 'f', ctrlKey: true }, book)).toBeNull();
    expect(keyCommand({ key: 'ArrowRight', metaKey: true }, book)).toBeNull();
    expect(keyCommand({ key: 'ArrowRight', altKey: true }, book)).toBeNull();
    expect(keyCommand({ key: 'x' }, book)).toBeNull();
    expect(keyCommand({ key: 'ArrowDown' }, book)).toBeNull();
  });

  it('a column scrolls by screens instead of turning', () => {
    expect(keyCommand({ key: ' ' }, column)).toEqual({ type: 'scroll', amount: 0.85 });
    expect(keyCommand({ key: 'PageUp' }, column)).toEqual({ type: 'scroll', amount: -0.85 });
    expect(keyCommand({ key: 'ArrowRight' }, column)).toEqual({ type: 'scroll', amount: 1 });
  });
});

describe('taps', () => {
  it('outer 30 % turn (mirrored for RTL), the middle toggles the HUD', () => {
    expect(tapCommand(0.1, false)).toEqual({ type: 'step', delta: -1 });
    expect(tapCommand(0.9, false)).toEqual({ type: 'step', delta: 1 });
    expect(tapCommand(0.1, true)).toEqual({ type: 'step', delta: 1 });
    expect(tapCommand(0.5, false)).toEqual({ type: 'hud' });
  });

  it('grab zones and double-tap detection', () => {
    expect(inOuterGrabZone(0.7, 'right')).toBe(true);
    expect(inOuterGrabZone(0.5, 'right')).toBe(false);
    expect(inOuterGrabZone(0.3, 'left')).toBe(true);
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 250, x: 20, y: 15 })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 400, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 100, x: 80, y: 10 })).toBe(false);
    expect(isDoubleTap(null, { t: 0, x: 0, y: 0 })).toBe(false);
  });
});

describe('WheelAccumulator', () => {
  it('steps when the accumulated delta reaches ±60, then cools down for 350 ms', () => {
    const w = new WheelAccumulator();
    expect(w.push(0, 30, 0, false)).toBeNull();
    expect(w.push(0, 35, 20, false)).toEqual({ type: 'step', delta: 1 });
    expect(w.push(0, 100, 100, false)).toBeNull(); // cooldown
    expect(w.push(0, -70, 400, false)).toEqual({ type: 'step', delta: -1 });
  });

  it('a pause resets the accumulation', () => {
    const w = new WheelAccumulator();
    expect(w.push(0, 40, 0, false)).toBeNull();
    expect(w.push(0, 40, 500, false)).toBeNull();
  });

  it('horizontal trackpad swipes step in the reading direction', () => {
    expect(new WheelAccumulator().push(80, 5, 0, false)).toEqual({ type: 'step', delta: 1 });
    expect(new WheelAccumulator().push(80, 5, 0, true)).toEqual({ type: 'step', delta: -1 });
    expect(new WheelAccumulator().push(-80, 5, 0, true)).toEqual({ type: 'step', delta: 1 });
  });

  it('the shortcuts sheet lists every key command', () => {
    const keys = SHORTCUTS.map((s) => s.keys).join(' ');
    for (const k of ['←', 'Space', 'Page Up', 'Home', 'G', 'P', 'F', 'Esc', '?']) expect(keys).toContain(k);
  });
});
