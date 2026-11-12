// PE-FONTS generator (master plan §2.6, §2.8): the self-hosted lettering face tables and the font picker's specimen
// sprite, both derived from the exactly pinned @fontsource packages and the registry (shared/comic/lettering/fonts.ts).
//
//   npx tsx scripts/build-font-specimens.mjs            regenerate everything below
//   npx tsx scripts/build-font-specimens.mjs --check    regenerate in memory; exit 1 if a committed file differs
//   npx tsx scripts/build-font-specimens.mjs --metrics  print the measured metrics of the Pro faces (fonts.ts)
//
// Writes (all under components/comicstudio/lettering/):
//   fontFiles.ts            the 12 base Latin faces (eager, as before) + a lazy loader per Pro / script face
//   fontTables/pro.ts       the 28 Pro faces (latin + latin-ext slices, every weight and style they ship)
//   fontTables/<noto>.ts    one per Noto script face (every unicode-range slice of the registry's weights)
//   fontSpecimens.png       every face's name drawn in its own face (≤ 60 KB; rasterized glyph outlines, not fonts)
//   fontSpecimens.ts        where each face sits in the sprite
//
// Reads only node_modules/@fontsource/*/{weight}[-italic].css and the WOFF files; never installs or fetches anything.
// Run with tsx (the registry is TypeScript); the pure helpers below need only node: built-ins. sharp (a dependency)
// rasterizes the sprite and is loaded only for that step.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LETTERING_DIR = path.join(APP_ROOT, 'components/comicstudio/lettering');
export const TABLES_DIR = path.join(LETTERING_DIR, 'fontTables');

/** The specimen sprite's budget (master plan §2.8: browsing the picker never downloads 54 faces). */
export const SPECIMEN_MAX_BYTES = 60 * 1024;
/** Specimen geometry in CSS px; the sprite is drawn at SPECIMEN.scale for sharp text on 2× screens. */
export const SPECIMEN = Object.freeze({ fontPx: 15, rowHeight: 22, baseline: 16, maxWidth: 220, scale: 2 });

/**
 * The calibration sample for `avgAdvanceEm` / `mixedCaseEm` (fonts.ts): 134 graphemes of ordinary comic dialogue.
 * With it the base faces' stored values reproduce within about 1 % (the method fonts.ts describes).
 */
export const METRICS_SAMPLE =
  'Where did the moon go? Look, up there! I told you we should have taken the left turn at the old bridge, but nobody ever listens to me.';
/** Comic Neue's calibrated advance (fonts.ts CN_EM), the unit every other face is measured against. */
const CN_EM = 0.0105 / 0.017;

// ── WOFF 1.0 / TrueType reader (glyf outlines, cmap 4/12, hmtx) ─────────────────────────────────────────────────

/** The sfnt tables of a WOFF 1.0 or bare TrueType file (Map tag → bytes). */
export function readSfntTables(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const tables = new Map();
  const sig = dv.getUint32(0);
  if (sig === 0x774f4646) {
    // 'wOFF': 44-byte header, then 20-byte entries {tag, offset, compLength, origLength, origChecksum}; zlib when smaller.
    const num = dv.getUint16(12);
    for (let i = 0; i < num; i++) {
      const o = 44 + i * 20;
      const off = dv.getUint32(o + 4);
      const comp = dv.getUint32(o + 8);
      const orig = dv.getUint32(o + 12);
      const raw = buf.subarray(off, off + comp);
      tables.set(tag(o), comp < orig ? inflateSync(raw) : Buffer.from(raw));
    }
  } else if (sig === 0x00010000 || sig === 0x74727565) {
    const num = dv.getUint16(4);
    for (let i = 0; i < num; i++) {
      const o = 12 + i * 16;
      tables.set(tag(o), Buffer.from(buf.subarray(dv.getUint32(o + 8), dv.getUint32(o + 8) + dv.getUint32(o + 12))));
    }
  } else throw new Error('not a WOFF 1.0 or TrueType file');
  return tables;
}

/** A parsed TrueType face: metrics, cmap lookup and quadratic glyph outlines (font units, y up). */
export function openFont(buf) {
  const tables = readSfntTables(buf);
  const view = (t) => {
    const b = tables.get(t);
    if (!b) throw new Error(`font has no ${t} table`);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  };
  if (tables.has('CFF ') || tables.has('CFF2')) throw new Error('CFF outlines are not supported (fontsource ships TrueType)');
  const head = view('head');
  const hhea = view('hhea');
  const maxp = view('maxp');
  const hmtx = view('hmtx');
  const cmap = view('cmap');
  const loca = view('loca');
  const glyf = view('glyf');
  const unitsPerEm = head.getUint16(18);
  const longLoca = head.getInt16(50) === 1;
  const numGlyphs = maxp.getUint16(4);
  const nHM = hhea.getUint16(34);
  const advance = (g) => hmtx.getUint16(4 * Math.min(g, nHM - 1));
  const glyphRange = (g) => {
    if (g < 0 || g >= numGlyphs) return [0, 0];
    return longLoca ? [loca.getUint32(g * 4), loca.getUint32(g * 4 + 4)] : [loca.getUint16(g * 2) * 2, loca.getUint16(g * 2 + 2) * 2];
  };

  let best = null;
  for (let i = 0, n = cmap.getUint16(2); i < n; i++) {
    const pid = cmap.getUint16(4 + i * 8);
    const off = cmap.getUint32(8 + i * 8);
    const fmt = cmap.getUint16(off);
    const rank = fmt === 12 ? 3 : fmt === 4 && (pid === 3 || pid === 0) ? 2 : 0;
    if (rank && (!best || rank > best.rank)) best = { off, fmt, rank };
  }
  if (!best) throw new Error('font has no usable cmap');
  const glyphOf = (cp) => {
    const o = best.off;
    if (best.fmt === 12) {
      for (let i = 0, groups = cmap.getUint32(o + 12); i < groups; i++) {
        const g = o + 16 + i * 12;
        const s = cmap.getUint32(g);
        if (cp >= s && cp <= cmap.getUint32(g + 4)) return cmap.getUint32(g + 8) + (cp - s);
      }
      return 0;
    }
    if (cp > 0xffff) return 0;
    const segX2 = cmap.getUint16(o + 6);
    const ends = o + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      if (cp > cmap.getUint16(ends + i * 2)) continue;
      const s = cmap.getUint16(starts + i * 2);
      if (cp < s) return 0;
      const ro = cmap.getUint16(ranges + i * 2);
      const d = cmap.getInt16(deltas + i * 2);
      if (!ro) return (cp + d) & 0xffff;
      const gi = cmap.getUint16(ranges + i * 2 + ro + (cp - s) * 2);
      return gi ? (gi + d) & 0xffff : 0;
    }
    return 0;
  };

  /** Contours of glyph `g`: arrays of {x, y, on}; composites are flattened (offsets and 2×2 transforms). */
  const contours = (g, depth = 0) => {
    const [start, end] = glyphRange(g);
    if (end <= start || depth > 8) return [];
    const nc = glyf.getInt16(start);
    if (nc >= 0) {
      let p = start + 10;
      const endPts = [];
      for (let i = 0; i < nc; i++, p += 2) endPts.push(glyf.getUint16(p));
      const nPts = nc ? endPts[nc - 1] + 1 : 0;
      p += 2 + glyf.getUint16(p); // skip instructions
      const flags = [];
      while (flags.length < nPts) {
        const f = glyf.getUint8(p++);
        flags.push(f);
        if (f & 8) for (let r = glyf.getUint8(p++); r > 0; r--) flags.push(f);
      }
      const coord = (short, same) => {
        const out = [];
        let v = 0;
        for (const f of flags) {
          if (f & short) v += (f & same ? 1 : -1) * glyf.getUint8(p++);
          else if (!(f & same)) {
            v += glyf.getInt16(p);
            p += 2;
          }
          out.push(v);
        }
        return out;
      };
      const xs = coord(2, 16);
      const ys = coord(4, 32);
      const out = [];
      let from = 0;
      for (const e of endPts) {
        const c = [];
        for (let i = from; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        out.push(c);
        from = e + 1;
      }
      return out;
    }
    // Composite glyph.
    const out = [];
    let p = start + 10;
    for (;;) {
      const flags = glyf.getUint16(p);
      const child = glyf.getUint16(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 1) {
        dx = glyf.getInt16(p);
        dy = glyf.getInt16(p + 2);
        p += 4;
      } else {
        dx = glyf.getInt8(p);
        dy = glyf.getInt8(p + 1);
        p += 2;
      }
      if (!(flags & 2)) dx = dy = 0; // point matching: not used by these faces' Latin glyphs
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2 = (o) => glyf.getInt16(o) / 16384;
      if (flags & 8) {
        a = d = f2(p);
        p += 2;
      } else if (flags & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (flags & 0x80) {
        [a, b, c, d] = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)];
        p += 8;
      }
      for (const contour of contours(child, depth + 1)) out.push(contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  };
  return { tables, unitsPerEm, numGlyphs, advance, glyphOf, contours };
}

/** Sum of the advances of `text` (no kerning), in em. */
export const textAdvanceEm = (font, text) => {
  let sum = 0;
  for (const ch of text) sum += font.advance(font.glyphOf(ch.codePointAt(0)));
  return sum / font.unitsPerEm;
};

/** SVG path data for `text` set at (x, baseline) in px (y down), quadratic curves, 2 decimals. */
export function textPath(font, text, x0, baseline, px) {
  const k = px / font.unitsPerEm;
  const r = (v) => Math.round(v * 100) / 100;
  let x = x0;
  let d = '';
  for (const ch of text) {
    const g = font.glyphOf(ch.codePointAt(0));
    for (const c of font.contours(g)) {
      if (!c.length) continue;
      const pt = (p) => ({ x: x + p.x * k, y: baseline - p.y * k });
      // Start on an on-curve point; a contour of only off-curve points starts at the midpoint of its last and first.
      const s = c.findIndex((p) => p.on);
      const first = s < 0 ? { x: (c[0].x + c[c.length - 1].x) / 2, y: (c[0].y + c[c.length - 1].y) / 2, on: true } : c[s];
      const ring = s < 0 ? c : [...c.slice(s + 1), ...c.slice(0, s)];
      const f = pt(first);
      d += `M${r(f.x)} ${r(f.y)}`;
      let ctrl = null;
      for (const p of [...ring, first]) {
        const e = pt(p);
        if (p.on) {
          d += ctrl ? `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(e.x)} ${r(e.y)}` : `L${r(e.x)} ${r(e.y)}`;
          ctrl = null;
        } else {
          // Two off-curve points in a row imply an on-curve point halfway between them.
          if (ctrl) d += `Q${r(ctrl.x)} ${r(ctrl.y)} ${r((ctrl.x + e.x) / 2)} ${r((ctrl.y + e.y) / 2)}`;
          ctrl = e;
        }
      }
      d += 'Z';
    }
    x += font.advance(g) * k;
  }
  return d;
}

// ── fontsource packages ─────────────────────────────────────────────────────────────────────────────────────────

export const pkgDir = (pkg, root = APP_ROOT) => path.join(root, 'node_modules', pkg);

/** The @font-face blocks of `<pkg>/<weight>[-italic].css`, in file order: {subset, file, weight, style, range}. */
export function fontsourceFaces(pkg, weight, style, root = APP_ROOT) {
  const css = readFileSync(path.join(pkgDir(pkg, root), `${weight}${style === 'italic' ? '-italic' : ''}.css`), 'utf8');
  const out = [];
  for (const m of css.matchAll(/\/\*\s*([^*]+?)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    const w = Number(/font-weight:\s*(\d+)/.exec(body)?.[1]);
    const st = /font-style:\s*(\w+)/.exec(body)?.[1];
    if (!file || !range || w !== weight || st !== style) throw new Error(`unexpected @font-face in ${pkg}/${weight} ${style}`);
    const base = pkg.slice(pkg.indexOf('/') + 1);
    const subset = file.slice(base.length + 1, file.length - `-${weight}-${style}.woff2`.length);
    out.push({ subset: /^\d+$/.test(subset) ? `[${subset}]` : subset, file, weight, style, range });
  }
  return out;
}

const SCRIPT_SUBSET = { Deva: 'devanagari' };
/** Which slices ship, per kind of face (the rule fontFiles.ts documents). */
export function facePlan(meta, kind, root = APP_ROOT) {
  const styles = kind === 'script' || !meta.italic ? ['normal'] : ['normal', 'italic'];
  const keep =
    kind === 'script'
      ? () => true
      : (f) => f.subset === 'latin' || f.subset === 'latin-ext' || (kind === 'base' && meta.scripts.some((s) => SCRIPT_SUBSET[s] === f.subset));
  const files = [];
  for (const w of meta.weights) for (const st of styles) for (const f of fontsourceFaces(meta.pkg, w, st, root)) if (keep(f)) files.push({ ...f, pkg: meta.pkg });
  return files;
}

// ── Generated TypeScript ────────────────────────────────────────────────────────────────────────────────────────

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (id) => (/^[a-z_$][a-z0-9_$]*$/i.test(id) ? id : q(id));

/** Imports, range constants and entries for a set of faces (one module's worth). */
function tableParts(faces, varPrefix, rangePrefix) {
  const imports = [];
  const ranges = new Map();
  const entries = [];
  let n = 0;
  for (const [id, files] of faces) {
    const rows = files.map((f) => {
      const v = `${varPrefix}${n++}`;
      imports.push(`import ${v} from '${f.pkg}/files/${f.file}?url';`);
      if (!ranges.has(f.range)) ranges.set(f.range, `${rangePrefix}${ranges.size}`);
      return `{ weight: ${f.weight}, style: '${f.style}', subset: ${q(f.subset)}, url: ${v}, unicodeRange: ${ranges.get(f.range)} }`;
    });
    entries.push([id, rows]);
  }
  const consts = [...ranges].map(([r, name]) => `const ${name} = ${q(r)};`);
  return { imports, consts, entries };
}

/**
 * A face plan as weights × styles × slices (the same slices, in CSS order, for every weight and style; asserted, so the
 * compact tables expand to exactly the planned files).
 */
const fileSubset = (subset) => subset.replace(/^\[(\d+)\]$/, '$1');
/** A glob alternation that matches exactly these values (a lone value needs no braces). */
const alt = (values) => (values.length === 1 ? String(values[0]) : `{${values.join(',')}}`);

function shape(files, pkg) {
  const base = pkg.slice(pkg.indexOf('/') + 1);
  const weights = [...new Set(files.map((f) => f.weight))];
  const styles = [...new Set(files.map((f) => f.style))];
  const first = files.filter((f) => f.weight === weights[0] && f.style === styles[0]);
  const slices = first.map((f) => [f.subset, f.range]);
  const expanded = weights.flatMap((weight) => styles.flatMap((style) => slices.map(([subset, range]) => `${weight}|${style}|${subset}|${range}`)));
  const planned = files.map((f) => `${f.weight}|${f.style}|${f.subset}|${f.range}`);
  if (expanded.join('\n') !== planned.join('\n')) throw new Error(`${pkg}: slices differ between weights or styles`);
  for (const f of files) {
    const sub = fileSubset(f.subset);
    if (f.file !== `${base}-${sub}-${f.weight}-${f.style}.woff2`) throw new Error(`${pkg}: unexpected file name ${f.file}`);
  }
  return { base, weights, styles, slices };
}

const GENERATED = '// GENERATED by scripts/build-font-specimens.mjs (PE-FONTS) from node_modules/@fontsource/*/{weight}[-italic].css. Do not\n// hand-edit: run `npx tsx scripts/build-font-specimens.mjs` when a face, weight or subset changes.';

/** Every generated table file: path (relative to the app root) → contents. */
export async function renderFontTables(root = APP_ROOT) {
  const { FONT_REGISTRY, PRO_FONT_REGISTRY } = await import('../shared/comic/lettering/fonts.ts');
  const { FONT_IDS } = await import('../shared/comic/lettering/style.ts');
  const { PRO_FONT_IDS } = await import('../shared/comic/lettering/proFonts.ts');
  const scriptIds = FONT_IDS.filter((id) => FONT_REGISTRY[id].family.startsWith('Noto '));
  const baseIds = FONT_IDS.filter((id) => !scriptIds.includes(id));
  /** @type {Record<string, string>} */
  const out = {};

  const base = tableParts(baseIds.map((id) => [id, facePlan(FONT_REGISTRY[id], 'base', root)]), 'f', 'R');
  out['components/comicstudio/lettering/fontFiles.ts'] = [
    GENERATED,
    '//',
    '// Self-hosted lettering faces for the board, print and export (lettering.md §6.5). Vite emits each woff2 as a hashed',
    '// immutable asset that is fetched only when a FontFace actually loads it (unicode-range keeps unused slices idle).',
    '// - FONT_FILES: the 12 base Latin faces, eager (latin + latin-ext, + devanagari for Kalam, which covers Hindi).',
    '// - LAZY_FONT_FILES: the 28 Pro faces and the 14 Noto script faces. Each table is its own chunk (fontTables/*),',
    "//   imported only when the loader is asked for that face, so the Easy path and a Latin comic never carry them.",
    '// Licences: see FONT_REGISTRY / PRO_FONT_REGISTRY (OFL-1.1 / Apache-2.0 only).',
    '',
    '/* eslint-disable */',
    ...base.imports,
    '',
    "import type { LatinFontId, ScriptFontId } from '../../../shared/comic/lettering/style';",
    "import type { ProFontId } from '../../../shared/comic/lettering/proFonts';",
    '',
    'export interface FontFile {',
    '  weight: number;',
    "  style: 'normal' | 'italic';",
    '  subset: string;',
    '  url: string;',
    '  unicodeRange: string;',
    '}',
    '',
    ...base.consts,
    '',
    'export const FONT_FILES: Record<LatinFontId, FontFile[]> = {',
    base.entries.map(([id, rows]) => `  ${q(id)}: [\n    ${rows.join(',\n    ')}\n  ]`).join(',\n'),
    '};',
    '',
    '/** The face table of each Pro and script face, loaded on first use (one chunk per table). */',
    'export const LAZY_FONT_FILES: Readonly<Record<ProFontId | ScriptFontId, () => Promise<FontFile[]>>> = {',
    [
      ...PRO_FONT_IDS.map((id) => `  ${key(id)}: () => import('./fontTables/pro').then((m) => m.PRO_FONT_FILES[${q(id)}])`),
      ...scriptIds.map((id) => `  ${key(id)}: () => import('./fontTables/${id}').then((m) => m.FILES)`)
    ].join(',\n'),
    '};',
    ''
  ].join('\n');

  // Pro and script tables are compact data expanded at load: one import.meta.glob per module (Vite emits the woff2 files
  // as assets; `exhaustive` lets it look inside node_modules) and [subset, unicode-range] rows, so the type checker
  // never sees thousands of imports or object literals (a CJK face alone is 744 files). Each glob names its subsets,
  // weights and styles exactly, so no file the CSS does not use is emitted (Noto Sans JP ships an unused whole
  // 'japanese' subset next to its 124 slices).
  const GLOB_OPTS = "{ eager: true, query: '?url', import: 'default', exhaustive: true }";
  const proFaces = PRO_FONT_IDS.map((id) => {
    const meta = PRO_FONT_REGISTRY[id];
    return { id, meta, ...shape(facePlan(meta, 'pro', root), `${meta.pkg}`) };
  });
  const proRanges = [...new Set(proFaces.flatMap((f) => f.slices.map(([, r]) => r)))];
  out['components/comicstudio/lettering/fontTables/pro.ts'] = [
    GENERATED,
    '// The 28 Pro lettering faces (PRO_FONT_IDS): latin + latin-ext slices of every weight and style each ships.',
    '',
    "import type { FontFile } from '../fontFiles';",
    "import type { ProFontId } from '../../../../shared/comic/lettering/proFonts';",
    '',
    'const URLS = import.meta.glob<string>(',
    '  [',
    proFaces.map((f) => `    ${q(`/node_modules/${f.meta.pkg}/files/${f.base}-${alt(f.slices.map(([sub]) => sub))}-${alt(f.weights)}-${alt(f.styles)}.woff2`)}`).join(',\n'),
    '  ],',
    `  ${GLOB_OPTS}`,
    ');',
    '/** Unicode ranges, by index. */',
    `const R = [${proRanges.map(q).join(', ')}];`,
    '/** [id, weights, styles, slices as [subset, range index]], each face in its package\'s CSS order. */',
    "const FACES: [ProFontId, number[], FontFile['style'][], [string, number][]][] = [",
    proFaces
      .map((f) => `  [${q(f.id)}, [${f.weights.join(', ')}], [${f.styles.map(q).join(', ')}], [${f.slices.map(([sub, r]) => `[${q(sub)}, ${proRanges.indexOf(r)}]`).join(', ')}]]`)
      .join(',\n'),
    '];',
    '',
    'export const PRO_FONT_FILES = Object.fromEntries(',
    '  FACES.map(([id, weights, styles, slices]) => [',
    '    id,',
    '    weights.flatMap((weight) =>',
    '      styles.flatMap((style) =>',
    '        slices.flatMap(([subset, r]): FontFile[] => {',
    '          const url = URLS[`/node_modules/@fontsource/${id}/files/${id}-${subset}-${weight}-${style}.woff2`];',
    '          return url ? [{ weight, style, subset, url, unicodeRange: R[r] }] : [];',
    '        })',
    '      )',
    '    )',
    '  ])',
    ') as Record<ProFontId, FontFile[]>;',
    ''
  ].join('\n');

  for (const id of scriptIds) {
    const meta = FONT_REGISTRY[id];
    const t = shape(facePlan(meta, 'script', root), meta.pkg);
    const dir = `/node_modules/${meta.pkg}/files/${t.base}-`;
    out[`components/comicstudio/lettering/fontTables/${id}.ts`] = [
      GENERATED,
      `// ${meta.family}: every unicode-range slice of weights ${meta.weights.join(', ')} (${t.slices.length} slices each). The browser fetches only`,
      '// the slices whose ranges the drawn text touches.',
      '',
      "import type { FontFile } from '../fontFiles';",
      '',
      'const URLS = import.meta.glob<string>(',
      `  ${q(`${dir}${alt(t.slices.map(([sub]) => fileSubset(sub)))}-${alt(t.weights)}-normal.woff2`)},`,
      `  ${GLOB_OPTS}`,
      ');',
      `const DIR = ${q(dir)};`,
      `const WEIGHTS = [${t.weights.join(', ')}];`,
      '/** Every slice as [subset, unicode-range], in the package\'s CSS order (numbered subsets are CJK slices). */',
      'const SLICES: [string, string][] = [',
      t.slices.map(([sub, r]) => `  [${q(sub)}, ${q(r)}]`).join(',\n'),
      '];',
      '',
      'export const FILES: FontFile[] = WEIGHTS.flatMap((weight) =>',
      '  SLICES.flatMap(([subset, unicodeRange]): FontFile[] => {',
      "    const url = URLS[`${DIR}${subset.replace(/^\\[(\\d+)\\]$/, '$1')}-${weight}-normal.woff2`];",
      "    return url ? [{ weight, style: 'normal', subset, url, unicodeRange }] : [];",
      '  })',
      ');',
      ''
    ].join('\n');
  }
  return out;
}

// ── Specimen sprite ─────────────────────────────────────────────────────────────────────────────────────────────

/** The WOFF a specimen is drawn from: the face's latin slice at its regular weight. */
export function specimenFontFile(meta, root = APP_ROOT) {
  const w = meta.weights.reduce((b, x) => (Math.abs(x - 400) < Math.abs(b - 400) ? x : b), meta.weights[0]);
  const base = meta.pkg.slice(meta.pkg.indexOf('/') + 1);
  return path.join(pkgDir(meta.pkg, root), 'files', `${base}-latin-${w}-normal.woff`);
}

/** Rows of the sprite (every base face, then every Pro face): {id, label, y, w, px, path}; y and w in CSS px. */
export async function layoutSpecimens(root = APP_ROOT) {
  const { FONT_REGISTRY, PRO_FONT_REGISTRY } = await import('../shared/comic/lettering/fonts.ts');
  const { FONT_IDS } = await import('../shared/comic/lettering/style.ts');
  const { PRO_FONT_IDS } = await import('../shared/comic/lettering/proFonts.ts');
  const rows = [];
  const metas = [...FONT_IDS.map((id) => FONT_REGISTRY[id]), ...PRO_FONT_IDS.map((id) => PRO_FONT_REGISTRY[id])];
  metas.forEach((meta, i) => {
    const font = openFont(readFileSync(specimenFontFile(meta, root)));
    const label = meta.label ?? meta.family;
    const em = textAdvanceEm(font, label);
    const px = Math.min(SPECIMEN.fontPx, Math.floor((SPECIMEN.maxWidth / em) * 100) / 100);
    const y = i * SPECIMEN.rowHeight;
    const w = Math.min(SPECIMEN.maxWidth, Math.ceil(em * px));
    const s = SPECIMEN.scale;
    rows.push({ id: meta.id, label, y, w, px, path: textPath(font, label, 0, (y + SPECIMEN.baseline) * s, px * s) });
  });
  return rows;
}

/** The sprite as SVG (black ink on transparent, device px), the input of the rasterizer. */
export function specimenSvg(rows) {
  const s = SPECIMEN.scale;
  const width = Math.max(...rows.map((r) => r.w)) * s;
  const height = rows.length * SPECIMEN.rowHeight * s;
  const paths = rows.map((r) => `<path d="${r.path}"/>`).join('');
  return { width, height, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="#000">${paths}</g></svg>` };
}

/** PNG of the sprite: 16-level palette (alpha carries the anti-aliasing; the picker uses it as a CSS mask). */
export async function rasterizeSpecimens(rows) {
  const { default: sharp } = await import('sharp');
  const { svg } = specimenSvg(rows);
  return sharp(Buffer.from(svg)).png({ palette: true, colours: 16, compressionLevel: 9, effort: 10 }).toBuffer();
}

/** The generated fontSpecimens.ts for these rows and sprite size. */
export function renderSpecimenModule(rows, bytes) {
  const { width, height } = specimenSvg(rows);
  const s = SPECIMEN.scale;
  return [
    '// GENERATED by scripts/build-font-specimens.mjs (PE-FONTS). Do not hand-edit: run `npx tsx scripts/build-font-specimens.mjs`',
    '// when a face is added or renamed (fontSpecimens.test.ts fails until you do).',
    '//',
    '// The font picker\'s specimen sprite (master plan §2.8): every lettering face\'s name drawn in its own face, in one PNG',
    `// of at most ${SPECIMEN_MAX_BYTES / 1024} KB, so browsing the list never downloads a face. It is an image of rasterized glyph outlines`,
    '// (rendered output, not font software). Use it as a CSS mask so the ink follows the theme: `fontSpecimenStyle(id)`.',
    '',
    "import type { CSSProperties } from 'react';",
    "import type { AnyFontId } from '../../../shared/comic/lettering/proFonts';",
    "import spriteUrl from './fontSpecimens.png?url';",
    '',
    '/** Where a face\'s specimen sits in the sprite, in CSS px (each row is FONT_SPECIMEN_SPRITE.rowHeight tall). */',
    'export interface FontSpecimen {',
    '  y: number;',
    '  w: number;',
    '}',
    '',
    `export const FONT_SPECIMEN_SPRITE = { url: spriteUrl, width: ${width / s}, height: ${height / s}, rowHeight: ${SPECIMEN.rowHeight}, scale: ${s}, bytes: ${bytes} } as const;`,
    '',
    'export const FONT_SPECIMENS: Readonly<Record<AnyFontId, FontSpecimen>> = {',
    rows.map((r) => `  ${key(r.id)}: { y: ${r.y}, w: ${r.w} }`).join(',\n'),
    '};',
    '',
    '/**',
    ' * Inline style that shows `id`\'s specimen in the current text colour (a mask over `currentColor`), sized to the row;',
    ' * undefined for an unknown id. Pair it with the face\'s name as text for assistive tech (the specimen is decorative).',
    ' */',
    'export function fontSpecimenStyle(id: string): CSSProperties | undefined {',
    '  const s = Object.prototype.hasOwnProperty.call(FONT_SPECIMENS, id) ? FONT_SPECIMENS[id as AnyFontId] : undefined;',
    '  if (!s) return undefined;',
    '  const image = `url("${FONT_SPECIMEN_SPRITE.url}")`;',
    '  const size = `${FONT_SPECIMEN_SPRITE.width}px ${FONT_SPECIMEN_SPRITE.height}px`;',
    '  const position = `0 ${-s.y}px`;',
    '  return {',
    "    display: 'inline-block',",
    '    width: s.w,',
    '    height: FONT_SPECIMEN_SPRITE.rowHeight,',
    "    backgroundColor: 'currentColor',",
    '    maskImage: image,',
    '    WebkitMaskImage: image,',
    '    maskSize: size,',
    '    WebkitMaskSize: size,',
    '    maskPosition: position,',
    '    WebkitMaskPosition: position,',
    "    maskRepeat: 'no-repeat',",
    "    WebkitMaskRepeat: 'no-repeat'",
    '  };',
    '}',
    ''
  ].join('\n');
}

// ── Metrics ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** avgAdvanceEm / mixedCaseEm of a face as fonts.ts calibrates them (regular weight vs Comic Neue Bold). */
export function measureMetrics(meta, root = APP_ROOT) {
  const n = [...METRICS_SAMPLE].length;
  const cn = openFont(readFileSync(path.join(pkgDir('@fontsource/comic-neue', root), 'files', 'comic-neue-latin-700-normal.woff')));
  const ref = textAdvanceEm(cn, METRICS_SAMPLE.toUpperCase()) / n;
  const font = openFont(readFileSync(specimenFontFile(meta, root)));
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return {
    avg: r4((CN_EM * (textAdvanceEm(font, METRICS_SAMPLE.toUpperCase()) / n)) / ref),
    mixed: r4((CN_EM * (textAdvanceEm(font, METRICS_SAMPLE) / n)) / ref)
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  if (argv.includes('--metrics')) {
    const { PRO_FONT_REGISTRY } = await import('../shared/comic/lettering/fonts.ts');
    for (const meta of Object.values(PRO_FONT_REGISTRY)) console.log(meta.id.padEnd(22), JSON.stringify(measureMetrics(meta)));
    return 0;
  }
  const check = argv.includes('--check');
  const files = await renderFontTables();
  const rows = await layoutSpecimens();
  const png = await rasterizeSpecimens(rows);
  if (png.length > SPECIMEN_MAX_BYTES) throw new Error(`specimen sprite is ${png.length} bytes (budget ${SPECIMEN_MAX_BYTES})`);
  files['components/comicstudio/lettering/fontSpecimens.ts'] = renderSpecimenModule(rows, png.length);
  const stale = [];
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(APP_ROOT, rel);
    const same = existsSync(abs) && readFileSync(abs, 'utf8') === text;
    if (same) continue;
    if (check) stale.push(rel);
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
  const pngPath = path.join(LETTERING_DIR, 'fontSpecimens.png');
  const pngSame = existsSync(pngPath) && readFileSync(pngPath).equals(png);
  if (!pngSame) {
    if (check) stale.push('components/comicstudio/lettering/fontSpecimens.png');
    else writeFileSync(pngPath, png);
  }
  if (check) {
    if (stale.length) {
      console.error(`stale (run npx tsx scripts/build-font-specimens.mjs):\n  ${stale.join('\n  ')}`);
      return 1;
    }
    console.log('font tables and specimens are up to date');
    return 0;
  }
  console.log(`wrote ${Object.keys(files).length} tables; sprite ${png.length} bytes (${rows.length} faces, ${statSync(pngPath).size} on disk)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack || err);
      process.exit(2);
    }
  );
}
