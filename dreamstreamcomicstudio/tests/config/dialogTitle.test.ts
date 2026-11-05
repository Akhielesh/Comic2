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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
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
  'components/comicstudio/models/lab/RunConfirmDialog.tsx': 'DIALOG_TITLE_FROM_SM'
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
/** The className of every <h2> in a source (attribute text up to the tag's end). */
const h2ClassNames = (src: string) => [...src.matchAll(/<h2\b([^>]*?)className=(\{[^}]*\}|"[^"]*")/g)].map((m) => m[2]);

describe('dialog titles — the recipe', () => {
  it('DIALOG_TITLE is Atlas’s 20 px semibold dialog title in the display face, with no colour of its own', () => {
    expect(classes(design.DIALOG_TITLE)).toEqual(['text-xl', 'font-semibold', 'leading-7', 'tracking-normal', design.FONT_DISPLAY]);
    expect(design.DIALOG_TITLE).not.toMatch(/text-\[(?:var|#)|text-(?:white|black)\b/);
  });

  it('DIALOG_TITLE_FROM_SM is the same title from `sm` up (the face is the heading’s own)', () => {
    const fromSm = classes(design.DIALOG_TITLE_FROM_SM);
    expect(fromSm.every((c) => c.startsWith('sm:'))).toBe(true);
    expect(fromSm.map((c) => c.slice(3))).toEqual(classes(design.DIALOG_TITLE).filter((c) => c !== design.FONT_DISPLAY));
  });
});

describe('dialog titles — every modal dialog in Comic Studio is classified', () => {
  it('finds the modal dialogs and classifies each one', () => {
    const modal = listSourceFiles(path.join(ROOT, SCANNED_DIR))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((rel) => /\baria-modal\b/.test(read(rel)));
    expect(modal.length).toBeGreaterThanOrEqual(10);
    const unclassified = modal.filter((rel) => !(rel in CENTRED) && !(rel in NOT_CENTRED));
    expect(unclassified, 'a new modal dialog: add it to CENTRED (title with DIALOG_TITLE) or NOT_CENTRED (with the reason)').toEqual([]);
    for (const rel of [...Object.keys(CENTRED), ...Object.keys(NOT_CENTRED)]) expect(modal, `${rel} no longer renders a modal: drop it here`).toContain(rel);
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
