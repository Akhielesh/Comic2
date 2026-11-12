// @vitest-environment node
/**
 * The comics home (the landing, its header and the shared header, lockup and legal line it is built from, the studio
 * replica, the comic page specimen, the mark), the views a visitor reaches from it in the same chrome (sign-in, the
 * access request and the tester invite, the Library, Privacy, Terms) and their QA scenes read 0 on every design-system guard's own detector
 * (tests/config/classLists.ts), so none of them needs a ratchet baseline entry (tests/config/baselines/*.json):
 *   - legacyKit: border-black, shadow-comic, font-comic, Tailwind font-display (Bangers), brand-* colours;
 *   - terracotta: #D97757 / #c2643f (and the old mark's #c2603f);
 *   - zLadder: raw z-index classes (stacking goes through Z);
 *   - statusInk: raw hue text classes (status reads through TONE_TEXT / STATUS_INK);
 *   - overline: hand-rolled small uppercase eyebrows (OVERLINE / OVERLINE_DISPLAY);
 *   - localCx: a local class joiner (cn);
 * plus no hard `text-white`, no `min-[…]:` / `max-[…]:` arbitrary breakpoint (this Tailwind config's raw screens
 * disable them, so they compile to nothing), no spelled duration, delay or z, no hex in a class, and no timer.
 * The patterns restate the guards' own (legacyKitGuard, terracottaGuard, zLadderGuard, statusInkGuard): those files
 * register test suites, so they are restated here rather than imported.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, VARIANT, findHandRolledOverlines, findInLiterals, withoutVariant } from '../../tests/config/classLists';

/** The comics home and the shared pieces it is built from: tokens only, and no timer or request of their own. */
const OWNED = [
  'components/comicshost/ComicsLanding.tsx',
  'components/comicshost/ComicsHeader.tsx',
  'components/comicshost/StudioPreview.tsx',
  'components/comicshost/ComicPageSpecimen.tsx',
  'components/comicshost/ComicsMark.tsx',
  'components/ds/AppHeader.tsx',
  'components/layout/BrandLockup.tsx',
  'components/layout/LegalMicroLinks.tsx'
];
/** The views one click off the landing, under the same header (they load data, so only the design rules apply). */
const VIEWS = [
  'components/AuthPage.tsx',
  'components/RedeemInvite.tsx',
  'components/WaitlistForm.tsx',
  'components/PublicGallery.tsx',
  'components/PrivacyPolicy.tsx',
  'components/TermsOfService.tsx'
];
const SCENES = [
  'qa/app/scenes/landing.tsx',
  'qa/app/scenes/landing-signedin.tsx',
  'qa/app/scenes/auth.tsx',
  'qa/app/scenes/auth-signin.tsx',
  'qa/app/scenes/auth-access.tsx'
];

const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' ')).replace(/(^|[\s;{}(),])\/\/.*$/gm, (_m, lead: string) => lead);

const OPACITY = String.raw`(?:\/(?:\d+|\[[^\]\s]+\]))?`;
const LEGACY_KIT = new RegExp(
  String.raw`(?<![\w-])${VARIANT}(?:border-(?:[xytrbl]-)?black${OPACITY}|shadow-comic(?:-[a-z]+)?|font-comic|[a-z]+(?:-[a-z]+)*-brand-(?:yellow|blue|red|black)${OPACITY}|font-display(?!\s*:))(?![\w-])`,
  'g'
);
const TERRACOTTA = /#(?:d97757|c2643f|c2603f)(?:[0-9a-f]{2})?(?![0-9a-f])/gi;
const Z_CLASS = new RegExp(String.raw`(?<![\w-])${VARIANT}-?z-(?:\d+|\[[^\]\s]+\])(?![\w-])`, 'g');
const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const RAW_STATUS_INK = new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?text-(?:${HUES})-\d{2,3}(?:\/\d+|\/\[[^\]]+\])?(?![\w-])`, 'g');
const TEXT_WHITE = new RegExp(String.raw`(?<![\w-])${VARIANT}text-white(?:\/\d+)?(?![\w-])`, 'g');
const SPELLED_MOTION = new RegExp(String.raw`(?<![\w-])${VARIANT}(?:duration|delay)-(?:\d+|\[\d[^\]\s]*\])(?![\w-])`, 'g');
const HEX_CLASS = new RegExp(String.raw`(?<![\w-])${VARIANT}[a-z-]+-\[#[0-9a-fA-F]{3,8}\]`, 'g');
/** The arbitrary-breakpoint rule, applied to each class token of each literal. */
const ARBITRARY_SCREEN = /(?:^|:)!?(?:min|max)-\[[^\]]*\]:/;
const CLASS_TOKEN = /[^\s'"`{}]+/g;

const hits = (rel: string, pattern: RegExp) => findInLiterals(read(rel), pattern, (m) => withoutVariant(m), rel).map((h) => `${rel}:${h.line} ${h.token}`);

describe('the comics home reads 0 on every design-system guard', () => {
  for (const rel of [...OWNED, ...VIEWS, ...SCENES]) {
    it(`${rel}: no legacy kit, terracotta, raw z, raw hue ink, hand-rolled eyebrow, local cx, hard white or spelled motion`, () => {
      expect(hits(rel, LEGACY_KIT), 'legacy kit').toEqual([]);
      expect(hits(rel, TERRACOTTA), 'terracotta').toEqual([]);
      expect(hits(rel, Z_CLASS), 'raw z-index (use Z)').toEqual([]);
      expect(hits(rel, TEXT_WHITE), 'text-white (use the on-fill tokens)').toEqual([]);
      expect(hits(rel, SPELLED_MOTION), 'a spelled duration or delay (use the --ds-motion-* tokens)').toEqual([]);
      expect(hits(rel, HEX_CLASS), 'a hex inside a class (use a token)').toEqual([]);
      const screens = findInLiterals(read(rel), CLASS_TOKEN, (m) => m, rel).filter((h) => ARBITRARY_SCREEN.test(h.token));
      expect(screens.map((h) => `${rel}:${h.line} ${h.token}`), 'min-[…]: / max-[…]: (no CSS in this config; use a named screen)').toEqual([]);
      expect([...stripComments(read(rel)).matchAll(RAW_STATUS_INK)].map((m) => m[0]), 'raw hue text (use TONE_TEXT / STATUS_INK)').toEqual([]);
      expect(findHandRolledOverlines(read(rel), rel), 'hand-rolled eyebrow (use OVERLINE)').toEqual([]);
      expect(stripComments(read(rel)), 'a local cx (use cn)').not.toMatch(/\b(?:const|let|function)\s+cx\b/);
    });
  }

  it('nothing on the comics home runs on a timer or reaches the network itself', () => {
    for (const rel of OWNED) {
      const code = stripComments(read(rel));
      expect(code, rel).not.toMatch(/\bset(?:Timeout|Interval)\s*\(/);
      expect(code, rel).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\/api\b|supabase/i);
    }
  });

  it('the guard patterns catch what they guard (planted samples)', () => {
    const planted = (src: string, re: RegExp) => findInLiterals(src, re, (m) => withoutVariant(m), 'probe.tsx').map((h) => h.token);
    expect(planted('const a = <b className="border-2 border-black shadow-comic font-display" />;', LEGACY_KIT)).toEqual(['border-black', 'shadow-comic', 'font-display']);
    expect(planted("const a = 'hover:bg-[#d97757] z-40 text-white duration-200 bg-[#c2603f]';", TERRACOTTA)).toHaveLength(2);
    expect(planted("const a = 'md:z-40';", Z_CLASS)).toEqual(['z-40']);
    expect(planted("const a = 'hover:text-white';", TEXT_WHITE)).toEqual(['text-white']);
    expect(planted("const a = 'duration-200 delay-[300ms] duration-[var(--ds-motion-fast)]';", SPELLED_MOTION)).toEqual(['duration-200', 'delay-[300ms]']);
    expect(planted("const a = 'bg-[#ffffff]';", HEX_CLASS)).toEqual(['bg-[#ffffff]']);
  });
});
