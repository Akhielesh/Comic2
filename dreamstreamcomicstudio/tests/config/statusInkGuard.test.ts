// @vitest-environment node
/**
 * Status ink guard (Atlas wave 8, docs/design/atlas-skin.md "Wave 8 port"; mirrors Atlas's
 * tests/lib/status-ink-guard.test.ts).
 *
 * A raw Tailwind hue used as text or icon colour (`text-amber-700 dark:text-amber-300`,
 * `text-red-600`, `text-emerald-…`) ignores the skin: it is the same hue in the calm-studio theme,
 * Atlas light and Atlas dark, and Atlas's own amber on white or red on black is far under 4.5:1.
 * Status text (and the icon beside it) in Comic Studio reads the readable tone tokens through the
 * studioDesign recipes instead — TONE_TEXT / STATUS_INK (`--ds-success|warning|danger|info-text`),
 * TONE_CHIP / STATUS_CHIP_TONE / STATUS_SURFACE / STATUS_EDGE for its tint and edge — which
 * tests/config/tokenContrast.test.ts holds to ≥ 4.5:1 on the page, cards, the soft glass, overlays,
 * highlighted menu rows and the tone's own tint, in every theme and skin.
 *
 * Fills, borders and tints (bg-red-600 under white text, a status dot, border-amber-500/30) are not
 * text ink and are not scanned (as in Atlas). This fails on any raw chromatic Tailwind text colour
 * (any variant prefix, any opacity) in components/comicstudio/** outside the allowlist below.
 * Content colours — lettering, balloon and caption swatches, user-chosen colours, comic art, colour
 * pickers, brand illustration — are inline styles or hex values, never Tailwind hue classes, so they
 * need no entry; one that ever becomes a hue class is allowlisted here with its reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
const SOURCE_FILE = /\.(tsx?|jsx?|mjs)$/;

/**
 * Deliberate exceptions, keyed by app-relative path; the value is the exact number of raw hue text
 * classes the file may contain. Keep an entry only where the colour is not status ink on a page
 * surface — content, or a mark drawn over content.
 */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  'components/comicstudio/board/PageEditor.tsx': {
    count: 1,
    // The "Marked area" chip's icon is the colour of the marquee the person draws OVER THE ART to mark
    // a region for a redraw (the red-500 box, label and handle in the same file): an annotation colour
    // chosen to stand out on any artwork, echoed by its chip — not a status.
    reason: 'marked-area icon echoes the red marquee drawn over the comic art (annotation colour over content)'
  },
  'components/comicstudio/timeline/MediaBin.tsx': {
    count: 1,
    // The starred glyph sits on the fixed black scrim over a media thumbnail (white label beside it in
    // both themes). The readable tokens are tuned for page surfaces — in light they are dark ink that
    // vanishes on the scrim. aria-hidden; the tile's label and the preview's "Starred" badge carry it.
    reason: 'favourite star on the fixed black scrim over a thumbnail (content overlay), aria-hidden'
  }
};

const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
/** A raw hue text colour: any variant prefix (`dark:`, `hover:`, `group-hover:`, `[&_svg]:`), any step, any opacity. */
const RAW_STATUS_INK = new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?text-(?:${HUES})-\d{2,3}(?:\/\d+|\/\[[^\]]+\])?(?![\w-])`, 'g');

/** Comments blanked out (line numbers kept), exactly as Atlas's guard strips them. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, (_match, lead: string) => lead);
}

export function findRawStatusInk(source: string): Array<{ line: number; token: string }> {
  const hits: Array<{ line: number; token: string }> = [];
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      for (const match of text.matchAll(RAW_STATUS_INK)) hits.push({ line: index + 1, token: match[0] });
    });
  return hits;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (SOURCE_FILE.test(entry)) files.push(full);
  }
  return files;
}

describe('status ink guard (components/comicstudio/**)', () => {
  it('recognises raw hue ink and leaves the tokens, fills, borders, tints and neutrals alone', () => {
    const flagged = [
      'text-amber-700',
      'dark:text-amber-300',
      'text-red-600',
      'hover:text-red-700',
      'group-hover:text-emerald-600',
      'text-sky-700/80',
      'text-rose-500/[0.9]',
      '[&_svg]:text-orange-500',
      'text-emerald-800'
    ];
    for (const token of flagged) {
      expect(findRawStatusInk(`<p className="text-sm ${token}">x</p>`).map((h) => h.token), token).toEqual([token]);
    }
    expect(findRawStatusInk("cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'").map((h) => h.token)).toEqual(['text-amber-700', 'dark:text-amber-300']);

    const allowed = [
      'text-[var(--ds-warning-text)]',
      'text-[var(--ds-danger-text)] hover:bg-[var(--ds-status-error-tint)]',
      'bg-red-600 text-white hover:bg-red-700',
      'border-amber-500/30 bg-amber-500/[0.08]',
      'bg-emerald-500 ring-emerald-500/25',
      'fill-amber-300 stroke-red-500',
      'text-[#3d3a33]',
      'text-slate-500 text-gray-700 text-neutral-400 text-zinc-300 text-stone-600',
      'decoration-red-500',
      'context-red-500-text'
    ];
    for (const classes of allowed) expect(findRawStatusInk(`<p className="${classes}">x</p>`), classes).toEqual([]);

    // Comments that explain the rule are not class names.
    expect(findRawStatusInk('// never text-red-600: use TONE_TEXT.danger\nconst a = 1;')).toEqual([]);
    expect(findRawStatusInk('{/* not text-amber-700 */}')).toEqual([]);
  });

  it('finds no raw hue text or icon colour in components/comicstudio/** outside the allowlist', () => {
    const offenders: string[] = [];
    const counts = new Map<string, number>();
    const files = listSourceFiles(path.join(ROOT, SCANNED_DIR));
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const hits = findRawStatusInk(readFileSync(file, 'utf8'));
      if (hits.length === 0) continue;
      counts.set(rel, hits.length);
      if (ALLOWLIST[rel]?.count === hits.length) continue;
      for (const hit of hits) offenders.push(`${rel}:${hit.line}  ${hit.token}`);
    }
    expect(
      offenders,
      'Status text and icons read TONE_TEXT / STATUS_INK (components/chat/studioDesign.ts) and their tint TONE_CHIP / STATUS_SURFACE; a raw hue ignores the skin and is unreadable in at least one theme.'
    ).toEqual([]);
    // An allowlist entry that no longer matches anything is stale: remove it.
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      expect(counts.get(file), `${file} is allowlisted for ${entry.count} raw hue text classes (${entry.reason})`).toBe(entry.count);
    }
  });
});
