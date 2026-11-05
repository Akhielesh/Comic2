// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { type Rgba, type Rule, ratio, topLevelSplit } from '../../tests/config/cssTokens';
import { type ThemeName, ATLAS_SKIN_DARK, ATLAS_SKIN_LIGHT, color, declaration, liveStylesheets, onto, read, STYLES_DIR } from './skinTokens';
import path from 'node:path';

/**
 * Stream Studio under the Atlas skin (atlas-skin.css): WCAG 2.x contrast of text on the surfaces it
 * sits on, in BOTH themes. The skin-aware twin of usageContrast.unit.test.ts (which reads only the
 * cream studio's hex tokens):
 *   1. every token pair the app paints text with — ink, muted, faint, the readable accent and status
 *      inks on every page surface, the status inks on their own tints, the button / toast / badge
 *      fills and their labels — at 4.5:1 (body / label text);
 *   2. a scan of EVERY rule in every Stream Studio stylesheet that colours text with a token: on the
 *      background the same rule sets, or else on the page surfaces (page, panel, field) — 4.5:1, or
 *      3:1 for large text (≥ 24 px, or ≥ 18.66 px bold);
 *   3. the usage UI's small text (usageContrast's list) through the skin's tokens;
 *   4. non-text marks (focus outline, status dots and bars) at 3:1.
 * Disabled controls and placeholders are exempt (WCAG 1.4.3), as in the main app's tokenContrast.
 */

const THEMES: ThemeName[] = ['light', 'dark'];
const AA = 4.5;
const LARGE = 3;

const SURFACES = ['--bg', '--panel', '--panel-2', '--panel-3', '--hover', '--sidebar', '--chip'] as const;
const TEXT = ['--text', '--muted', '--faint', '--accent-ink', '--accent', '--green', '--amber', '--blue', '--live'] as const;

const c = (v: string, t: ThemeName) => color(v, t);
/** A surface, opaque: a translucent one (the nav pill) is painted over the rail. */
const surface = (v: string, t: ThemeName, under = '--panel') => onto(c(v, t), c(under, t));
const measure = (fg: Rgba, bg: Rgba) => ratio(onto(fg, bg), bg);

describe('Atlas skin tokens: text on every surface (AA 4.5:1)', () => {
  it('both skin blocks are there and define the core tokens', () => {
    for (const m of [ATLAS_SKIN_LIGHT, ATLAS_SKIN_DARK]) for (const k of ['--bg', '--panel', '--text', '--muted', '--faint', '--accent', '--live']) expect(m.has(k), k).toBe(true);
  });

  for (const t of THEMES) {
    for (const fg of TEXT) {
      it(`${fg} on every surface (${t})`, () => {
        for (const bg of SURFACES) {
          expect(measure(c(fg, t), surface(bg, t)), `${fg} on ${bg} (${t})`).toBeGreaterThanOrEqual(AA);
        }
        // The active nav row (a translucent pill over the rail) carries ink or muted labels.
        if (fg === '--text' || fg === '--muted') {
          expect(measure(c(fg, t), surface('--nav-active', t, '--sidebar')), `${fg} on the active nav row (${t})`).toBeGreaterThanOrEqual(AA);
        }
      });
    }

    it(`status inks on their own tint (pills, banners) (${t})`, () => {
      for (const hue of ['green', 'amber', 'blue', 'live']) {
        const tint = surface(`--${hue}-wash`, t);
        expect(measure(c(`--${hue}`, t), tint), `--${hue} on --${hue}-wash (${t})`).toBeGreaterThanOrEqual(AA);
        expect(measure(c('--text', t), tint), `--text on --${hue}-wash (${t})`).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`labels on fills: buttons, toasts, badges, the red LIVE fill (${t})`, () => {
      const pairs: [string, string][] = [
        ['--on-accent', '--accent'], // solid button, pills, tab badge
        ['--on-accent', '--accent-2'], // solid button hover
        ['--bg', '--text'], // the toast, the phone tab bar's active pill
        ['#ffffff', '--live-fill'], // Go live, REC, End, missed-call badge, LIVE over video
        ['#ffffff', '--green-solid'], // done steps, ready checks
        ['#ffffff', '--amber-solid'],
        ['--accent-ink', '--accent-wash'], // the selected nav row, accent pills
        // Avatar initials on each of the three neutral tones (Avatar's data-tone).
        ['--avatar-ink', '--avatar-0'],
        ['--avatar-ink', '--avatar-1'],
        ['--avatar-ink', '--avatar-2'],
      ];
      for (const [fg, bg] of pairs) expect(measure(c(fg, t), surface(bg, t)), `${fg} on ${bg} (${t})`).toBeGreaterThanOrEqual(AA);
    });

    it(`non-text marks reach 3:1: focus outline, field edges, status dots and bars (${t})`, () => {
      for (const bg of ['--bg', '--panel', '--panel-2']) {
        for (const mark of ['--accent', '--control-border', '--green', '--amber', '--live']) {
          expect(measure(c(mark, t), surface(bg, t)), `${mark} on ${bg} (${t})`).toBeGreaterThanOrEqual(LARGE);
        }
      }
    });
  }
});

/* ------------------------------------------------------------------------------------------------ */

interface Finding {
  where: string;
  theme: ThemeName;
  ratio: number;
  need: number;
}

const isTokenColour = (v: string) => /var\(--/.test(v) && !/currentcolor|inherit/i.test(v);
/** Placeholders and disabled controls (WCAG 1.4.3), and dots: a status dot's colour is its fill
 *  (currentColor for its pulse), not text. */
const exempt = (selector: string) => /::?placeholder|:disabled|\[disabled\]|\[aria-disabled|[\w-]*dot\b(?![\w-])/.test(selector);
const px = (v: string | null) => (v && /^([\d.]+)px$/.exec(v) ? Number(/^([\d.]+)px$/.exec(v)![1]) : null);

/** The background a rule paints its own box with, when it's a resolvable colour. */
function ownBackground(body: string, t: ThemeName): Rgba | null | 'unknown' {
  const v = declaration(body, 'background-color') ?? declaration(body, 'background');
  if (!v) return null;
  try {
    return color(v, t);
  } catch {
    return 'unknown'; // a gradient or image: what's under the text isn't knowable from here
  }
}

/**
 * The elements whose text colour atlas-skin.css sets itself (`html[data-ds-skin="atlas"] X` or
 * `… :is(X, Y)`): the base rule for them is not what paints under the skin, so the scan skips it
 * (the skin's own rule is scanned, or is a literal stage ink).
 */
function skinColourOverrides(sheets: { file: string; rules: Rule[] }[]): Set<string> {
  const out = new Set<string>();
  const skin = sheets.find((x) => x.file === 'styles/atlas-skin.css')!;
  for (const r of skin.rules) {
    if (!declaration(r.body, 'color')) continue;
    for (const sel of topLevelSplit(r.selector)) {
      const rest = sel.replace(/^html\[data-ds-skin="atlas"\](\[data-theme="\w+"\])?\s*/, '');
      const is = /^:is\(([\s\S]*)\)$/.exec(rest);
      for (const one of is ? topLevelSplit(is[1]) : [rest]) out.add(one.replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}

describe('every Stream Studio rule that colours text with a token (skin on, both themes)', () => {
  const sheets = liveStylesheets();
  const overridden = skinColourOverrides(sheets);

  it('reads every stylesheet, the skin included', () => {
    const names = sheets.map((s) => s.file);
    for (const f of ['styles/app.css', 'styles/features.css', 'styles/screens.css', 'styles/studio.css', 'styles/atlas-skin.css', 'views/account/account.css']) expect(names).toContain(f);
  });

  for (const t of THEMES) {
    it(`reaches AA (${t})`, () => {
      const findings: Finding[] = [];
      let checked = 0;
      for (const { file, rules } of sheets) {
        for (const r of rules) {
          if (r.parents.some((p) => /prefers-contrast|forced-colors/.test(p))) continue;
          const fgValue = declaration(r.body, 'color');
          if (!fgValue || !isTokenColour(fgValue) || exempt(r.selector)) continue;
          if (file !== 'styles/atlas-skin.css' && topLevelSplit(r.selector).every((x) => overridden.has(x.replace(/\s+/g, ' ').trim()))) continue;
          let fg: Rgba;
          try {
            fg = color(fgValue, t);
          } catch {
            continue; // a token this rule scopes itself (resolved where it's set)
          }
          const size = px(declaration(r.body, 'font-size'));
          const weight = Number(declaration(r.body, 'font-weight') ?? 400);
          const need = size != null && (size >= 24 || (size >= 18.66 && weight >= 700)) ? LARGE : AA;
          const own = ownBackground(r.body, t);
          if (own === 'unknown') continue;
          const backgrounds = own ? [onto(own, color('--panel', t))] : ['--bg', '--panel', '--panel-2'].map((s) => color(s, t));
          for (const bg of backgrounds) {
            checked += 1;
            const got = measure(fg, bg);
            if (got < need) findings.push({ where: `${file} ${r.selector} { color: ${fgValue} }`, theme: t, ratio: Number(got.toFixed(2)), need });
          }
        }
      }
      expect(checked).toBeGreaterThan(300);
      expect(findings).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------------------------------------ */

describe('the usage UI’s small text, through the skin (usageContrast.unit.test.ts’s list)', () => {
  const usageCss = read(path.join(STYLES_DIR, 'usage.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const colorOf = (selector: string): string | null => {
    let found: string | null = null;
    for (const m of usageCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue;
      const v = declaration(m[2], 'color');
      if (v) found = v;
    }
    return found;
  };
  const SMALL_TEXT = [
    '.usage-allow.is-warn .usage-pct',
    '.usage-allow.is-full .usage-pct',
    '.usage-empty',
    '.usage-free .usage-group-title',
    '.cost-line',
    '.cost-line.servers',
    '.usage-card .faint',
  ];
  for (const sel of SMALL_TEXT) {
    it(`${sel}: at least 4.5:1 on page, panel and field, light and dark`, () => {
      const v = colorOf(sel);
      expect(v, `${sel} sets a colour`).toBeTruthy();
      for (const t of THEMES) for (const bg of ['--bg', '--panel', '--panel-2']) expect(measure(c(v!, t), c(bg, t)), `${sel} on ${bg} (${t})`).toBeGreaterThanOrEqual(AA);
    });
  }
});
