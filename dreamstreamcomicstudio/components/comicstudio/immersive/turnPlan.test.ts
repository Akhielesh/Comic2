// Turn roles (reader.md §3.3–§3.6): who is front / back / under / static for every direction, layout and
// reading direction; the cover turns as a board; riffles; slide/fade for strips, low power and creator
// choices; persistent layers (the mount window).
import { describe, expect, it } from 'vitest';
import type { ReaderItem } from '../reader/readerModel';
import { bookGeometry, bookViews, type ReaderLayout } from './readerLayout';
import { LAYER_Z, mountWindow, planTurn, roleOf, type TurnStyle } from './turnPlan';

const item = (i: number, kind: 'cover' | 'page' = 'page'): ReaderItem => ({
  key: kind === 'cover' ? 'cover' : `pg_${i}`,
  kind,
  label: kind === 'cover' ? 'Cover' : `Page ${i}`,
  asset: { path: `u/${i}.webp`, source: 'generated', at: 0 }
});
const items = [item(0, 'cover'), ...[1, 2, 3, 4, 5].map((i) => item(i))];

const plan = (layout: ReaderLayout, from: number, to: number, rtl = false, style: TurnStyle = 'paper', lowPower = false, riffle?: number) => {
  const views = bookViews(items, layout === 'spread' ? 'spread' : 'single');
  const g = (v: number) => bookGeometry({ view: views[v], stage: { w: 1280, h: 800 }, layout: layout === 'spread' ? 'spread' : 'single', rtl, aspectOf: () => 2 / 3, pageAspect: 2 / 3, widthClass: 'large' });
  return planTurn({ layout, rtl, style, lowPower, items, from, to, geomFrom: g(from), geomTo: g(to), riffle });
};

describe('spreads', () => {
  // Views: blank|cover, ep-front|i1, i2|i3, i4|i5, ep-back|end
  it('LTR forward: the right page turns, its back is the next left page, the next right is revealed', () => {
    const p = plan('spread', 2, 3);
    expect(p).toMatchObject({ kind: 'paper', leafSide: 'right', mirrored: false, mode: 'forward', frontKey: 'i3', backKey: 'i4', staticKeys: ['i2'], underKeys: ['i5'] });
  });

  it('LTR backward: the left page turns back in a mirrored frame', () => {
    const p = plan('spread', 3, 2);
    expect(p).toMatchObject({ kind: 'paper', leafSide: 'left', mirrored: true, frontKey: 'i4', backKey: 'i3', staticKeys: ['i5'], underKeys: ['i2'] });
  });

  it('RTL forward lifts the LEFT page (manga)', () => {
    const p = plan('spread', 2, 3, true);
    expect(p).toMatchObject({ leafSide: 'left', mirrored: true, frontKey: 'i3', backKey: 'i4', underKeys: ['i5'], staticKeys: ['i2'] });
  });

  it('the cover opens as a hardcover board onto the inside cover; coming back is a board too', () => {
    expect(plan('spread', 0, 1)).toMatchObject({ kind: 'board', frontKey: 'i0', backKey: 'ep-front', underKeys: ['i1'], staticKeys: [] });
    expect(plan('spread', 1, 0)).toMatchObject({ kind: 'board', frontKey: 'ep-front', backKey: 'i0' });
  });

  it('jumps riffle (except boards); creators can pick slide or fade; low power slides', () => {
    expect(plan('spread', 1, 4, false, 'paper', false, 3)).toMatchObject({ kind: 'riffle', riffle: 3 });
    expect(plan('spread', 0, 4, false, 'paper', false, 4).kind).toBe('board');
    expect(plan('spread', 2, 3, false, 'slide')).toMatchObject({ kind: 'slide', incomingKeys: ['i4', 'i5'], outgoingKeys: ['i2', 'i3'] });
    expect(plan('spread', 2, 3, false, 'fade').kind).toBe('fade');
    expect(plan('spread', 2, 3, false, 'paper', true).kind).toBe('slide');
    expect(plan('spread', 2, 3, false, 'fade', true).kind).toBe('slide');
  });
});

describe('single pages and strips', () => {
  it('forward: the page lifts away (paper back with show-through); backward: the previous page comes back', () => {
    expect(plan('single', 2, 3)).toMatchObject({ kind: 'paper', leafSide: 'center', mode: 'forward', frontKey: 'i2', underKeys: ['i3'], backExtra: 'paper' });
    expect(plan('single', 3, 2)).toMatchObject({ kind: 'paper', mode: 'reverse', frontKey: 'i2', underKeys: ['i3'] });
    expect(plan('single', 2, 3, true).mirrored).toBe(true);
  });

  it('the cover is a board whose back is the inside cover', () => {
    expect(plan('single', 0, 1)).toMatchObject({ kind: 'board', frontKey: 'i0', backExtra: 'endpaper' });
    expect(plan('single', 1, 0)).toMatchObject({ kind: 'board', mode: 'reverse', frontKey: 'i0' });
  });

  it('strips always slide', () => {
    expect(plan('strip', 2, 3).kind).toBe('slide');
  });
});

describe('roles and mount window', () => {
  it('idle: the current view is static, the rest hidden; a turn stacks front above static', () => {
    expect(roleOf('i2', ['i2', 'i3'], null)).toBe('static');
    expect(roleOf('i4', ['i2', 'i3'], null)).toBe('hidden');
    const p = plan('spread', 2, 3);
    expect(roleOf('i3', [], p)).toBe('front');
    expect(roleOf('i4', [], p)).toBe('back');
    expect(roleOf('i5', [], p)).toBe('under');
    expect(roleOf('i2', [], p)).toBe('static');
    expect(roleOf('i1', [], p)).toBe('hidden');
    expect(LAYER_Z.back).toBeGreaterThan(LAYER_Z.front);
    expect(LAYER_Z.front).toBeGreaterThan(LAYER_Z.static);
  });

  it('slides: going back, the current page slides away on top', () => {
    const p = plan('spread', 3, 2, false, 'slide');
    expect(roleOf('i4', [], p)).toBe('front');
    expect(roleOf('i2', [], p)).toBe('under');
  });

  it('keeps views current ±1 and any target mounted', () => {
    const views = bookViews(items, 'single');
    expect(mountWindow(views, 0)).toEqual([0, 1]);
    expect(mountWindow(views, 3, [6])).toEqual([2, 3, 4, 6]);
  });
});
