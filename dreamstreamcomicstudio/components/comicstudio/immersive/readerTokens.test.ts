// @vitest-environment node
// Reader tokens (reader.md §5.1 RD-0, V1 C9; V2 N1): readerDesigns.css is the one source of truth and the TS
// defaults (readerTokens.ts, TURN_MS) equal its values as the reader computes them — under the Atlas skin the
// reader root always carries, so --ds-motion-medium is 150 ms and --ds-motion-slow 200 ms. Fade is 280 ms
// everywhere. And the room's own accent / focus colours are visible on the room (≥ 3:1, WCAG 1.4.11 / 2.4.7)
// in every theme, which the app accent (#0a0a0a in Atlas light: 1.02:1 on the room) never was.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, indexCss, over, parseRules, ratio, resolveColor, tokenBlocks, tokensOf, type Rgba } from '../../../tests/config/cssTokens';
import { CHAIN_FACTOR, TURN_MS } from './flipPhysics';
import { durationFor } from './leafEngine';
import {
  bezierCss,
  parseBezier,
  parseMs,
  parseNumber,
  parseTokenValue,
  READER_TOKEN_DEFAULTS,
  READER_TOKEN_NAMES,
  readReaderTokens,
  type ReaderMotionTokens
} from './readerTokens';

const DIR = path.join(APP_ROOT, 'components/comicstudio/immersive');
const readerCss = readFileSync(path.join(DIR, 'readerDesigns.css'), 'utf8');
const readerRules = parseRules(readerCss);
const NIGHT = tokensOf(readerRules.filter((r) => r.parents.length === 0), (s) => s === '[data-reader-root]');
const DAY = tokensOf(readerRules.filter((r) => r.parents.length === 0), (s) => s === '[data-reader-root][data-reader-room="day"]');
const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_DARK_MORE } = tokenBlocks(parseRules(indexCss));

/** The cascade inside the reader root: its own block first, then the Atlas skin it carries, then the base. */
const CONTEXTS: Record<string, Map<string, string>[]> = {
  'atlas light': [NIGHT, ATLAS_LIGHT, ROOT_TOKENS],
  'atlas dark': [NIGHT, ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS],
  'atlas light more contrast': [NIGHT, ATLAS_LIGHT_MORE, ATLAS_LIGHT, ROOT_TOKENS],
  'atlas dark more contrast': [NIGHT, ATLAS_DARK_MORE, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS]
};
const lookup = (chain: Map<string, string>[], name: string): string => {
  for (const b of chain) {
    const v = b.get(name);
    if (v !== undefined) return v;
  }
  throw new Error(`${name} is not defined`);
};
/** Resolve a raw value's var() chain as text (motion values are not colours). */
const resolveText = (chain: Map<string, string>[], value: string, depth = 0): string => {
  if (depth > 8) throw new Error(`var() loop at ${value}`);
  const m = /^\s*var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)\s*$/.exec(value);
  if (!m) return value.trim();
  return resolveText(chain, lookup(chain, m[1]), depth + 1);
};
const colour = (chain: Map<string, string>[], name: string): Rgba => resolveColor(lookup(chain, name), (n) => lookup(chain, n), [name]);

describe('readerDesigns.css motion tokens = the TS defaults (as the Atlas-skinned reader computes them)', () => {
  it('every token the engine reads is defined, and parses to its TS default', () => {
    const chain = CONTEXTS['atlas light'];
    for (const key of Object.keys(READER_TOKEN_NAMES) as (keyof ReaderMotionTokens)[]) {
      const raw = resolveText(chain, lookup(chain, READER_TOKEN_NAMES[key]));
      expect(parseTokenValue(key, raw), `${READER_TOKEN_NAMES[key]} = ${raw}`).toEqual(READER_TOKEN_DEFAULTS[key]);
    }
  });

  it('the skinned DS values hold in the dark theme too (the reader looks the same in both)', () => {
    const chain = CONTEXTS['atlas dark'];
    for (const key of Object.keys(READER_TOKEN_NAMES) as (keyof ReaderMotionTokens)[]) {
      expect(parseTokenValue(key, resolveText(chain, lookup(chain, READER_TOKEN_NAMES[key]))), key).toEqual(READER_TOKEN_DEFAULTS[key]);
    }
  });

  it('builds on the DS tokens where the spec says (slide = enter-slow, fade = enter, HUD = medium, edges = slow)', () => {
    expect(NIGHT.get('--ds-reader-turn-slide')).toBe('var(--ds-motion-enter-slow)');
    expect(NIGHT.get('--ds-reader-turn-fade')).toBe('var(--ds-motion-enter)');
    expect(NIGHT.get('--ds-reader-hud-motion')).toBe('var(--ds-motion-medium)');
    expect(NIGHT.get('--ds-reader-edge-motion')).toBe('var(--ds-motion-slow)');
    expect(NIGHT.get('--ds-reader-intro-ease')).toBe('var(--ds-ease-enter)');
    // C9: under the skin the HUD is 150 ms and the edges 200 ms (not the unskinned 200 / 300).
    expect(READER_TOKEN_DEFAULTS.hud).toBe(150);
    expect(READER_TOKEN_DEFAULTS.edge).toBe(200);
  });

  it('fade is 280 ms everywhere: the token, TURN_MS and durationFor (it was 180 in one place and 300 in another)', () => {
    expect(parseMs(resolveText(CONTEXTS['atlas light'], 'var(--ds-reader-turn-fade)'))).toBe(280);
    expect(TURN_MS.fade).toBe(280);
    expect(READER_TOKEN_DEFAULTS.turnFade).toBe(280);
    expect(durationFor('fade', false, false)).toBe(280);
    expect(durationFor('fade', true, false)).toBe(280);
    expect(durationFor('fade', false, true)).toBe(Math.round(280 * CHAIN_FACTOR));
  });

  it('durationFor reads the token set it is given (a design can change its turns from CSS alone)', () => {
    const t = { ...READER_TOKEN_DEFAULTS, turn: 520, turnSpread: 640, turnBoard: 760, chain: 0.5 };
    expect(durationFor('paper', false, false, t)).toBe(520);
    expect(durationFor('paper', true, false, t)).toBe(640);
    expect(durationFor('board', false, false, t)).toBe(760);
    expect(durationFor('paper', false, true, t)).toBe(260);
  });

  it('the spotlight dims the room by the token alpha (0.78, today), as one fill token', () => {
    expect(NIGHT.get('--ds-reader-spot')).toBe('0.78');
    expect(NIGHT.get('--ds-reader-spot-fill')).toBe('rgba(10, 9, 8, var(--ds-reader-spot))');
  });
});

describe('readerTokens parsing (read once per mount; never throws, never NaN)', () => {
  it('parses ms, s, beziers and plain numbers; rejects the rest', () => {
    expect(parseMs('560ms')).toBe(560);
    expect(parseMs(' 0.42s ')).toBe(420);
    expect(parseMs('fast')).toBeNull();
    expect(parseMs('')).toBeNull();
    expect(parseMs('-5ms')).toBeNull();
    expect(parseBezier('cubic-bezier(0.38, 0.02, 0.18, 1)')).toEqual([0.38, 0.02, 0.18, 1]);
    expect(parseBezier('cubic-bezier(1.5, 0, 0, 1)')).toBeNull();
    expect(parseBezier('ease-in')).toBeNull();
    expect(parseNumber('0.65')).toBe(0.65);
    expect(parseNumber('1e3')).toBeNull();
    expect(bezierCss([0.16, 1, 0.3, 1])).toBe('cubic-bezier(0.16,1,0.3,1)');
  });

  it('readReaderTokens takes each computed value that parses and keeps the default for the rest', () => {
    const fake = { getPropertyValue: (n: string) => ({ '--ds-reader-turn': ' 600ms', '--ds-reader-chain': '0.5', '--ds-reader-ease-paper': 'cubic-bezier(0.1, 0.2, 0.3, 1)', '--ds-reader-turn-fade': 'oops' })[n] ?? '' };
    const t = readReaderTokens({} as Element, () => fake);
    expect(t.turn).toBe(600);
    expect(t.chain).toBe(0.5);
    expect(t.easePaper).toEqual([0.1, 0.2, 0.3, 1]);
    expect(t.turnFade).toBe(280);
    expect(t.turnBoard).toBe(READER_TOKEN_DEFAULTS.turnBoard);
    expect(readReaderTokens(null)).toBe(READER_TOKEN_DEFAULTS);
    expect(readReaderTokens({} as Element, () => { throw new Error('no style'); })).toBe(READER_TOKEN_DEFAULTS);
  });
});

// ── N1: the room's accent and focus are visible on the room ─────────────────────────────────────────
const nightRoom = (chain: Map<string, string>[]) => colour(chain, '--ds-reader-room');
const glassOver = (chain: Map<string, string>[], room: Rgba) => over(colour(chain, '--ds-reader-glass'), room);

describe('N1 · the room-side accent and focus colours reach 3:1 on the room and its glass, in every theme', () => {
  it('Night: --ds-reader-accent and --ds-reader-hud-focus on the room, the HUD glass and the progress tracks', () => {
    for (const [ctx, chain] of Object.entries(CONTEXTS)) {
      const room = nightRoom(chain);
      const glass = glassOver(chain, room);
      for (const name of ['--ds-reader-accent', '--ds-reader-hud-focus']) {
        const c = colour(chain, name);
        expect(ratio(c, room), `${ctx}: ${name} on the room`).toBeGreaterThanOrEqual(3);
        expect(ratio(c, glass), `${ctx}: ${name} on the HUD glass`).toBeGreaterThanOrEqual(3);
      }
      // The hairline track (white 10 % on the room) and the scrubber track (white 20 % on the glass).
      const accent = colour(chain, '--ds-reader-accent');
      expect(ratio(accent, over(resolveColor('rgba(255,255,255,0.1)'), room)), `${ctx}: hairline fill on its track`).toBeGreaterThanOrEqual(3);
      expect(ratio(accent, over(resolveColor('rgba(255,255,255,0.2)'), glass)), `${ctx}: scrubber fill on its track`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the app accent the reader used before is NOT visible on the room in Atlas light (the bug, pinned: 1.02:1)', () => {
    const chain = CONTEXTS['atlas light'];
    expect(ratio(colour(chain, '--ds-accent'), nightRoom(chain))).toBeLessThan(1.1);
  });

  it('Day room (RD-2 renders it): the pair is ink on the light room and its light glass', () => {
    for (const [ctx, base] of Object.entries(CONTEXTS)) {
      const chain = [DAY, ...base];
      const room = colour(chain, '--ds-reader-room');
      const glass = glassOver(chain, room);
      for (const name of ['--ds-reader-accent', '--ds-reader-hud-focus']) {
        expect(ratio(colour(chain, name), room), `${ctx} day: ${name} on the room`).toBeGreaterThanOrEqual(3);
        expect(ratio(colour(chain, name), glass), `${ctx} day: ${name} on the glass`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

/**
 * The colour each reader file paints its focus rings and progress fills with, as written in the source:
 * every `ring-[var(--…)]` and the accent fills. Room-side files draw over the room (or its glass); the End
 * card draws on the paper.
 */
const ROOM_SIDE = ['ImmersiveReader.tsx', 'ReaderHud.tsx', 'PageScrubber.tsx', 'ReaderSettingsSheet.tsx', 'CoverIntro.tsx', 'BookStage.tsx'];
const ringVars = (src: string) => [...src.matchAll(/ring-\[var\((--[\w-]+)\)\]/g)].map((m) => m[1]).filter((v) => !v.startsWith('--ds-reader-paper'));
/** Progress fills (the hairline, the scrubber) and the switch track when on (`transition-colors peer-checked:bg-…`). */
const fillVars = (src: string) =>
  [...src.matchAll(/(?:data-testid="(?:reader-progress|scrubber-fill)"[\s\S]{0,120}?|h-full bg-|inset-y-0 rounded-full bg-|transition-colors peer-checked:bg-)\[var\((--[\w-]+)\)\]/g)].map((m) => m[1]);

describe('N1 · every focus ring and progress fill in the reader files resolves to a visible colour where it is drawn', () => {
  it('room-side files: ≥ 3:1 on the room and on the HUD glass, in every Atlas context', () => {
    const fails: string[] = [];
    for (const file of ROOM_SIDE) {
      const src = readFileSync(path.join(DIR, file), 'utf8');
      const vars = [...new Set([...ringVars(src), ...fillVars(src)])];
      expect(vars.length, `${file} paints a ring or a fill`).toBeGreaterThan(0);
      for (const v of vars) {
        for (const [ctx, chain] of Object.entries(CONTEXTS)) {
          const room = nightRoom(chain);
          const c = colour(chain, v);
          const r = Math.min(ratio(c, room), ratio(c, glassOver(chain, room)));
          if (r < 3) fails.push(`${file} ${v} in ${ctx} = ${r.toFixed(2)}:1`);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('the End card (a page): its focus ring is ≥ 3:1 on the paper in every Atlas context', () => {
    const src = readFileSync(path.join(DIR, 'EndCard.tsx'), 'utf8');
    const vars = [...new Set([...src.matchAll(/focus-visible:ring-\[var\((--[\w-]+)\)\]/g)].map((m) => m[1]))];
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      for (const [ctx, chain] of Object.entries(CONTEXTS)) {
        const r = ratio(colour(chain, v), colour(chain, '--ds-reader-paper-back'));
        expect(r, `EndCard ${v} on the paper in ${ctx}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('no reader file spells a hue for the sheet toggle (the terracotta switch track is gone); the knob reads on the track', () => {
    const src = readFileSync(path.join(DIR, 'ReaderSettingsSheet.tsx'), 'utf8');
    expect(src).not.toMatch(/#D97757/i);
    const knob = /peer-checked:translate-x-5 peer-checked:bg-\[var\((--[\w-]+)\)\]/.exec(src)?.[1];
    const track = /transition-colors peer-checked:bg-\[var\((--[\w-]+)\)\]/.exec(src)?.[1];
    expect(knob && track).toBeTruthy();
    for (const [ctx, chain] of Object.entries(CONTEXTS)) expect(ratio(colour(chain, knob!), colour(chain, track!)), ctx).toBeGreaterThanOrEqual(3);
  });
});
