import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTES, BULL, BEAR, NEUTRAL } from './kit/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Enforced "calm studio" quality gate for chat widgets.
//
// CLAUDE.md spells out the house style for rich-output components, but prose
// drifts: every session re-interprets it by feel. This test turns the three
// unambiguous "NEVER" rules into a build-breaking check so the design system
// can't quietly rot. See docs/COMPONENT_QUALITY.md for the full standard and
// the do/don't examples behind each rule.
//
// Scope: every *.tsx under components/chat/artifacts/ (the widgets + the kit).
// What is intentionally NOT policed here: Tailwind's named palette classes
// (text-emerald-600, bg-amber-50, …) — many cards use those as deliberate
// semantic accents, so banning them would be wrong. We only forbid the things
// CLAUDE.md calls invalid or off-system.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = dirname(fileURLToPath(import.meta.url));

/** All widget source files (excludes tests). */
function widgetFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...widgetFiles(full));
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line and block comments, preserving line numbers, so the "don't do
 *  this" examples documented in comments (e.g. kit/Surface.tsx) don't register
 *  as real violations. URLs (https://…) are left intact. */
function stripComments(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*[^]*?\*\//g, ''); // closed block comments on one line
    const open = line.indexOf('/*');
    if (open !== -1) { line = line.slice(0, open); inBlock = true; }
    line = line.replace(/(^|[^:])\/\/.*$/, '$1'); // line comment, but keep ://
    out.push(line);
  }
  return out;
}

// The sanctioned color literals: the theme-invariant brand accent (used as the
// `bg-[#D97757]/10` tint form CLAUDE.md explicitly allows) plus every color in
// the kit's own palette (theme.ts). Anything else hardcoded in a class is drift.
const SANCTIONED_HEX = new Set(
  [
    '#D97757', // --ds-accent, theme-invariant per CLAUDE.md
    BULL, BEAR, NEUTRAL,
    ...Object.values(PALETTES).flatMap((p) => [p.accent, ...p.series])
  ].map((h) => h.toLowerCase().replace('#', ''))
);

const COMIC = /border-2\s+border-black|shadow-comic|font-display|font-comic/;
const VAR_OPACITY = /var\(--ds-[\w-]+\)\]\/\d/;
const HEX = /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|divide|placeholder|caret|accent)(?:-offset)?-\[#([0-9a-fA-F]{3,8})\]/g;

interface Finding { where: string; detail: string; }

function scan() {
  const comic: Finding[] = [];
  const varOpacity: Finding[] = [];
  const offPalette: Finding[] = [];

  for (const file of widgetFiles(ROOT)) {
    const rel = relative(process.cwd(), file);
    const lines = stripComments(readFileSync(file, 'utf8'));
    lines.forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      if (COMIC.test(line)) comic.push({ where: at, detail: line.trim().slice(0, 120) });
      if (VAR_OPACITY.test(line)) varOpacity.push({ where: at, detail: line.trim().slice(0, 120) });
      for (const m of line.matchAll(HEX)) {
        if (!SANCTIONED_HEX.has(m[1].toLowerCase())) offPalette.push({ where: at, detail: m[0] });
      }
    });
  }
  return { comic, varOpacity, offPalette };
}

const fmt = (f: Finding[]) => f.map((v) => `  • ${v.where}  ${v.detail}`).join('\n');

describe('chat widgets follow the calm-studio quality standard', () => {
  const result = scan();

  it('use no legacy comic styles (border-2 border-black / shadow-comic / font-display / font-comic)', () => {
    expect(
      result.comic,
      `Legacy comic styles are banned in chat widgets — use the Surface kit + --ds tokens instead.\n${fmt(result.comic)}\nSee docs/COMPONENT_QUALITY.md`
    ).toEqual([]);
  });

  it('never put a Tailwind opacity modifier on a var() color (invalid CSS)', () => {
    expect(
      result.varOpacity,
      `bg-[var(--ds-…)]/NN is invalid CSS. Use a solid token, or color-mix(in srgb, var(--ds-…) NN%, transparent).\n${fmt(result.varOpacity)}\nSee docs/COMPONENT_QUALITY.md`
    ).toEqual([]);
  });

  it('hardcode no off-palette hex colors in class names (use --ds tokens, the accent, or a kit palette color)', () => {
    expect(
      result.offPalette,
      `Hardcoded off-palette hex in a class. Use a --ds-* token, the #D97757 accent, or a color from kit/theme.ts PALETTES.\n${fmt(result.offPalette)}\nSee docs/COMPONENT_QUALITY.md`
    ).toEqual([]);
  });
});
