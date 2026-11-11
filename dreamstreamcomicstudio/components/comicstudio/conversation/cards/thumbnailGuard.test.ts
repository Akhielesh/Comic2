// @vitest-environment node
/**
 * Thumbnail guard (PF-2; perf F2 "a source guard test"): conversation art is small (22–200 px), so no source in
 * components/comicstudio/conversation/** may ask the signer for an image without a width — `urlFor(asset)` hands
 * back the full-size original (≈ 330 KB, 6–14 MB decoded) where the 480w variant (≈ 34 KB) would do — nor with a
 * literal width above the 480w thumbnail (`urlFor(asset, { width: 4000 })` is the original by another name). Use
 * `tileSources(urlFor, asset)` (cards/renderTile.tsx) or `urlFor(asset, { width })` with a width ≤ 480.
 *
 * The allowlist pins each remaining use by its exact trimmed source line, with the reason; an entry whose line is
 * gone fails too, so the list only shrinks.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const APP = path.resolve(ROOT, '../../..');

const ALLOWLIST: Record<string, { line: string; reason: string }[]> = {
  'components/comicstudio/conversation/MessageItem.tsx': [
    {
      line: "const attachmentSrc = (a: AssetRef | PendingAttachment, urlFor: UserBubbleProps['urlFor']) => (isPending(a) ? a.dataUrl : urlFor(a));",
      reason: 'a user photo in the bubble (64 px); SETTLE-UI owns MessageItem in S2 and takes tileSources by wave note'
    }
  ]
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });

/** The thumbnail's width (board/ImageFrame THUMB_MAX_W): conversation art never needs a bigger file. */
const THUMB_MAX_W = 480;
/** A literal width in a call's options (`{ width: 4000 }`, `width: 1_080`). */
const LITERAL_WIDTH = /\bwidth\s*:\s*(\d[\d_]*)/;

/**
 * Calls of `urlFor(` / `x.urlFor(` that fetch more than a thumbnail: ONE argument (no options), or options with a
 * literal `width` above 480. One trimmed source line per call. Declarations are skipped.
 */
export const widthlessUrlFor = (source: string): string[] => {
  const hits: string[] = [];
  const re = /\burlFor\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let topComma = false;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 1) topComma = true;
    }
    const args = source.slice(start, i - 1).trim();
    // `urlFor(asset?: AssetRef | string | null, …): string` and `urlFor(path: string)` are signatures, not calls.
    if (!args || /^\w+\??\s*:/.test(args)) continue;
    const literal = LITERAL_WIDTH.exec(args);
    if (topComma && !(literal && Number(literal[1].replace(/_/g, '')) > THUMB_MAX_W)) continue;
    const lineStart = source.lastIndexOf('\n', m.index) + 1;
    const lineEnd = source.indexOf('\n', m.index);
    hits.push(source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim());
  }
  return hits;
};

describe('thumbnail guard (conversation art asks for a width)', () => {
  it('finds widthless calls and ignores signatures and calls with options', () => {
    expect(widthlessUrlFor('const a = urlFor(c.sheet.asset);\nconst b = studio.urlFor(x, { width: 240 });')).toEqual(['const a = urlFor(c.sheet.asset);']);
    expect(widthlessUrlFor('interface P { urlFor(path: string): string | undefined; urlFor(asset?: AssetRef): string }')).toEqual([]);
    expect(widthlessUrlFor('f(urlFor(render?.asset), urlFor(a, opts))')).toEqual(['f(urlFor(render?.asset), urlFor(a, opts))']);
  });

  it('a literal width above the 480w thumbnail is a full-size request too', () => {
    expect(widthlessUrlFor('const u = studio.urlFor(o.render.asset, { width: 4000 });')).toEqual(['const u = studio.urlFor(o.render.asset, { width: 4000 });']);
    expect(widthlessUrlFor('const u = urlFor(a, { width: 1_080 });')).toEqual(['const u = urlFor(a, { width: 1_080 });']);
    expect(widthlessUrlFor('const u = urlFor(a, { width: 480 });\nconst v = urlFor(a, { width: 64 });\nconst w = urlFor(a, { width: cssW });')).toEqual([]);
  });

  it('no conversation source asks for a full-size original outside the pinned allowlist', () => {
    const found: Record<string, string[]> = {};
    for (const file of sources(ROOT)) {
      const hits = widthlessUrlFor(readFileSync(file, 'utf8'));
      if (hits.length) found[path.relative(APP, file).split(path.sep).join('/')] = hits;
    }
    const unexpected = Object.entries(found).flatMap(([file, lines]) => lines.filter((l) => !(ALLOWLIST[file] || []).some((a) => a.line === l)).map((l) => `${file}: ${l}`));
    const stale = Object.entries(ALLOWLIST).flatMap(([file, entries]) => entries.filter((a) => !(found[file] || []).includes(a.line)).map((a) => `${file}: ${a.line}`));
    expect(unexpected, 'use tileSources(urlFor, asset) or urlFor(asset, { width })').toEqual([]);
    expect(stale, 'fixed: remove the allowlist entry').toEqual([]);
  });
});
