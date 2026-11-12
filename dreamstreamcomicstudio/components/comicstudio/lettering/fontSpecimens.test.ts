// The font picker's specimen sprite (master plan §2.8): one image of at most 60 KB, so browsing never downloads a face.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_IDS } from '../../../shared/comic/lettering/style';
import { PRO_FONT_IDS } from '../../../shared/comic/lettering/proFonts';
import { SPECIMEN, SPECIMEN_MAX_BYTES, layoutSpecimens } from '../../../scripts/build-font-specimens.mjs';
import { FONT_SPECIMENS, FONT_SPECIMEN_SPRITE, fontSpecimenStyle } from './fontSpecimens';

const PNG = join(__dirname, 'fontSpecimens.png');

describe('font specimen sprite', () => {
  it('is at most 60 KB, and the module states its real size', () => {
    const bytes = statSync(PNG).size;
    expect(SPECIMEN_MAX_BYTES).toBe(60 * 1024);
    expect(bytes).toBeLessThanOrEqual(SPECIMEN_MAX_BYTES);
    expect(FONT_SPECIMEN_SPRITE.bytes).toBe(bytes);
  });

  it('is a PNG of the declared size (2× for sharp text)', () => {
    const buf = readFileSync(PNG);
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(buf.readUInt32BE(16)).toBe(FONT_SPECIMEN_SPRITE.width * FONT_SPECIMEN_SPRITE.scale);
    expect(buf.readUInt32BE(20)).toBe(FONT_SPECIMEN_SPRITE.height * FONT_SPECIMEN_SPRITE.scale);
  });

  it('has one row per lettering face (26 base, then 28 Pro), each inside the sprite', () => {
    const ids = [...FONT_IDS, ...PRO_FONT_IDS];
    expect(Object.keys(FONT_SPECIMENS)).toEqual(ids);
    ids.forEach((id, i) => {
      const s = FONT_SPECIMENS[id];
      expect(s.y, id).toBe(i * FONT_SPECIMEN_SPRITE.rowHeight);
      expect(s.w, id).toBeGreaterThan(10);
      expect(s.w, id).toBeLessThanOrEqual(FONT_SPECIMEN_SPRITE.width);
    });
    expect(FONT_SPECIMEN_SPRITE.height).toBe(ids.length * FONT_SPECIMEN_SPRITE.rowHeight);
    expect(FONT_SPECIMEN_SPRITE.rowHeight).toBe(SPECIMEN.rowHeight);
  });

  it('matches the faces it was built from (a new or renamed face fails until the sprite is rebuilt)', async () => {
    const rows = (await layoutSpecimens()) as { id: string; y: number; w: number }[];
    expect(rows.map(({ id, y, w }) => ({ id, y, w }))).toEqual(Object.entries(FONT_SPECIMENS).map(([id, s]) => ({ id, y: s.y, w: s.w })));
  });

  it('shows a face as a mask over the text colour, sized to its row; unknown ids get nothing', () => {
    const s = FONT_SPECIMENS.bungee;
    expect(fontSpecimenStyle('bungee')).toMatchObject({
      width: s.w,
      height: FONT_SPECIMEN_SPRITE.rowHeight,
      backgroundColor: 'currentColor',
      maskPosition: `0 ${-s.y}px`,
      WebkitMaskPosition: `0 ${-s.y}px`,
      maskSize: `${FONT_SPECIMEN_SPRITE.width}px ${FONT_SPECIMEN_SPRITE.height}px`,
      maskRepeat: 'no-repeat'
    });
    expect(String(fontSpecimenStyle('comic-neue')?.maskImage)).toContain('fontSpecimens');
    expect(fontSpecimenStyle('nope')).toBeUndefined();
    expect(fontSpecimenStyle('__proto__')).toBeUndefined();
  });
});
