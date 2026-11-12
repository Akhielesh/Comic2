// @vitest-environment node
/**
 * DS-3 (master plan §1.3, redesign M3): the comics-host first impression is on Atlas. Every file DS-3 owns, and
 * its QA scenes, reads at 0 on each design-system guard's own detector (tests/config/classLists.ts), so the
 * ratchet baselines for these files can drop to 0 (tests/config/baselines/*.json; the integration lowers them):
 *   - legacyKit: border-black, shadow-comic, font-comic, Tailwind font-display (Bangers), brand-* colours;
 *   - terracotta: #D97757 / #c2643f;
 *   - zLadder: raw z-index classes (stacking goes through Z);
 *   - statusInk: raw hue text classes (status reads through TONE_TEXT / STATUS_INK);
 *   - overline: hand-rolled small uppercase eyebrows (OVERLINE);
 *   - localCx: a local class joiner (cn);
 * plus no hard `text-white` on an accent fill (ON_ACCENT_TEXT), and the two centred modal dialogs carry
 * `aria-modal` and title with DIALOG_TITLE on exactly one <h2> (what tests/config/dialogTitle.test.ts's CENTRED
 * classification checks once the integration lists them there).
 * The patterns are the guards' own (legacyKitGuard.test.ts LEGACY_KIT, terracottaGuard.test.ts TERRACOTTA,
 * zLadderGuard.test.ts Z_CLASS, statusInkGuard.test.ts RAW_STATUS_INK): those files register test suites, so they
 * are restated here rather than imported.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, VARIANT, findHandRolledOverlines, findInLiterals, withoutVariant } from '../tests/config/classLists';

const OWNED = [
  'components/AuthPage.tsx',
  'components/RedeemInvite.tsx',
  'components/modals/ProjectInfoModal.tsx',
  'components/modals/MasterGalleryModal.tsx',
  'components/SharedViewer.tsx',
  'components/comicshost/ComicsLanding.tsx'
];
const SCENES = ['qa/app/scenes/auth.tsx', 'qa/app/scenes/shared.tsx', 'qa/app/scenes/landing.tsx'];
const MODALS = ['components/modals/ProjectInfoModal.tsx', 'components/modals/MasterGalleryModal.tsx'];

const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' ')).replace(/(^|[\s;{}(),])\/\/.*$/gm, (_m, lead: string) => lead);

const OPACITY = String.raw`(?:\/(?:\d+|\[[^\]\s]+\]))?`;
const LEGACY_KIT = new RegExp(
  String.raw`(?<![\w-])${VARIANT}(?:border-(?:[xytrbl]-)?black${OPACITY}|shadow-comic(?:-[a-z]+)?|font-comic|[a-z]+(?:-[a-z]+)*-brand-(?:yellow|blue|red|black)${OPACITY}|font-display(?!\s*:))(?![\w-])`,
  'g'
);
const TERRACOTTA = /#(?:d97757|c2643f)(?:[0-9a-f]{2})?(?![0-9a-f])/gi;
const Z_CLASS = new RegExp(String.raw`(?<![\w-])${VARIANT}-?z-(?:\d+|\[[^\]\s]+\])(?![\w-])`, 'g');
const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const RAW_STATUS_INK = new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?text-(?:${HUES})-\d{2,3}(?:\/\d+|\/\[[^\]]+\])?(?![\w-])`, 'g');
const TEXT_WHITE = new RegExp(String.raw`(?<![\w-])${VARIANT}text-white(?:\/\d+)?(?![\w-])`, 'g');

const hits = (rel: string, pattern: RegExp) => findInLiterals(read(rel), pattern, (m) => withoutVariant(m), rel).map((h) => `${rel}:${h.line} ${h.token}`);

describe('DS-3 surfaces read 0 on every design-system guard', () => {
  for (const rel of [...OWNED, ...SCENES]) {
    it(`${rel}: no legacy kit, terracotta, raw z-index, raw hue ink, hand-rolled eyebrow, local cx or hard white`, () => {
      expect(hits(rel, LEGACY_KIT), 'legacy kit').toEqual([]);
      expect(hits(rel, TERRACOTTA), 'terracotta').toEqual([]);
      expect(hits(rel, Z_CLASS), 'raw z-index (use Z)').toEqual([]);
      expect(hits(rel, TEXT_WHITE), 'text-white (use ON_ACCENT_TEXT on a fill)').toEqual([]);
      expect([...stripComments(read(rel)).matchAll(RAW_STATUS_INK)].map((m) => m[0]), 'raw hue text (use TONE_TEXT / STATUS_INK)').toEqual([]);
      expect(findHandRolledOverlines(read(rel), rel), 'hand-rolled eyebrow (use OVERLINE)').toEqual([]);
      expect(stripComments(read(rel)), 'a local cx (use cn)').not.toMatch(/\b(?:const|let|function)\s+cx\b/);
    });
  }
});

describe('DS-3 modal dialogs are classified centred dialogs', () => {
  for (const rel of MODALS) {
    it(`${rel}: aria-modal, and DIALOG_TITLE on its one <h2>`, () => {
      const src = stripComments(read(rel));
      expect(src).toMatch(/\baria-modal\b/);
      expect(src).toMatch(/role="dialog"/);
      const h2s = [...src.matchAll(/<h2\b([^>]*?)className=(\{[^}]*\}|"[^"]*")/g)].map((m) => m[2]);
      expect(h2s).toHaveLength(1);
      expect(h2s[0]).toMatch(/\bDIALOG_TITLE\b/);
      expect(src).not.toMatch(/\bDIALOG_TITLE_FROM_SM\b/);
    });
  }
});
