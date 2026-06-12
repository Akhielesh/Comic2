import { describe, it, expect } from 'vitest';
import { placeKind, PLACE_KIND_ICONS, PLACE_KIND_GLYPHS, PLACE_KIND_LABELS } from './placeKinds';

describe('placeKind', () => {
  it('maps parks to park (the fork-and-knife-on-parks bug)', () => {
    expect(placeKind('Park')).toBe('park');
    expect(placeKind('playground')).toBe('park');
    expect(placeKind('Stanley Isaacs Courts')).toBe('park');
    expect(placeKind('lawn')).toBe('park');
  });

  it('maps food / cafe / bar distinctly', () => {
    expect(placeKind('restaurant')).toBe('food');
    expect(placeKind('fast_food')).toBe('food');
    expect(placeKind('cafe')).toBe('cafe');
    expect(placeKind('bakery')).toBe('cafe');
    expect(placeKind('pub')).toBe('bar');
  });

  it('maps lodging, sights, shops and transit', () => {
    expect(placeKind('hotel')).toBe('hotel');
    expect(placeKind('guest_house')).toBe('hotel');
    expect(placeKind('museum')).toBe('sight');
    expect(placeKind('viewpoint')).toBe('sight');
    expect(placeKind('supermarket')).toBe('shop');
    expect(placeKind('subway station')).toBe('transit');
    expect(placeKind('airport')).toBe('flight');
  });

  it('falls back to other for unknown/empty', () => {
    expect(placeKind(undefined)).toBe('other');
    expect(placeKind('zzz-unknown')).toBe('other');
  });

  it('every kind has an icon, glyph slot and label', () => {
    for (const kind of Object.keys(PLACE_KIND_ICONS) as (keyof typeof PLACE_KIND_ICONS)[]) {
      expect(PLACE_KIND_ICONS[kind]).toBeTruthy();
      expect(PLACE_KIND_GLYPHS[kind]).toBeDefined();
      expect(PLACE_KIND_LABELS[kind]).toBeTruthy();
    }
  });
});
