import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { MAX_STEM_BYTES, exportFileStem, languageFolderName, padIndex, safeLangCode, sanitizeFilename } from './filenames';

describe('sanitizeFilename', () => {
  it('keeps the classic ASCII slug for Latin titles', () => {
    expect(sanitizeFilename('The Saffron Thief!')).toBe('the-saffron-thief');
    expect(sanitizeFilename('Café  Noir!!')).toBe('cafe-noir');
    expect(sanitizeFilename('???')).toBe('comic');
    expect(sanitizeFilename('')).toBe('comic');
    expect(sanitizeFilename(undefined)).toBe('comic');
  });

  it('keeps letters and marks of other scripts (a Telugu title stays Telugu, joiners kept)', () => {
    expect(sanitizeFilename('చంద్రుడి కథ!')).toBe('చంద్రుడి-కథ');
    expect(sanitizeFilename('नमस्ते दोस्त')).toBe('नमस्ते-दोस्त');
    expect(sanitizeFilename('ক্‍ষ')).toContain('‍');
    expect(sanitizeFilename('月までいこう')).toBe('月までいこう');
  });

  it('strips path separators, reserved characters, control and bidi-override characters', () => {
    const out = sanitizeFilename('../../etc/passwd:*?"<>|\u0000');
    expect(out).toBe('etc-passwd');
    // An RLO spoof ("evil‮fdp.exe" displays as "evilexe.pdf") loses the override.
    expect(sanitizeFilename('evil‮fdp.exe')).toBe('evilfdp-exe');
    expect(sanitizeFilename('a​b﻿c')).toBe('abc');
    for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '‮', '\u0007']) expect(sanitizeFilename(`x${bad}y`)).not.toContain(bad);
  });

  it('never starts with a dot, never ends with a dot or hyphen, never names a Windows device', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('Title...')).toBe('title');
    expect(sanitizeFilename('CON')).toBe('con-comic');
    expect(sanitizeFilename('lpt1')).toBe('lpt1-comic');
  });

  it('cuts long titles at a grapheme boundary', () => {
    const long = 'క్ష'.repeat(80);
    const out = sanitizeFilename(long, { maxGraphemes: 10 });
    expect(long.startsWith(out)).toBe(true);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith('్')).toBe(false); // never half a conjunct (a dangling virama)
    expect(sanitizeFilename('a'.repeat(200)).length).toBe(60);
  });

  it('keeps a long non-Latin name within a file-system-safe byte budget, cut at a grapheme', () => {
    const long = 'క్షత్రియ '.repeat(40);
    const out = sanitizeFilename(long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_STEM_BYTES);
    expect(long.replace(/ /g, '-').startsWith(out)).toBe(true);
    expect(out.endsWith('్')).toBe(false);
    expect(out.endsWith('-')).toBe(false);
    // A single cluster stacked with marks is no name: the fallback is used.
    expect(sanitizeFilename(`ఆ${'ి'.repeat(400)}`)).toBe('comic');
  });
});

describe('export names', () => {
  it('stems the title and adds an edition suffix', () => {
    const doc = makeSampleDoc();
    expect(exportFileStem(doc)).toBe('the-saffron-thief');
    expect(exportFileStem(doc, 'te')).toBe('the-saffron-thief-te');
    expect(exportFileStem(doc, '../x')).toBe('the-saffron-thief');
  });

  it('validates language codes and names language folders', () => {
    expect(safeLangCode('zh-Hans')).toBe('zh-Hans');
    expect(safeLangCode('te/../../x')).toBeUndefined();
    expect(languageFolderName('te')).toBe('te-telugu');
    expect(languageFolderName('en')).toBe('en-english');
    expect(languageFolderName('../evil')).toBe('lang');
  });

  it('pads reading-order indexes', () => {
    expect(padIndex(0, 5)).toBe('00');
    expect(padIndex(7, 120)).toBe('007');
  });
});
