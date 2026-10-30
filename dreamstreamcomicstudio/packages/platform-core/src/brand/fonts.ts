/**
 * The platform font registry (plan §6 BrandKit "fonts (licence + reserved-font-name flags)", §8): every face a
 * BrandKit, a skin or a produced file (email, DOCX, deck) may name. Metadata only: no font file is read or fetched
 * here, and email never loads a web font (it names a face, then a stack every inbox has).
 *
 * - Licences: SIL OFL 1.1 or Apache 2.0 only (`FONT_LICENCES`); anything else fails `fontRegistryProblems`.
 * - Reserved Font Names: OFL lets a licensor reserve names that a MODIFIED version may not use. `reservedNames` is
 *   read from the face's own copyright line (`reservedNamesIn`), and a face with any reserved name must be
 *   `servedAs: 'unmodified'` (the upstream release files, byte for byte: no subsetting, renaming or conversion of our
 *   own). `fontRegistryProblems` enforces both, so the flag can never drift from the licence text.
 * - Copyright lines were checked against each family's upstream licence file on 2026-10-30.
 */

export type FontLicence = 'OFL-1.1' | 'Apache-2.0';

/** The only licences a registered face may carry. */
export const FONT_LICENCES: readonly FontLicence[] = ['OFL-1.1', 'Apache-2.0'];

/**
 * `unmodified`: the upstream release files exactly as published (including an upstream-published subset).
 * `modified`: we subset, convert or rename it ourselves; allowed only for a face with no reserved name.
 */
export type FontServedAs = 'unmodified' | 'modified';

/** Where the files come from: our own static folder, the Google Fonts CSS2 API, or nowhere yet (`planned`). */
export type FontHosting = 'self' | 'google-css2' | 'none';

export type FontRole = 'ui' | 'body' | 'display' | 'lettering';

export interface PlatformFont {
  /** Registry id (`^[a-z][a-z0-9-]{1,40}$`), what BrandKits name. */
  id: string;
  /** The family name as installed and as CSS names it. */
  family: string;
  licence: FontLicence;
  /** The copyright line of the upstream licence file, verbatim (it declares any Reserved Font Name). */
  copyright: string;
  /** Reserved Font Names declared in `copyright` (`reservedNamesIn`); empty when there are none. */
  reservedNames: readonly string[];
  servedAs: FontServedAs;
  hosting: FontHosting;
  /** `shipped`: in use today; `planned`: registered ahead of the wave that adds its files (plan §8, wave 3). */
  status: 'shipped' | 'planned';
  roles: readonly FontRole[];
  /** Weights we serve (or will serve). */
  weights: readonly number[];
  /** CSS fallback stack after the family: faces every reader already has. */
  fallback: string;
  /** The family's upstream repository. */
  source: string;
}

const SANS_FALLBACK = "-apple-system, 'Segoe UI', Arial, Helvetica, sans-serif";
const DISPLAY_FALLBACK = "Impact, 'Arial Black', Arial, sans-serif";
const ROUNDED_FALLBACK = "'Trebuchet MS', Arial, sans-serif";

/** Every face, in registry order. Ids are stable; families never change under an id. */
export const PLATFORM_FONTS: readonly PlatformFont[] = [
  {
    id: 'inter',
    family: 'Inter',
    licence: 'OFL-1.1',
    copyright: 'Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)',
    reservedNames: [],
    servedAs: 'unmodified',
    hosting: 'google-css2',
    status: 'shipped',
    roles: ['ui', 'body'],
    weights: [400, 600],
    fallback: SANS_FALLBACK,
    source: 'https://github.com/rsms/inter',
  },
  {
    id: 'ibm-plex-sans',
    family: 'IBM Plex Sans',
    licence: 'OFL-1.1',
    copyright: 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"',
    reservedNames: ['Plex'],
    servedAs: 'unmodified',
    hosting: 'self',
    status: 'shipped',
    roles: ['ui', 'body'],
    weights: [400, 500, 600, 700],
    fallback: SANS_FALLBACK,
    source: 'https://github.com/IBM/plex',
  },
  {
    id: 'space-grotesk',
    family: 'Space Grotesk',
    licence: 'OFL-1.1',
    copyright: 'Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)',
    reservedNames: [],
    servedAs: 'unmodified',
    hosting: 'self',
    status: 'shipped',
    roles: ['display'],
    weights: [500, 600, 700],
    fallback: SANS_FALLBACK,
    source: 'https://github.com/floriankarsten/space-grotesk',
  },
  {
    id: 'bangers',
    family: 'Bangers',
    licence: 'OFL-1.1',
    copyright: 'Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers)',
    reservedNames: [],
    servedAs: 'unmodified',
    hosting: 'google-css2',
    status: 'shipped',
    roles: ['display', 'lettering'],
    weights: [400],
    fallback: DISPLAY_FALLBACK,
    source: 'https://github.com/googlefonts/bangers',
  },
  {
    id: 'comic-neue',
    family: 'Comic Neue',
    licence: 'OFL-1.1',
    copyright: 'Copyright 2014 The Comic Neue Project Authors (https://github.com/crozynski/comicneue)',
    reservedNames: [],
    servedAs: 'unmodified',
    hosting: 'google-css2',
    status: 'shipped',
    roles: ['body', 'lettering'],
    weights: [400, 700],
    fallback: "'Comic Sans MS', 'Chalkboard SE', Arial, sans-serif",
    source: 'https://github.com/crozynski/comicneue',
  },
  {
    id: 'noto-sans',
    family: 'Noto Sans',
    licence: 'OFL-1.1',
    copyright: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)',
    reservedNames: [],
    servedAs: 'unmodified',
    hosting: 'self',
    status: 'shipped',
    roles: ['body'],
    weights: [600, 700],
    fallback: SANS_FALLBACK,
    source: 'https://github.com/notofonts/latin-greek-cyrillic',
  },
  {
    id: 'titan-one',
    family: 'Titan One',
    licence: 'OFL-1.1',
    copyright: 'Copyright (c) 2011, Rodrigo Fuenzalida (www.rfuenzalida.com|hello@rfuenzalida.com), with Reserved Font Name Titan.',
    reservedNames: ['Titan'],
    servedAs: 'unmodified',
    hosting: 'none',
    status: 'planned',
    roles: ['display', 'lettering'],
    weights: [400],
    fallback: DISPLAY_FALLBACK,
    source: 'https://github.com/google/fonts/tree/main/ofl/titanone',
  },
  {
    id: 'bowlby-one-sc',
    family: 'Bowlby One SC',
    licence: 'OFL-1.1',
    copyright: 'Copyright (c) 2011 by vernon adams (vern@newtypography.co.uk), with Reserved Font Names "Bowlby" "Bowlby One" and "Bowlby One SC"',
    reservedNames: ['Bowlby', 'Bowlby One', 'Bowlby One SC'],
    servedAs: 'unmodified',
    hosting: 'none',
    status: 'planned',
    roles: ['display', 'lettering'],
    weights: [400],
    fallback: DISPLAY_FALLBACK,
    source: 'https://github.com/google/fonts/tree/main/ofl/bowlbyonesc',
  },
  {
    id: 'bubblegum-sans',
    family: 'Bubblegum Sans',
    licence: 'OFL-1.1',
    copyright:
      'Copyright (c) 2011 Angel Koziupa (sudtipos@sudtipos.com), Copyright (c) 2011 Alejandro Paul (sudtipos@sudtipos.com), with Reserved Font Name "Bubblegum Sans"',
    reservedNames: ['Bubblegum Sans'],
    servedAs: 'unmodified',
    hosting: 'none',
    status: 'planned',
    roles: ['display', 'lettering'],
    weights: [400],
    fallback: ROUNDED_FALLBACK,
    source: 'https://github.com/google/fonts/tree/main/ofl/bubblegumsans',
  },
];

/** The stack used when a BrandKit names no face, or one the registry does not know. */
export const DEFAULT_FONT_STACK = 'Arial, Helvetica, sans-serif';

const FONT_ID = /^[a-z][a-z0-9-]{1,40}$/;
/** Family names and fallback stacks go into CSS inside an HTML attribute: letters, digits, spaces, commas, quotes, hyphens only. */
const CSS_FONT_SAFE = /^[A-Za-z0-9 ,'-]+$/;

/**
 * The Reserved Font Names an OFL copyright line declares: `with Reserved Font Name "X"`, `with Reserved Font Names
 * "X" "Y" and "Z"` or an unquoted `with Reserved Font Name X.`; `[]` when the line reserves none.
 */
export const reservedNamesIn = (copyright: string): string[] => {
  const m = /with Reserved Font Names?\s+(.*)$/i.exec(copyright);
  if (!m) return [];
  const quoted = m[1].match(/"[^"]+"/g);
  if (quoted) return quoted.map((q) => q.slice(1, -1));
  const bare = m[1].replace(/[.\s]+$/, '').trim();
  return bare ? [bare] : [];
};

/** The registered face with this id, if any. */
export const platformFont = (id: string): PlatformFont | undefined => {
  for (const f of PLATFORM_FONTS) if (f.id === id) return f;
  return undefined;
};

/** A CSS `font-family` value for a registry id: the quoted family, then its fallback stack. Unknown ids get the default. */
export const fontStack = (id: string | undefined): string => {
  const f = id === undefined ? undefined : platformFont(id);
  if (!f || !CSS_FONT_SAFE.test(f.family) || f.family.indexOf("'") !== -1 || !CSS_FONT_SAFE.test(f.fallback)) return DEFAULT_FONT_STACK;
  return `'${f.family}', ${f.fallback}`;
};

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Everything wrong with a registry, as readable lines (empty when it is sound): a licence outside `FONT_LICENCES`;
 * `reservedNames` that differ from what the copyright line declares; a face with a reserved name that is not served
 * unmodified; a duplicate or malformed id; a family or fallback that is unsafe inside CSS.
 */
export const fontRegistryProblems = (fonts: readonly PlatformFont[]): string[] => {
  const out: string[] = [];
  const seen: string[] = [];
  for (const f of fonts) {
    const at = `font ${JSON.stringify(f.id)}`;
    if (!FONT_ID.test(f.id)) out.push(`${at}: id must match ${FONT_ID.source}`);
    if (seen.indexOf(f.id) !== -1) out.push(`${at}: duplicate id`);
    seen.push(f.id);
    if (FONT_LICENCES.indexOf(f.licence) === -1) out.push(`${at}: licence ${JSON.stringify(f.licence)} is not one of ${FONT_LICENCES.join(', ')}`);
    const declared = reservedNamesIn(f.copyright);
    if (!sameList(declared, f.reservedNames)) {
      out.push(`${at}: reservedNames ${JSON.stringify(f.reservedNames)} differ from the copyright line's ${JSON.stringify(declared)}`);
    }
    if ((f.reservedNames.length > 0 || declared.length > 0) && f.servedAs !== 'unmodified') {
      out.push(`${at}: has a Reserved Font Name, so it must be served unmodified (servedAs 'unmodified')`);
    }
    if (!CSS_FONT_SAFE.test(f.family) || f.family.indexOf("'") !== -1) out.push(`${at}: family has characters CSS cannot carry safely`);
    if (!CSS_FONT_SAFE.test(f.fallback)) out.push(`${at}: fallback has characters CSS cannot carry safely`);
    if (f.status === 'planned' && f.hosting !== 'none') out.push(`${at}: a planned face has no files yet (hosting 'none')`);
    if (f.weights.length === 0) out.push(`${at}: needs at least one weight`);
  }
  return out;
};
