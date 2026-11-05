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
 * highlighted menu rows and the tone's own tint, in every theme and skin. Those surfaces are not art: a
 * pill drawn over an image uses TONE_CHIP_ON_ART, the tint mixed into the opaque raised surface, which
 * the same test measures, so it reads the same over any thumbnail.
 *
 * Fills, borders and tints (bg-red-600 under white text, a status dot, border-amber-500/30) are not
 * text ink and are not scanned (as in Atlas). This fails on any raw chromatic Tailwind text colour
 * (any variant prefix, any opacity) in components/comicstudio/** outside the allowlist below, whose
 * entries pin the exact uses they permit (token and source line), not a count.
 *
 * A token only reads when it is the colour that APPLIES: `cx(BASE, TONE_TEXT.danger)` with a BASE that
 * already says `text-[var(--ds-ink)]` renders plain ink (cx joins, Tailwind emits `--ds-danger-text`
 * before `--ds-ink`, so ink wins). The second check fails on any class list in which two different
 * unvariant text colours can apply together (tests/config/classLists.ts): a tone or an emphasis is
 * CHOSEN against the neutral ink (`danger ? TONE_TEXT.danger : 'text-[var(--ds-ink)]'`), never stacked.
 * The one fill check: white text or an icon on a light amber, yellow or lime fill fails (white on
 * amber-500 is 2.15:1); darker fills under white (red-600 4.8:1, amber-700 5.0:1) pass and stay deferred.
 * Content colours — lettering, balloon and caption swatches, user-chosen colours, comic art, colour
 * pickers, brand illustration — are inline styles or hex values, never Tailwind hue classes, so they
 * need no entry; one that ever becomes a hue class is allowlisted here with its reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import { classListsOf, findCompetingInks, matchPinned, textColours } from './classLists';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
const SOURCE_FILE = /\.(tsx?|jsx?|mjs)$/;

/**
 * Deliberate exceptions, keyed by app-relative path; each entry pins the raw uses it permits (the token
 * and its trimmed source line), so a different raw use cannot take an allowed one's place. Keep an
 * entry only where the colour is not status ink on a page surface — content, or a mark drawn over
 * content.
 */
const ALLOWLIST: Record<string, { uses: Array<{ token: string; line: string }>; reason: string }> = {
  'components/comicstudio/board/PageEditor.tsx': {
    uses: [{ token: 'text-red-500', line: '<SquareDashed className="h-3 w-3 shrink-0 text-red-500" aria-hidden />' }],
    // The "Marked area" chip's icon is the colour of the marquee the person draws OVER THE ART to mark
    // a region for a redraw (the red-500 box, label and handle in the same file): an annotation colour
    // chosen to stand out on any artwork, echoed by its chip — not a status.
    reason: 'marked-area icon echoes the red marquee drawn over the comic art (annotation colour over content)'
  },
  'components/comicstudio/timeline/MediaBin.tsx': {
    uses: [{ token: 'text-amber-300', line: '{item.starred && <Star className="h-3 w-3 shrink-0 fill-current text-amber-300" aria-hidden />}' }],
    // The starred glyph sits on the fixed black scrim over a media thumbnail (white label beside it in
    // both themes). The readable tokens are tuned for page surfaces — in light they are dark ink that
    // vanishes on the scrim. aria-hidden; the tile's label and the preview's "Starred" badge carry it.
    reason: 'favourite star on the fixed black scrim over a thumbnail (content overlay), aria-hidden'
  }
};
const useKey = (u: { token: string; line: string }) => `${u.token}  @  ${u.line}`;

/** A light warm fill (amber / yellow / lime 50–500, any opacity) that white text and icons fail on. */
const LIGHT_WARM_FILL = /^bg-(?:amber|yellow|lime)-(?:50|[1-5]00)(?:\/[\d.[\]]+)?$/;

const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
/** A raw hue text colour: any variant prefix (`dark:`, `hover:`, `group-hover:`, `[&_svg]:`), any step, any opacity. */
const RAW_STATUS_INK = new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?text-(?:${HUES})-\d{2,3}(?:\/\d+|\/\[[^\]]+\])?(?![\w-])`, 'g');

/** Comments blanked out (line numbers kept), exactly as Atlas's guard strips them. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, (_match, lead: string) => lead);
}

export function findRawStatusInk(source: string): Array<{ line: number; token: string; text: string }> {
  const hits: Array<{ line: number; token: string; text: string }> = [];
  const original = source.split('\n');
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      for (const match of text.matchAll(RAW_STATUS_INK)) hits.push({ line: index + 1, token: match[0], text: original[index].trim() });
    });
  return hits;
}

/** The raw uses in one file the allowlist does not permit (`rel:line  token`), and its stale pinned uses. */
export function statusInkOffenders(rel: string, source: string): { offenders: string[]; stale: string[] } {
  const hits = findRawStatusInk(source);
  const { extra, missing } = matchPinned(
    hits.map((h) => useKey({ token: h.token, line: h.text })),
    ALLOWLIST[rel]?.uses.map(useKey)
  );
  const offenders = hits.filter((h) => extra.includes(useKey({ token: h.token, line: h.text }))).map((h) => `${rel}:${h.line}  ${h.token}`);
  return { offenders, stale: missing };
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

  it('an allowlist entry permits its pinned uses only: a different raw use cannot take an allowed one\'s place', () => {
    const rel = 'components/comicstudio/board/PageEditor.tsx';
    const source = readFileSync(path.join(ROOT, rel), 'utf8');
    expect(statusInkOffenders(rel, source)).toEqual({ offenders: [], stale: [] });
    // The marked-area icon moves onto TONE_TEXT.danger and, in the same edit, the off-panel speaker
    // warning goes back to a raw amber: still exactly one hit in the file (the count-based allowlist
    // passed this), now an offender plus a stale entry.
    const allowed = ALLOWLIST[rel].uses[0];
    const warning = "<p className={cx('px-1 text-[11px]', TONE_TEXT.warning)}>";
    expect(source).toContain(allowed.line);
    expect(source).toContain(warning);
    const swapped = source
      .replace(allowed.line, '<SquareDashed className={cx(\'h-3 w-3 shrink-0\', TONE_TEXT.danger)} aria-hidden />')
      .replace(warning, '<p className="px-1 text-[11px] text-amber-700">');
    expect(findRawStatusInk(swapped)).toHaveLength(1);
    const { offenders, stale } = statusInkOffenders(rel, swapped);
    expect(offenders).toEqual([expect.stringMatching(/PageEditor\.tsx:\d+ {2}text-amber-700$/)]);
    expect(stale).toEqual([useKey(allowed)]);
  });

  it('finds no raw hue text or icon colour in components/comicstudio/** outside the allowlist', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    const files = listSourceFiles(path.join(ROOT, SCANNED_DIR));
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      seen.add(rel);
      const result = statusInkOffenders(rel, readFileSync(file, 'utf8'));
      offenders.push(...result.offenders);
      // An allowlisted use that no longer matches anything is stale: remove it (or re-pin it).
      expect(result.stale, `${rel}: allowlisted uses no longer present (${ALLOWLIST[rel]?.reason})`).toEqual([]);
    }
    expect(
      offenders,
      'Status text and icons read TONE_TEXT / STATUS_INK (components/chat/studioDesign.ts) and their tint TONE_CHIP / STATUS_SURFACE; a raw hue ignores the skin and is unreadable in at least one theme.'
    ).toEqual([]);
    for (const file of Object.keys(ALLOWLIST)) expect(seen.has(file), `${file} is allowlisted but no longer exists`).toBe(true);
  });

  it('recognises a tone or an emphasis stacked on another text colour, and passes one chosen against it', () => {
    const SRC = (body: string) =>
      `import { TONE_TEXT, TONE_CHIP, STATUS_INK, SEGMENTED_ACTIVE, OVERLINE } from '../../chat/studioDesign';\n` +
      `const BTN = 'inline-flex h-8 px-2 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]';\n` +
      `const SHAPE = 'inline-flex h-8 px-2 text-[12px] font-medium hover:bg-[var(--ds-hover)]';\n` +
      `const STATUS_CLASS: Record<string, string> = { warn: TONE_CHIP.warning, ok: TONE_CHIP.success };\n${body}`;
    const flagged: Array<[string, string[]]> = [
      // The three destructive buttons of the review (base ink + danger): the danger ink lost.
      ['<button className={cx(BTN, TONE_TEXT.danger)}>Delete</button>', ['text-[var(--ds-danger-text)]', 'text-[var(--ds-ink)]']],
      ["<button className={cx(BTN, danger && TONE_TEXT.danger)}>Delete</button>", ['text-[var(--ds-danger-text)]', 'text-[var(--ds-ink)]']],
      ["<button className={cx(BTN, danger ? TONE_TEXT.danger : 'text-[var(--ds-ink)]')}>Delete</button>", ['text-[var(--ds-danger-text)]', 'text-[var(--ds-ink)]']],
      ['<span className={`${BTN} ${TONE_TEXT.info}`}>i</span>', ['text-[var(--ds-info-text)]', 'text-[var(--ds-ink)]']],
      ['<span className={cx(OVERLINE, STATUS_INK[state])}>x</span>', ['text-[var(--ds-danger-text)]', 'text-[var(--ds-ink)]', 'text-[var(--ds-muted)]', 'text-[var(--ds-success-text)]', 'text-[var(--ds-warning-text)]']],
      ['<span className={cx(BTN, STATUS_CLASS[s])}>x</span>', ['text-[var(--ds-ink)]', 'text-[var(--ds-success-text)]', 'text-[var(--ds-warning-text)]']],
      ["<p className=\"text-[var(--ds-ink)] text-[var(--ds-danger-text)]\">x</p>", ['text-[var(--ds-danger-text)]', 'text-[var(--ds-ink)]']],
      // An emphasis on a muted base never shows (muted is emitted after ink), nor the accent (before it).
      ["<p className={cx('text-[11.5px] text-[var(--ds-muted)]', busy && 'text-[var(--ds-ink)]')}>x</p>", ['text-[var(--ds-ink)]', 'text-[var(--ds-muted)]']],
      ["<b className={cx('text-[var(--ds-muted)]', on && SEGMENTED_ACTIVE)}>x</b>", ['text-[var(--ds-ink)]', 'text-[var(--ds-muted)]']],
      ["const LINE = 'block text-[12px] text-[var(--ds-muted)]';\n<b className={cx(LINE, 'text-[var(--ds-accent)]')}>x</b>", ['text-[var(--ds-accent)]', 'text-[var(--ds-muted)]']]
    ];
    for (const [body, colours] of flagged) {
      const conflicts = findCompetingInks(SRC(body), design);
      expect(conflicts, body).toHaveLength(1);
      expect(conflicts[0].colours, body).toEqual(colours);
    }

    const allowed = [
      // Chosen against the neutral ink (GhostButton, ClipMenu, ContextMenuSheet; the fixed buttons).
      "<button className={cx(SHAPE, danger ? TONE_TEXT.danger : 'text-[var(--ds-ink)]')}>Delete</button>",
      '<button className={cx(SHAPE, TONE_TEXT.danger)}>Delete</button>',
      // Mutually exclusive tones (the timeline Badge).
      "<span className={cx('px-1.5 text-[10.5px]', tone === 'warn' && TONE_CHIP.warning, tone === 'danger' && TONE_CHIP.danger, tone === 'default' && 'text-[var(--ds-muted)]')}>x</span>",
      '<span className={cx(SHAPE, STATUS_CLASS[s])}>x</span>',
      // State variants are not stacking; sizes, alignment and arbitrary lengths are not colours.
      "<p className={cx(BTN, 'hover:text-[var(--ds-accent)] dark:text-[var(--ds-muted)] text-[11px] text-sm/6 text-center text-[length:var(--ds-text-base)]')}>x</p>",
      '<p className={`text-[12px] ${TONE_TEXT.warning}`}>x</p>',
      "<p className={cx('text-[12px]', TONE_TEXT.warning, className)}>x</p>"
    ];
    for (const body of allowed) expect(findCompetingInks(SRC(body), design), body).toEqual([]);
    expect(textColours('text-white/80 text-[#D97757] text-[color:var(--x)] text-[13px]/5 text-xs')).toEqual(['text-white/80', 'text-[#D97757]', 'text-[color:var(--x)]']);
  });

  it('no white text or icon on a light amber or yellow fill (white on amber-500 is 2.15:1; status words read TONE_CHIP / TONE_CHIP_ON_ART)', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(ROOT, SCANNED_DIR))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const list of classListsOf(readFileSync(file, 'utf8'))) {
        const tokens = list.classes.split(/[\s'"`]+/);
        if (tokens.includes('text-white') && tokens.some((t) => LIGHT_WARM_FILL.test(t))) offenders.push(`${rel}:${list.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no class list in components/comicstudio/** stacks two text colours (the applied one would be an accident of stylesheet order)', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(ROOT, SCANNED_DIR))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const c of findCompetingInks(readFileSync(file, 'utf8'), design)) offenders.push(`${rel}:${c.line}  ${c.colours.join(' vs ')}  ${c.snippet}`);
    }
    expect(
      offenders,
      'cx() joins, it does not merge: take the ink out of the shared constant and CHOOSE it (danger ? TONE_TEXT.danger : \'text-[var(--ds-ink)]\'), as GhostButton does.'
    ).toEqual([]);
  });
});
