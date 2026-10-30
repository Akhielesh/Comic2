/**
 * Test helpers for the renderers (not shipped: tsconfig.json and the purity test leave `*.testkit.ts` out). Reads
 * fixtures, unzips outputs and normalises them into golden text: every part name, the XML of the parts that carry
 * content (one tag per line), and the sha256 of each media file. Run-to-run noise is normalised: timestamps, the
 * random relationship ids docx gives hyperlinks, chart GUIDs, and PptxGenJS's process-wide chart counter.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { RenderBrand } from './style.js';

/** A path relative to this file (src/); never pass a literal to `new URL(…, import.meta.url)` in tests, Vite rewrites those. */
export const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** A file under packages/platform-render/fixtures/render. */
export const renderFixturePath = (name: string): string => here(`../fixtures/render/${name}`);
export const renderFixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(renderFixturePath(name), 'utf8')) as T;
export const renderFixtureText = (name: string): string => readFileSync(renderFixturePath(name), 'utf8');

/** A file under packages/platform-core/fixtures/contract (the frozen contract by example). */
export const contractFixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(here(`../../platform-core/fixtures/contract/${name}`), 'utf8')) as T;

export const IMAGES = renderFixture<{ png: string; jpeg: string; webp: string }>('images.json');
export const BRAND = renderFixture<RenderBrand & { note?: string }>('brand.json');

/** The installed family names of the registry ids the fixtures use (what platformFont(id).family answers). */
export const FAMILIES = (id: string): string | undefined =>
  (({ 'space-grotesk': 'Space Grotesk', 'ibm-plex-sans': 'IBM Plex Sans', inter: 'Inter' }) as { [k: string]: string })[id];

export const base64Bytes = (dataUri: string): Uint8Array => new Uint8Array(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64'));

/** A stand-in for the browser's canvas transcoder: any WebP becomes the PNG fixture. */
export const fakeTranscode = async (): Promise<{ bytes: Uint8Array; mime: 'image/png' }> => ({ bytes: base64Bytes(IMAGES.png), mime: 'image/png' });

/** Every part of a zip (docx/pptx), by name. */
export const zipParts = async (bytes: Uint8Array): Promise<{ [name: string]: Uint8Array }> => {
  const zip = await JSZip.loadAsync(bytes);
  const out: { [name: string]: Uint8Array } = {};
  for (const name of Object.keys(zip.files).sort()) {
    const f = zip.files[name];
    if (!f.dir) out[name] = await f.async('uint8array');
  }
  return out;
};

export const text = (parts: { [name: string]: Uint8Array }, name: string): string => {
  const p = parts[name];
  if (!p) throw new Error(`no part ${name}; parts: ${Object.keys(parts).join(', ')}`);
  return Buffer.from(p).toString('utf8');
};

/** Parses XML with the DOM's strict XML parser; throws on a malformed part. */
export const parseXml = (xml: string, name = 'part'): Document => {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const err = dom.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`${name} is not well-formed XML: ${err.textContent}`);
  return dom;
};

const XML_PART = /\.(xml|rels)$/;

/** Which parts a golden prints in full (the rest are listed by name, media by hash). */
const GOLDEN_PARTS = [
  /^\[Content_Types\]\.xml$/,
  /^docProps\/(core|app)\.xml$/,
  /^word\/(document|styles|numbering)\.xml$/,
  /^word\/_rels\/document\.xml\.rels$/,
  /^ppt\/presentation\.xml$/,
  /^ppt\/theme\/theme1\.xml$/,
  /^ppt\/slides\/slide\d+\.xml$/,
  /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/,
  /^ppt\/charts\/chart\d+\.xml$/,
  /^ppt\/notesSlides\/notesSlide\d+\.xml$/,
];

const MEDIA = /^(word|ppt)\/media\//;

/**
 * The golden text of a docx/pptx: deterministic for the same input whatever ran before it in the process.
 */
export const goldenOf = async (bytes: Uint8Array, title: string): Promise<string> => {
  const parts = await zipParts(bytes);
  const names = Object.keys(parts);
  // PptxGenJS numbers charts with a module-wide counter: renumber them 1..n in order.
  const chartNums = names
    .map((n) => /^ppt\/charts\/chart(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const chartMap: { [n: string]: number } = {};
  chartNums.forEach((n, i) => (chartMap[String(n)] = i + 1));
  const ids: { [id: string]: string } = {};
  const stable = (kind: string, raw: string): string => {
    const key = `${kind}:${raw}`;
    if (!ids[key]) ids[key] = `${kind}${Object.keys(ids).filter((k) => k.lastIndexOf(`${kind}:`, 0) === 0).length + 1}`;
    return ids[key];
  };
  const norm = (s: string): string =>
    s
      .replace(/(chart|Microsoft_Excel_Worksheet)(\d+)(\.xml|\.xlsx)/g, (_m, p: string, n: string, ext: string) => `${p}${chartMap[n] !== undefined ? chartMap[n] : n}${ext}`)
      .replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:)/g, '$1(time)$2')
      .replace(/\brId[A-Za-z0-9_-]{12,}/g, (m) => stable('rIdRandom', m))
      .replace(/\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g, (m) => stable('GUID', m.replace(/[{}]/g, '').toUpperCase()));
  const out: string[] = [
    `# ${title}`,
    '# Normalised parts of the rendered file (see render.testkit.ts). Regenerate on purpose only:',
    '#   UPDATE_GOLDENS=1 npx vitest run packages/platform-render/src/golden.test.ts',
    '',
    '## parts',
    ...names.map((n) => norm(n)),
  ];
  for (const name of names) {
    const shown = norm(name);
    if (MEDIA.test(name)) {
      out.push('', `## ${shown} sha256=${createHash('sha256').update(parts[name]).digest('hex')} bytes=${parts[name].length}`);
    } else if (XML_PART.test(name) && GOLDEN_PARTS.some((re) => re.test(name))) {
      out.push('', `## ${shown}`, norm(text(parts, name)).replace(/>\s*</g, '>\n<').trim());
    }
  }
  return `${out.join('\n')}\n`;
};
