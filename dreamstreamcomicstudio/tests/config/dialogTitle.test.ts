// @vitest-environment node
/**
 * Dialog titles (Atlas wave 8, docs/design/atlas-skin.md "Wave 8 port"). Atlas's DialogTitle and
 * AlertDialogTitle default to 20 px semibold (`text-xl`) since the type-scale change; Comic Studio's
 * centred modal dialogs title with DIALOG_TITLE (or DIALOG_TITLE_FROM_SM where the dialog docks to the
 * bottom as a sheet on phones), while sheet and popover headers keep their 15 px.
 *
 * Every modal dialog in components/comicstudio/** (an element with `aria-modal`) is classified below:
 * CENTRED ones must put the recipe on their title, the rest say why they are not a centred dialog. A
 * new modal dialog fails here until it is classified.
 *
 * The rest of the app (DS-0, master plan §1.4): every other scanned file — components/** outside Comic
 * Studio, App.tsx and qa/** (tests, specs and live/** excluded; tests/config/classLists.ts
 * SCANNED_ROOTS) — counts its `aria-modal` surfaces as `unclassified-modal` until the file is added to
 * CENTRED (and titles with the recipe) or NOT_CENTRED (with the reason). Those counts RATCHET against
 * tests/config/baselines/dialogTitle.json: a file not listed must count 0 (a new modal anywhere is
 * classified first), above its entry fails, below fails until the entry is lowered
 * (`UPDATE_BASELINES=1 npx vitest run tests/config/dialogTitle.test.ts`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import {
  type Counts,
  type TokenHit,
  compareToBaseline,
  countTokens,
  listScannedFiles,
  PINNED_DIR,
  ratchet,
  readBaseline,
  REAL_TREE_TIMEOUT,
  scanTree
} from './classLists';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
const GUARD = 'dialogTitle';
const TEST_FILE = 'tests/config/dialogTitle.test.ts';
const classes = (s: string) => s.split(/\s+/).filter(Boolean);

/** Centred modal dialogs → the recipe their title carries. */
const CENTRED: Record<string, 'DIALOG_TITLE' | 'DIALOG_TITLE_FROM_SM'> = {
  // Centred at every width over the immersive reader.
  'components/comicstudio/immersive/ReaderShortcuts.tsx': 'DIALOG_TITLE',
  // Centred in its `dialog` (640–1023 px) and `wide` layouts; a bottom / side sheet on phones (16 px there).
  'components/comicstudio/share/ShareSheet.tsx': 'DIALOG_TITLE',
  // A bottom sheet below `sm`, centred from `sm` up (`items-end sm:items-center`).
  'components/comicstudio/timeline/ui.tsx': 'DIALOG_TITLE_FROM_SM',
  'components/comicstudio/models/ModelChangeConfirm.tsx': 'DIALOG_TITLE_FROM_SM',
  'components/comicstudio/models/lab/RunConfirmDialog.tsx': 'DIALOG_TITLE_FROM_SM',
  // Centred on the scrim at every width (DS-3).
  'components/modals/ProjectInfoModal.tsx': 'DIALOG_TITLE',
  // The image lightbox over Project info, a layer above it (Z.sheet).
  'components/modals/MasterGalleryModal.tsx': 'DIALOG_TITLE'
};
/** Modal (or modal-capable) surfaces that are not a centred dialog with a title, and why. */
const NOT_CENTRED: Record<string, string> = {
  'components/comicstudio/board/PageEditor.tsx': 'the full-screen page editor: its header is a toolbar, not a dialog title',
  'components/comicstudio/immersive/ImmersiveReader.tsx': 'the full-screen reader itself',
  'components/comicstudio/immersive/ReaderSettingsSheet.tsx': 'a non-modal settings sheet in the reader (aria-modal="false")',
  'components/comicstudio/conversation/PopSheet.tsx': 'popover / side sheet (15 px header)',
  'components/comicstudio/mobile/sheets/BottomSheet.tsx': 'bottom sheet (15 px header)',
  'components/comicstudio/mobile/sheets/SideSheet.tsx': 'side sheet (15 px header)'
};
const SHEET_HEADERS = ['components/comicstudio/mobile/sheets/BottomSheet.tsx', 'components/comicstudio/mobile/sheets/SideSheet.tsx', 'components/comicstudio/conversation/PopSheet.tsx'];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' ')).replace(/(^|[\s;{}(),])\/\/.*$/gm, (_m, lead: string) => lead);
}
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) files.push(full);
  }
  return files;
}
const read = (rel: string) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8'));
/** Files outside Comic Studio that render a modal surface (an `aria-modal` attribute). */
const appModalFiles = () => listScannedFiles({ exclude: [PINNED_DIR] }).filter((rel) => /\baria-modal\b/.test(read(rel)));
/** The className of every <h2> in a source (attribute text up to the tag's end). */
const h2ClassNames = (src: string) => [...src.matchAll(/<h2\b([^>]*?)className=(\{[^}]*\}|"[^"]*")/g)].map((m) => m[2]);

describe('dialog titles — the recipe', () => {
  it('DIALOG_TITLE is Atlas’s 20 px semibold dialog title in the body face, with no colour of its own', () => {
    // Bridge D2: Atlas's DialogTitle and SheetTitle never use the display face (only page and public titles do).
    expect(classes(design.DIALOG_TITLE)).toEqual(['text-xl', 'font-semibold', 'leading-7', 'tracking-normal']);
    expect(classes(design.DIALOG_TITLE)).not.toContain(design.FONT_DISPLAY);
    expect(design.DIALOG_TITLE).not.toMatch(/text-\[(?:var|#)|text-(?:white|black)\b/);
  });

  it('DIALOG_TITLE_FROM_SM is the same title from `sm` up (the face is the heading’s own)', () => {
    const fromSm = classes(design.DIALOG_TITLE_FROM_SM);
    expect(fromSm.every((c) => c.startsWith('sm:'))).toBe(true);
    expect(fromSm.map((c) => c.slice(3))).toEqual(classes(design.DIALOG_TITLE));
  });
});

describe('dialog titles — every modal dialog in Comic Studio is classified', () => {
  it('finds the modal dialogs and classifies each one', { timeout: REAL_TREE_TIMEOUT }, () => {
    const modal = listSourceFiles(path.join(ROOT, SCANNED_DIR))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((rel) => /\baria-modal\b/.test(read(rel)));
    expect(modal.length).toBeGreaterThanOrEqual(10);
    const unclassified = modal.filter((rel) => !(rel in CENTRED) && !(rel in NOT_CENTRED));
    expect(unclassified, 'a new modal dialog: add it to CENTRED (title with DIALOG_TITLE) or NOT_CENTRED (with the reason)').toEqual([]);
    // A file outside Comic Studio that a later package classifies is checked the same way.
    const everyModal = [...modal, ...appModalFiles()];
    for (const rel of [...Object.keys(CENTRED), ...Object.keys(NOT_CENTRED)]) expect(everyModal, `${rel} no longer renders a modal: drop it here`).toContain(rel);
  });

  it('centred dialogs title with DIALOG_TITLE (or DIALOG_TITLE_FROM_SM when they are a bottom sheet on phones)', () => {
    for (const [rel, recipe] of Object.entries(CENTRED)) {
      const titles = h2ClassNames(read(rel));
      const withRecipe = titles.filter((c) => new RegExp(String.raw`\b${recipe}\b`).test(c));
      expect(withRecipe.length, `${rel}: its dialog title carries ${recipe}`).toBe(1);
    }
  });

  it('sheet and popover headers keep their 15 px', () => {
    for (const rel of SHEET_HEADERS) {
      const titles = h2ClassNames(read(rel));
      expect(titles.length, rel).toBeGreaterThan(0);
      for (const c of titles) {
        expect(c, rel).toContain('text-[15px]');
        expect(c, rel).not.toMatch(/DIALOG_TITLE/);
      }
    }
  });
});

/**
 * The modal surfaces of one file that nothing classifies yet (`unclassified-modal`, one per
 * `aria-modal`, comments excluded); none for a file in CENTRED or NOT_CENTRED.
 */
export function unclassifiedModalHits(rel: string, source: string): TokenHit[] {
  if (rel in CENTRED || rel in NOT_CENTRED) return [];
  const lines = source.split('\n');
  return stripComments(source)
    .split('\n')
    .flatMap((text, i) => [...text.matchAll(/\baria-modal\b/g)].map(() => ({ line: i + 1, token: 'unclassified-modal', match: 'aria-modal', text: lines[i].trim() })));
}

describe('dialog titles — the rest of the app (ratchet)', () => {
  const { baseline } = readBaseline(GUARD);
  const PLANTED = 'components/__planted__/Fixture.tsx';

  it('counts each aria-modal surface of an unclassified file, and none once the file is classified', () => {
    const src = '<div role="dialog" aria-modal="true">\n  {/* aria-modal: centred */}\n  <h2 className="text-lg">Share</h2>\n</div>\n';
    expect(unclassifiedModalHits(PLANTED, src).map((h) => [h.line, h.token])).toEqual([[1, 'unclassified-modal']]);
    expect(unclassifiedModalHits('components/comicstudio/share/ShareSheet.tsx', src)).toEqual([]);
    expect(unclassifiedModalHits('components/comicstudio/mobile/sheets/BottomSheet.tsx', src)).toEqual([]);
  });

  it('a new modal dialog in any scanned file fails until it is classified', () => {
    const src = 'export const Fixture = () => <div role="dialog" aria-modal="true"><h2>Rename</h2></div>;\n';
    const actual: Counts = { ...baseline, [PLANTED]: countTokens(unclassifiedModalHits(PLANTED, src)) };
    expect(compareToBaseline(actual, baseline, TEST_FILE)).toEqual({
      over: [`${PLANTED}  unclassified-modal: 1, baseline 0 — a file or token the baseline does not list must count 0`],
      under: []
    });
  });

  it('a second modal in a baselined file fails; classifying a file fails until its entry is dropped', () => {
    const [rel, tokens] = Object.entries(baseline)[0];
    const n = tokens['unclassified-modal'];
    expect(compareToBaseline({ ...baseline, [rel]: { 'unclassified-modal': n + 1 } }, baseline, TEST_FILE).over).toEqual([
      `${rel}  unclassified-modal: ${n + 1}, baseline ${n} — 1 new use`
    ]);
    const { [rel]: _classified, ...rest } = baseline;
    expect(compareToBaseline(rest, baseline, TEST_FILE).under).toEqual([
      `${rel}  unclassified-modal: 0, baseline ${n} — the count fell: lower the baseline to 0 (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`
    ]);
  });

  it('components/** outside Comic Studio, App.tsx and qa/** match tests/config/baselines/dialogTitle.json exactly', { timeout: REAL_TREE_TIMEOUT }, () => {
    const files = listScannedFiles({ exclude: [PINNED_DIR] });
    expect(files.length).toBeGreaterThan(200);
    const { counts, stale } = scanTree(files, unclassifiedModalHits);
    expect(stale).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(over, 'A new modal dialog: classify it in CENTRED (title with DIALOG_TITLE / DIALOG_TITLE_FROM_SM) or NOT_CENTRED (with the reason).').toEqual([]);
    expect(under, 'A modal was classified or removed: lower the baseline so the gain is kept.').toEqual([]);
  });
});

/**
 * Radix dialogs (DS-1c wave note 14). Radix sets aria-modal at runtime, so the classification above never sees a
 * components/ds Dialog or AlertDialog: here every `<DialogContent` / `<AlertDialogContent` element (comments excluded)
 * must render a `<DialogTitle` or `<AlertDialogTitle` before it closes. The primitives put DIALOG_TITLE on that title
 * themselves (components/ds/Dialog.test.tsx), so a caller only has to render one.
 */
export function radixDialogsWithoutTitle(source: string): number[] {
  const src = stripComments(source);
  const missing: number[] = [];
  for (const open of src.matchAll(/<(Alert)?DialogContent\b/g)) {
    const start = open.index ?? 0;
    const tag = open[1] ? 'AlertDialogContent' : 'DialogContent';
    const end = src.indexOf(`</${tag}>`, start);
    const body = end < 0 ? src.slice(start, src.indexOf('>', start) + 1) : src.slice(start, end);
    if (!/<(?:Alert)?DialogTitle\b/.test(body)) missing.push(src.slice(0, start).split('\n').length);
  }
  return missing;
}

describe('dialog titles — Radix dialogs render a title (DS-1c #14)', () => {
  it('finds a DialogContent or AlertDialogContent without a title, and passes one that has it', () => {
    expect(radixDialogsWithoutTitle('<DialogContent>\n  <DialogHeader><DialogTitle>Rename</DialogTitle></DialogHeader>\n</DialogContent>')).toEqual([]);
    expect(radixDialogsWithoutTitle('<AlertDialogContent><AlertDialogTitle>Delete?</AlertDialogTitle></AlertDialogContent>')).toEqual([]);
    expect(radixDialogsWithoutTitle('<p/>\n<DialogContent>\n  <p>No title</p>\n</DialogContent>')).toEqual([2]);
    expect(radixDialogsWithoutTitle('<AlertDialogContent><p>x</p></AlertDialogContent>')).toEqual([1]);
    expect(radixDialogsWithoutTitle('<DialogContent aria-label="x" />')).toEqual([1]);
    // A usage note in a comment is no dialog.
    expect(radixDialogsWithoutTitle('/* <DialogContent></DialogContent> */')).toEqual([]);
  });

  it('every scanned file (components/**, App.tsx, qa/**) titles its Radix dialogs', { timeout: REAL_TREE_TIMEOUT }, () => {
    const files = listScannedFiles();
    const rendering = files.filter((rel) => /<(?:Alert)?DialogContent\b/.test(read(rel)));
    // The DS-1c overlay scene renders both kinds, so the rule has something to check.
    expect(rendering).toContain('qa/app/scenes/ds-overlays.tsx');
    const missing = rendering.flatMap((rel) => radixDialogsWithoutTitle(readFileSync(path.join(ROOT, rel), 'utf8')).map((line) => `${rel}:${line}`));
    expect(missing, 'Render a DialogTitle / AlertDialogTitle inside every DialogContent / AlertDialogContent.').toEqual([]);
  });
});
