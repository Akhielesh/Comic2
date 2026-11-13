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
 *
 * A status MARK or a chart ramp step used as text (`text-[var(--ds-warning)]`, `text-ds-chart-seq-3`) fails everywhere
 * an app-wide guard looks, with no allowlist (the last describe below; as on the Atlas design branch).
 *
 * The rest of the app (DS-0, master plan §1.4): the same three checks run over every other scanned file
 * — components/** outside Comic Studio, App.tsx and qa/** (tests, specs and live/** excluded;
 * tests/config/classLists.ts SCANNED_ROOTS) — as a RATCHET against tests/config/baselines/statusInk.json,
 * per file and per token (each raw hue class as written, `stacked-inks`, `white-on-light-fill`): a file
 * or token not listed must count 0, above its entry fails, below fails until the entry is lowered
 * (`UPDATE_BASELINES=1 npx vitest run tests/config/statusInkGuard.test.ts`). The one allowlist below
 * serves both: Comic Studio's pins, and any data-viz or content exemption elsewhere.
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import {
  type Counts,
  type TokenHit,
  classListsOf,
  compareToBaseline,
  countTokens,
  findCompetingInks,
  listScannedFiles,
  matchPinned,
  PINNED_DIR,
  ratchet,
  readBaseline,
  REAL_TREE_TIMEOUT,
  scanTree,
  tempTree,
  textColours,
  VARIANT
} from './classLists';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
const GUARD = 'statusInk';
const TEST_FILE = 'tests/config/statusInkGuard.test.ts';
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
/** A class list that puts white text or an icon on a light warm fill. */
const whiteOnLightFill = (classes: string) => {
  const tokens = classes.split(/[\s'"`]+/);
  return tokens.includes('text-white') && tokens.some((t) => LIGHT_WARM_FILL.test(t));
};

const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
/**
 * A raw hue text colour: any variant prefix (`dark:`, `hover:`, `group-hover:`, `group-hover/btn:`,
 * `[&_svg]:`), any step, any opacity.
 */
const RAW_STATUS_INK = new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?text-(?:${HUES})-\d{2,3}(?:\/\d+|\/\[[^\]]+\])?(?![\w-])`, 'g');

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

/** One Comic Studio file's class lists that put white on a light warm fill (`rel:line`), read in the file's own language. */
export function whiteOnFillOffenders(rel: string, source: string): string[] {
  return classListsOf(source, rel)
    .filter((list) => whiteOnLightFill(list.classes))
    .map((list) => `${rel}:${list.line}`);
}

/** One Comic Studio file's class lists that stack two text colours (`rel:line  colours  snippet`), read in its own language. */
export function stackedInkOffenders(rel: string, source: string): string[] {
  return findCompetingInks(source, design, rel).map((c) => `${rel}:${c.line}  ${c.colours.join(' vs ')}  ${c.snippet}`);
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
      'group-hover/btn:text-red-500',
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

  it('finds no raw hue text or icon colour in components/comicstudio/** outside the allowlist', { timeout: REAL_TREE_TIMEOUT }, () => {
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
    for (const file of Object.keys(ALLOWLIST).filter((f) => f.startsWith(`${SCANNED_DIR}/`))) {
      expect(seen.has(file), `${file} is allowlisted but no longer exists`).toBe(true);
    }
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

  it('the Comic Studio scans read a .ts file in full: a class list after a generic helper is checked', () => {
    const rel = 'components/comicstudio/x.ts';
    const src = "const list = <T>(v: unknown): T[] => [] as T[];\nexport const A = 'rounded bg-amber-400 text-white';\nexport const B = cx('text-[var(--ds-muted)]', on && 'text-[var(--ds-ink)]');\n";
    expect(whiteOnFillOffenders(rel, src)).toEqual([`${rel}:2`]);
    expect(stackedInkOffenders(rel, src)).toEqual([`${rel}:3  text-[var(--ds-ink)] vs text-[var(--ds-muted)]  cx('text-[var(--ds-muted)]', on && 'text-[var(--ds-ink)]')`]);
  });

  it('no white text or icon on a light amber or yellow fill (white on amber-500 is 2.15:1; status words read TONE_CHIP / TONE_CHIP_ON_ART)', { timeout: REAL_TREE_TIMEOUT }, () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(ROOT, SCANNED_DIR))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      offenders.push(...whiteOnFillOffenders(rel, readFileSync(file, 'utf8')));
    }
    expect(offenders).toEqual([]);
  });

  it('no class list in components/comicstudio/** stacks two text colours (the applied one would be an accident of stylesheet order)', { timeout: REAL_TREE_TIMEOUT }, () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(ROOT, SCANNED_DIR))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      offenders.push(...stackedInkOffenders(rel, readFileSync(file, 'utf8')));
    }
    expect(
      offenders,
      'cx() joins, it does not merge: take the ink out of the shared constant and CHOOSE it (danger ? TONE_TEXT.danger : \'text-[var(--ds-ink)]\'), as GhostButton does.'
    ).toEqual([]);
  });
});

/**
 * Every status-ink use in one source as ratchet hits: each raw hue class as written (variant and
 * opacity kept, as the pins read it), each class list that stacks two text colours (`stacked-inks`) and
 * each that puts white on a light warm fill (`white-on-light-fill`). A scan passes the file's path as
 * `fileName`, so a `.ts` file is parsed as TypeScript (classLists.ts scriptKindOf).
 */
export function statusInkHits(source: string, fileName = 'file.tsx'): TokenHit[] {
  const lines = source.split('\n');
  const at = (line: number) => (lines[line - 1] ?? '').trim();
  return [
    ...findRawStatusInk(source).map((h) => ({ line: h.line, token: h.token, match: h.token, text: h.text })),
    ...findCompetingInks(source, design, fileName).map((c) => ({ line: c.line, token: 'stacked-inks', match: c.colours.join(' vs '), text: at(c.line) })),
    ...classListsOf(source, fileName)
      .filter((l) => whiteOnLightFill(l.classes))
      .map((l) => ({ line: l.line, token: 'white-on-light-fill', match: 'text-white', text: at(l.line) }))
  ];
}

/** The ratchet's scan of an app tree outside Comic Studio (the real-tree test runs exactly this), each file in its own language. */
export function statusInkScan(root = ROOT) {
  const files = listScannedFiles({ root, exclude: [PINNED_DIR] });
  return { files, ...scanTree(files, (rel, source) => statusInkHits(source, rel), ALLOWLIST, root) };
}

describe('status ink guard — the rest of the app (ratchet)', () => {
  const { baseline } = readBaseline(GUARD);
  const PLANTED = 'components/__planted__/Fixture.tsx';

  it('names each kind of use with its own token', () => {
    const src =
      `import { TONE_TEXT } from './chat/studioDesign';\n` +
      `const BTN = 'px-2 text-[var(--ds-ink)]';\n` +
      `export const A = () => <><p className="text-sm dark:text-amber-300 text-red-600/80">x</p>\n` +
      `<b className={cx(BTN, TONE_TEXT.danger)}>y</b>\n` +
      `<i className="bg-amber-400 text-white">z</i></>;\n`;
    expect(statusInkHits(src).map((h) => [h.line, h.token])).toEqual([
      [3, 'dark:text-amber-300'],
      [3, 'text-red-600/80'],
      [4, 'stacked-inks'],
      [5, 'white-on-light-fill']
    ]);
  });

  it('reads a .ts file as TypeScript: a generic arrow does not hide the class lists after it', () => {
    const src =
      `const f = <T>(x: T) => x;\n` +
      `export const A = cx('text-[var(--ds-muted)]', on && 'text-[var(--ds-ink)]');\n` +
      `export const B = 'bg-amber-400 text-white';\n` +
      `export const C = 'text-red-600';\n`;
    expect(statusInkHits(src, 'components/x.ts').map((h) => [h.line, h.token])).toEqual([
      [4, 'text-red-600'],
      [2, 'stacked-inks'],
      [3, 'white-on-light-fill']
    ]);
  });

  it('a raw hue, a stacked ink or white on amber planted in any scanned file fails, naming the file and the token', () => {
    const planted: Array<[string, string]> = [
      ['<p className="text-emerald-600">Saved</p>', 'text-emerald-600'],
      ["<p className={cx('text-[var(--ds-muted)]', on && 'text-[var(--ds-ink)]')}>x</p>", 'stacked-inks'],
      ['<span className="bg-yellow-300 text-white">New</span>', 'white-on-light-fill']
    ];
    for (const [jsx, token] of planted) {
      const src = `export const Fixture = () => ${jsx};\n`;
      const actual: Counts = { ...baseline, [PLANTED]: countTokens(statusInkHits(src)) };
      expect(compareToBaseline(actual, baseline, TEST_FILE), jsx).toEqual({
        over: [`${PLANTED}  ${token}: 1, baseline 0 — a file or token the baseline does not list must count 0`],
        under: []
      });
    }
  });

  it('above a file’s baseline fails; below it fails until the baseline is lowered', () => {
    const [rel, tokens] = Object.entries(baseline)[0];
    const [token, n] = Object.entries(tokens)[0];
    expect(compareToBaseline({ ...baseline, [rel]: { ...tokens, [token]: n + 1 } }, baseline, TEST_FILE).over).toEqual([
      `${rel}  ${token}: ${n + 1}, baseline ${n} — 1 new use`
    ]);
    expect(compareToBaseline({ ...baseline, [rel]: { ...tokens, [token]: n - 1 } }, baseline, TEST_FILE).under).toEqual([
      `${rel}  ${token}: ${n - 1}, baseline ${n} — the count fell: lower the baseline to ${n - 1} (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`
    ]);
  });

  it('the scan reads a .ts file in full: a use after a generic helper counts', () => {
    const root = tempTree({
      'components/api.ts': "const list = <T>(v: unknown): T[] => [] as T[];\nexport const A = 'rounded bg-amber-400 text-white';\n",
      'components/comicstudio/skipped.ts': "export const A = 'rounded bg-amber-400 text-white';\n"
    });
    try {
      expect(statusInkScan(root).counts).toEqual({ 'components/api.ts': { 'white-on-light-fill': 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('components/** outside Comic Studio, App.tsx and qa/** match tests/config/baselines/statusInk.json exactly', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { files, counts, stale } = statusInkScan();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.startsWith(`${SCANNED_DIR}/`))).toBe(false);
    // Comic Studio's pins are checked by the exact-line tests above; only the rest is stale here.
    expect(stale.filter((s) => !s.startsWith(`${SCANNED_DIR}/`))).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(
      over,
      'New status ink: read TONE_TEXT / STATUS_INK and their tint TONE_CHIP / STATUS_SURFACE (components/chat/studioDesign.ts); CHOOSE a tone against the neutral ink, never stack it; never white on a light amber.'
    ).toEqual([]);
    expect(under, 'Raw status ink was removed: lower the baseline so it cannot come back.').toEqual([]);
  });
});

/**
 * A MARK used as text (as on the Atlas design branch's guard): the status colours (`--ds-success`, `--ds-warning`,
 * `--ds-danger`, `--ds-info`, `--ds-danger-mark`) and the chart ramp steps (`--ds-chart-seq-N`, `--ds-chart-div-N`)
 * are tuned for dots, edges, bars and cells, not for words: Atlas's warning on white is 2.15:1, and a ramp's light
 * end is under 2:1 on the page. Words and the icon beside them read the `-text` inks (TONE_TEXT / STATUS_INK).
 * What it reads, for those tokens:
 *   - the text and placeholder utilities: `text-[var(--ds-…)]` with or without the `color:` hint, a fallback or
 *     Tailwind's `_` spaces, Tailwind 3's bare `text-[--ds-…]` shorthand (a fallback allowed), a `color-mix()` that
 *     starts from a mark, the named colour `text-ds-…`, and the same for `placeholder-`, with any variant prefix
 *     (bracketed ones with `=` included) and any opacity;
 *   - the arbitrary property `[color:var(--ds-…)]`;
 *   - a `color:` declaration in an inline style object or a CSS file (`background-color`, `border-color` and the other
 *     `-color` properties are fills and stay allowed);
 *   - the `fill` of an SVG `<text>` or `<tspan>` (a chart's label is words);
 *   - a class built at run time from a mark's name (`text-ds-chart-seq-${i}`, `text-[var(--ds-${tone})]`): a built text
 *     colour must end in the `-text` ink (`text-ds-${tone}-text`).
 * It reads one line at a time, so an SVG `<text>` whose `fill` sits on a later line than the tag, and a colour picked
 * from a variable (`color: tone.mark`), are not seen. It looks wherever an app-wide guard looks (components/**
 * including Comic Studio, App.tsx, qa/**) plus the CSS files (index.css, styles/**, components/**). The `-text` tokens
 * and every fill (bg-, border-, fill-, stroke-, ring-, …) stay allowed. There is no allowlist and no baseline: today's
 * count is 0 and it stays 0.
 */
const MARK_TOKENS = String.raw`(?:success|warning|danger|info|danger-mark|chart-(?:seq|div)-\d+)`;
/** `var(--ds-MARK)`, Tailwind's `_` spaces allowed around the name, with an optional fallback. */
const MARK_VAR = String.raw`var\(_*--ds-${MARK_TOKENS}_*(?:,[^\]]*)?\)`;
/** A variant chain (`dark:`, `group-hover/row:`, `[&_svg]:`, `aria-[invalid=true]:`) and the `!` modifier. */
const MARK_VARIANT = String.raw`(?:(?:[\w\-&:()>.*/@]|\[[^\]\s]*\])+:)?!?`;
const MARK_OPACITY = String.raw`(?:\/\d+(?:\.\d+)?|\/\[[^\]]+\])?`;
const MARK_AS_TEXT = new RegExp(
  String.raw`(?<![\w-])${MARK_VARIANT}(?:text|placeholder)-(?:\[(?:color:)?(?:${MARK_VAR}|--ds-${MARK_TOKENS}(?:,[^\]]*)?|color-mix\([^\]]*?var\(_*--ds-${MARK_TOKENS}_*[,)][^\]]*)_*\]|ds-${MARK_TOKENS})${MARK_OPACITY}(?![\w-])`,
  'g'
);
/** The arbitrary property `[color:var(--ds-MARK)]`. */
const MARK_AS_COLOR_PROPERTY = new RegExp(String.raw`(?<![\w-])${MARK_VARIANT}\[color:${MARK_VAR}_*\]`, 'g');
/** A `color:` declaration (a style object or CSS) reading a mark; not `background-color:`, not a utility's `[color:`. */
const MARK_AS_COLOR_DECLARATION = new RegExp(
  String.raw`(?<![\w\-[])color\s*:\s*(['"\u0060]?)var\(\s*--ds-${MARK_TOKENS}\s*(?:,[^;'"\u0060}\n]*)?\)\1`,
  'g'
);
/** The fill of an SVG `<text>` / `<tspan>` reading a mark (the token reported is the fill attribute). */
const MARK_AS_SVG_TEXT = new RegExp(
  String.raw`<(?:text|tspan)\b[^>]*?\b(?<token>fill=\{?\s*['"\u0060]var\(\s*--ds-${MARK_TOKENS}\s*(?:,[^)]*)?\)['"\u0060]?)`,
  'g'
);
/** A text or placeholder colour built at run time from a `--ds-` name, unless the built name ends in `-text`. */
const BUILT_MARK_AS_TEXT = new RegExp(
  String.raw`(?<![\w-])${MARK_VARIANT}(?:text|placeholder)-(?:ds-|\[(?:color:)?var\(_*--ds-)[\w-]*\$\{[^}]*\}(?!-text(?![\w-]))[^\s'"\u0060]*`,
  'g'
);
const MARK_PATTERNS = [MARK_AS_TEXT, MARK_AS_COLOR_PROPERTY, MARK_AS_COLOR_DECLARATION, MARK_AS_SVG_TEXT, BUILT_MARK_AS_TEXT];

/** Every status mark or ramp step used as a text colour in one source (`line  token`), comments ignored. */
export function findMarkAsText(source: string): Array<{ line: number; token: string }> {
  const hits: Array<{ line: number; token: string; at: number }> = [];
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      for (const pattern of MARK_PATTERNS) {
        for (const match of text.matchAll(pattern)) hits.push({ line: index + 1, token: match.groups?.token ?? match[0], at: match.index ?? 0 });
      }
    });
  return hits.sort((a, b) => a.line - b.line || a.at - b.at).map(({ line, token }) => ({ line, token }));
}

/** The CSS files the scan also reads: index.css and every stylesheet under styles/ and components/. */
function listCssFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const full = path.join(root, rel);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(full)) if (entry !== 'node_modules' && !entry.startsWith('.')) walk(`${rel}/${entry}`);
    } else if (rel.endsWith('.css')) out.push(rel);
  };
  for (const r of ['index.css', 'styles', 'components']) walk(r);
  return out.sort();
}

/** The scan the real-tree test runs: every app-wide scanned file under `root`, Comic Studio included, and the CSS. */
export function markAsTextScan(root = ROOT): { files: string[]; offenders: string[] } {
  const files = [...listScannedFiles({ root }), ...listCssFiles(root)];
  const offenders: string[] = [];
  for (const rel of files) {
    for (const h of findMarkAsText(readFileSync(path.join(root, rel), 'utf8'))) offenders.push(`${rel}:${h.line}  ${h.token}`);
  }
  return { files, offenders };
}

describe('status ink guard — a status mark or a chart ramp step is never a text colour', () => {
  it('recognises the spellings it promises: text and placeholder utilities (var(), color:, fallbacks, _ spaces, the bare [--var] form, a color-mix from a mark, the named colour, any variant, any opacity), [color:…], a style or CSS color:, an SVG label fill, a built class', () => {
    const flagged = [
      'text-[var(--ds-success)]',
      'text-[var(--ds-warning)]',
      'text-[var(--ds-danger)]',
      'text-[var(--ds-info)]',
      'text-[var(--ds-danger-mark)]',
      'text-[color:var(--ds-warning)]',
      'dark:text-[var(--ds-success)]',
      'group-hover/btn:text-[var(--ds-danger)]',
      '[&_svg]:text-[color:var(--ds-danger-mark)]',
      'hover:!text-[var(--ds-info)]',
      'text-ds-warning',
      'text-ds-success/80',
      'md:text-ds-danger-mark/[0.9]',
      'text-[var(--ds-chart-seq-1)]',
      'text-[var(--ds-chart-seq-6)]',
      'text-[color:var(--ds-chart-div-4)]',
      'text-[var(--ds-chart-div-7)]',
      'text-ds-chart-seq-3',
      'focus-visible:text-ds-chart-div-1/60',
      // A var() with a fallback, and Tailwind 3's bare [--var] shorthand (with or without color:).
      'text-[var(--ds-warning,#000)]',
      'text-[color:var(--ds-danger-mark,_currentColor)]/70',
      'text-[--ds-success]',
      'sm:text-[color:--ds-chart-div-3]',
      'md:hover:text-[--ds-chart-seq-2]/[0.5]',
      'text-[--ds-warning,#000]',
      // Tailwind's `_` spaces inside the brackets, a mix that starts from a mark, the placeholder colour.
      'text-[var(--ds-warning_)]',
      'text-[var(_--ds-warning)]',
      'text-[var(--ds-warning)_]',
      'text-[color-mix(in_srgb,var(--ds-warning)_80%,black)]',
      'placeholder-[var(--ds-warning)]',
      'focus:placeholder-ds-danger/60',
      // Variants with `=` in a bracket, and a decimal opacity, reported whole.
      'aria-[invalid=true]:text-ds-danger',
      'data-[state=open]:text-[var(--ds-info)]',
      'text-ds-warning/7.5',
      // The arbitrary colour property.
      '[color:var(--ds-warning)]',
      'hover:[color:var(--ds-chart-seq-4)]'
    ];
    for (const token of flagged) {
      expect(findMarkAsText(`<p className="text-sm ${token}">x</p>`).map((h) => h.token), token).toEqual([token]);
    }
    // Outside a class list: an inline style or a CSS colour declaration, an SVG label's fill, and a class built at
    // run time from a mark's name (a built name must end in the -text ink).
    const elsewhere: Array<[string, string]> = [
      [`<p style={{ color: 'var(--ds-warning)' }}>x</p>`, `color: 'var(--ds-warning)'`],
      [`const s = { fontWeight: 600, color: "var(--ds-chart-div-2)" };`, `color: "var(--ds-chart-div-2)"`],
      ['.low { color: var(--ds-danger-mark); }', 'color: var(--ds-danger-mark)'],
      ['<text x={4} y={8} fill="var(--ds-chart-seq-3)">12</text>', 'fill="var(--ds-chart-seq-3)"'],
      [`<tspan fill={'var(--ds-success)'}>up</tspan>`, `fill={'var(--ds-success)'`],
      ['const c = `tabular-nums text-ds-chart-seq-${i}`;', 'text-ds-chart-seq-${i}'],
      ['const c = `text-[var(--ds-${tone})]`;', 'text-[var(--ds-${tone})]'],
      ['const c = `hover:text-ds-${tone}`;', 'hover:text-ds-${tone}']
    ];
    for (const [source, token] of elsewhere) expect(findMarkAsText(source).map((h) => h.token), source).toEqual([token]);
    const allowed = [
      'text-[var(--ds-success-text)] text-[var(--ds-warning-text)] text-[var(--ds-danger-text)] text-[var(--ds-info-text)]',
      'text-[color:var(--ds-danger-text)] text-ds-warning-text text-ds-success-text/80',
      'bg-[var(--ds-success)] border-[var(--ds-warning)] fill-[var(--ds-danger-mark)] stroke-[var(--ds-info)]',
      'bg-ds-warning/10 border-ds-danger-mark ring-[var(--ds-danger)] decoration-[var(--ds-warning)]',
      'bg-[var(--ds-chart-seq-3)] fill-[var(--ds-chart-div-2)] stroke-ds-chart-seq-6',
      'text-[var(--ds-chart-1)] text-[var(--ds-ink)] text-[var(--ds-on-danger)] text-[var(--ds-status-error-tint)]',
      'text-[var(--ds-hue-1-text)] text-[var(--ds-spark-text)]',
      'text-[--ds-success-text] text-[color:--ds-warning-text] text-[var(--ds-danger-text,#b00)] bg-[--ds-warning]',
      'bg-[color:var(--ds-warning)] border-[color:var(--ds-danger)] text-[color-mix(in_srgb,var(--ds-warning-text)_80%,black)]',
      'placeholder-[var(--ds-muted)] placeholder-ds-warning-text text-[var(--ds-ink,var(--ds-warning))]'
    ];
    for (const classes of allowed) expect(findMarkAsText(`<p className="${classes}">x</p>`), classes).toEqual([]);
    const fine = [
      `<p style={{ color: 'var(--ds-warning-text)', backgroundColor: 'var(--ds-warning)' }}>x</p>`,
      '.dot { background-color: var(--ds-success); border-color: var(--ds-danger); outline-color: var(--ds-info); }',
      '.x { --tw-ring-color: var(--ds-warning); color: var(--ds-success-text); }',
      '<rect fill="var(--ds-chart-seq-3)" /><path stroke="var(--ds-warning)" /><circle fill={"var(--ds-danger-mark)"} />',
      '<text fill="var(--ds-muted)">12</text>',
      'const c = `text-ds-${tone}-text text-[var(--ds-${tone}-text)] bg-ds-chart-seq-${i} border-[var(--ds-${tone})]`;'
    ];
    for (const source of fine) expect(findMarkAsText(source), source).toEqual([]);
    // A comment that explains the rule is not a class name.
    expect(findMarkAsText('// never text-[var(--ds-warning)]: use TONE_TEXT.warning\nconst a = 1;')).toEqual([]);
  });

  it('bites: a planted offender in a scanned file of a temp tree is reported with its file, line and token', () => {
    const root = tempTree({
      'components/__planted__/Fixture.tsx': `export const A = () => <p className="text-sm dark:text-[color:var(--ds-warning)]/80">Low</p>;\n`,
      'components/comicstudio/__planted__/Chart.tsx': `export const B = 'tabular-nums text-ds-chart-seq-2';\n`,
      'components/__planted__/Fine.tsx': `export const C = 'bg-[var(--ds-warning)] text-[var(--ds-warning-text)]';\n`,
      'components/__planted__/Fixture.test.tsx': `export const D = 'text-[var(--ds-danger)]';\n`,
      'components/__planted__/Axis.tsx': `export const E = () => <svg><text x={0} y={9} fill="var(--ds-chart-div-6)">9</text></svg>;\n`,
      'styles/__planted__.css': `.a { background-color: var(--ds-warning); }\n.b { color: var(--ds-warning); }\n`
    });
    try {
      expect(markAsTextScan(root).offenders).toEqual([
        'components/__planted__/Axis.tsx:1  fill="var(--ds-chart-div-6)"',
        'components/__planted__/Fixture.tsx:1  dark:text-[color:var(--ds-warning)]/80',
        'components/comicstudio/__planted__/Chart.tsx:1  text-ds-chart-seq-2',
        'styles/__planted__.css:2  color: var(--ds-warning)'
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds none in components/** (Comic Studio included), App.tsx and qa/**', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { files, offenders } = markAsTextScan();
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => f.startsWith('components/comicstudio/'))).toBe(true);
    expect(files).toContain('components/chat/studioDesign.ts');
    expect(files).toEqual(expect.arrayContaining(['index.css', 'styles/ds-motion.css', 'components/comicstudio/immersive/readerDesigns.css']));
    expect(
      offenders,
      'A status colour or a chart ramp step is a mark (a dot, an edge, a bar), not a text colour: words and the icon beside them read TONE_TEXT / STATUS_INK (the -text inks).'
    ).toEqual([]);
  });
});
