// @vitest-environment node
//
// The font registry (plan §6, §8, W1.3): OFL/Apache only; Reserved Font Names are read from each face's own
// copyright line, and a face with one is served unmodified (Titan One, Bowlby One SC, Bubblegum Sans and IBM Plex
// among them); every self-hosted face matches its record in scripts/licence-policy.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_STACK, FONT_LICENCES, PLATFORM_FONTS, fontRegistryProblems, fontStack, platformFont, reservedNamesIn, type PlatformFont } from './fonts.js';

const POLICY = fileURLToPath(new URL('../../../../scripts/licence-policy.json', import.meta.url));

describe('the registry', () => {
  it('has no problems: licences, reserved names, served-as, ids and CSS-safe names', () => {
    expect(fontRegistryProblems(PLATFORM_FONTS)).toEqual([]);
  });

  it("reserved-name fonts are servedAs: 'unmodified'", () => {
    const reserved = PLATFORM_FONTS.filter((f) => f.reservedNames.length > 0);
    expect(reserved.map((f) => f.id).sort()).toEqual(['bowlby-one-sc', 'bubblegum-sans', 'ibm-plex-sans', 'titan-one']);
    for (const f of reserved) expect(f.servedAs, f.id).toBe('unmodified');
  });

  it('the faces plan §8 names carry the Reserved Font Names their licences declare', () => {
    expect(platformFont('titan-one')?.reservedNames).toEqual(['Titan']);
    expect(platformFont('bowlby-one-sc')?.reservedNames).toEqual(['Bowlby', 'Bowlby One', 'Bowlby One SC']);
    expect(platformFont('bubblegum-sans')?.reservedNames).toEqual(['Bubblegum Sans']);
    expect(platformFont('ibm-plex-sans')?.reservedNames).toEqual(['Plex']);
    expect(platformFont('space-grotesk')?.reservedNames).toEqual([]);
  });

  it('every licence is OFL-1.1 or Apache-2.0', () => {
    for (const f of PLATFORM_FONTS) expect(FONT_LICENCES).toContain(f.licence);
  });

  it('every self-hosted face matches a licence-policy record with the same licence', () => {
    const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as { dataAssets: { records: { name: string; licence: string; terms: string }[] } };
    for (const f of PLATFORM_FONTS.filter((x) => x.hosting === 'self')) {
      const rec = policy.dataAssets.records.find((r) => r.name === f.family);
      expect(rec, f.family).toBeDefined();
      expect(rec?.licence).toBe(f.licence);
      for (const name of f.reservedNames) expect(rec?.terms).toContain(name);
    }
  });
});

describe('fontRegistryProblems catches a bad face', () => {
  const base = platformFont('ibm-plex-sans') as PlatformFont;
  const one = (patch: Partial<PlatformFont>) => fontRegistryProblems([{ ...base, ...patch }]);

  it('a reserved-name face served modified', () => {
    expect(one({ servedAs: 'modified' })).toEqual(['font "ibm-plex-sans": has a Reserved Font Name, so it must be served unmodified (servedAs \'unmodified\')']);
  });

  it('reservedNames that drift from the copyright line (either way)', () => {
    expect(one({ reservedNames: [] }).join()).toMatch(/differ from the copyright line/);
    expect(one({ reservedNames: [], servedAs: 'modified' }).join()).toMatch(/must be served unmodified/);
    expect(fontRegistryProblems([{ ...(platformFont('inter') as PlatformFont), reservedNames: ['Inter'] }]).join()).toMatch(/differ from the copyright line/);
  });

  it('a licence outside the allowlist, a duplicate id, CSS-unsafe names', () => {
    expect(one({ licence: 'GPL-3.0' as never }).join()).toMatch(/licence "GPL-3.0" is not one of/);
    expect(fontRegistryProblems([base, base]).join()).toMatch(/duplicate id/);
    expect(one({ family: "Plex'; } body { x" }).join()).toMatch(/family has characters/);
    expect(one({ fallback: 'Arial; background:url(x)' }).join()).toMatch(/fallback has characters/);
  });
});

describe('reservedNamesIn', () => {
  it('reads quoted, multiple and bare declarations; none is []', () => {
    expect(reservedNamesIn('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"')).toEqual(['Plex']);
    expect(reservedNamesIn('Copyright (c) 2011 by v, with Reserved Font Names "A" "B C" and "D"')).toEqual(['A', 'B C', 'D']);
    expect(reservedNamesIn('Copyright (c) 2011, R, with Reserved Font Name Titan.')).toEqual(['Titan']);
    expect(reservedNamesIn('Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)')).toEqual([]);
  });
});

describe('fontStack', () => {
  it('quotes the family and appends the fallback; unknown ids get the default', () => {
    expect(fontStack('ibm-plex-sans')).toBe("'IBM Plex Sans', -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif");
    expect(fontStack('nope')).toBe(DEFAULT_FONT_STACK);
    expect(fontStack(undefined)).toBe(DEFAULT_FONT_STACK);
  });
});
