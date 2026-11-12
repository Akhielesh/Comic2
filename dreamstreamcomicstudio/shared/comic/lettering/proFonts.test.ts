import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRO_FONT_IDS, PRO_FONT_ROLES, isProFontId } from './proFonts';
import { FONT_IDS } from './style';

describe('proFonts (PE-FONTS fills the PE-0 seam)', () => {
  it('lists the 28 Pro faces with a role each, and recognises only them', () => {
    expect(PRO_FONT_IDS).toHaveLength(28);
    expect(Object.keys(PRO_FONT_ROLES)).toEqual([...PRO_FONT_IDS]);
    for (const id of PRO_FONT_IDS) {
      expect(isProFontId(id)).toBe(true);
      expect(PRO_FONT_ROLES[id].length).toBeGreaterThan(2);
      expect(PRO_FONT_ROLES[id].length).toBeLessThanOrEqual(24); // fits the picker's one-line role
    }
    for (const v of [...FONT_IDS, 'Bungee', 'bungee ', '', null, 7, '__proto__']) expect(isProFontId(v)).toBe(false);
    expect(Object.isFrozen(PRO_FONT_IDS)).toBe(true);
  });

  it('stays dependency-free at runtime: style.ts imports it, so it may import only types (collisions B-2)', () => {
    const src = readFileSync(join(__dirname, 'proFonts.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+'([^']+)'/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const m of imports) expect(m[1], m[0]).toBe('type ');
    expect(src).not.toMatch(/^export \* from/m);
  });
});
