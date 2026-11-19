// @vitest-environment node
// The featured comics: the flagship's link is written once, in flagship.ts, and opens the English edition through its
// public share link on the comics host; the second comic is a share link too. No other source file spells either slug.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURED, FLAGSHIP, SECOND } from './flagship';

const APP = path.resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', 'dist-qa', '.git', 'public', 'docs']);
const sources = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(name) && !name.startsWith('.')) sources(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
};

describe('featured comics', () => {
  it('the flagship is "Brick Legends: Rama Setu", its share link with the English edition', () => {
    expect(FLAGSHIP.title).toBe('Brick Legends: Rama Setu');
    expect(FLAGSHIP.href).toBe('https://comics.dreamstreamstudio.ai/c/GnXtWqO2iUh4l8g7M?lang=en');
    const url = new URL(FLAGSHIP.href);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('comics.dreamstreamstudio.ai');
    expect(url.pathname).toMatch(/^\/c\/[A-Za-z0-9]{17}$/);
    expect(url.searchParams.get('lang')).toBe('en');
    expect(FLAGSHIP.english).toBe(true);
  });

  it('every featured comic is a public share link on the comics host, flagship first, each with its own line', () => {
    expect(FEATURED[0]).toBe(FLAGSHIP);
    expect(FEATURED).toContain(SECOND);
    for (const comic of FEATURED) {
      const url = new URL(comic.href);
      expect(url.host).toBe('comics.dreamstreamstudio.ai');
      expect(url.pathname).toMatch(/^\/c\/[A-Za-z0-9]{17}$/);
      expect(comic.title.trim()).not.toBe('');
      expect(comic.line.trim()).not.toBe('');
    }
  });

  it('each slug is written in one constant: no other app source spells it', () => {
    const owners = new Set([path.join(__dirname, 'flagship.ts'), path.join(__dirname, 'flagship.test.ts')]);
    for (const comic of FEATURED) {
      const slug = new URL(comic.href).pathname.split('/').pop()!;
      const hits = sources(APP).filter((f) => !owners.has(f) && readFileSync(f, 'utf8').includes(slug));
      expect(hits.map((f) => path.relative(APP, f)), slug).toEqual([]);
    }
  });
});
