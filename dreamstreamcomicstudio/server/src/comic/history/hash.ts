// Comic History — content addressing of a book (versions plan §3.1 "Hashing", §3.2; package H1).
//
// chunkBook(doc) = splitSections(doc) → sectionChunks(s): every section's canonical text is
// sectionContent(body) (stableStringify: sorted keys, undefined dropped) — RAW, exactly as stored and hashed.
// semanticSectionContent (diff.ts) is only for comparisons, never for stored hashes or the manifest.
//
//   hash      sha256(content) hex, first 32 characters (128 bits, per comic: chunks are keyed by (project, hash)).
//             The database re-checks it on insert (comic_version_chunks_verify) and get() re-checks it on read.
//   manifest  buildManifest(s, chunk → hash): page order is the array order, so a reorder changes only the manifest.
//   rootHash  sha256/128 of stableStringify(manifest): equal roots mean the same book (the put RPC dedupes on it).
//   paths     the image GC roots in one chunk: every string leaf with a '/', trimmed, ≤ 512 characters, never
//             data:/http(s):/blob:, ≤ 400 per chunk (storage-path-shaped strings first). The same rule as the
//             database's broad `$.**` scan, so history keeps exactly what it references alive.
//
// Cost: hashing runs only at capture time. A WeakMap keyed by object identity caches {content, hash, paths}: docs are
// immutable and applyOps shares every unchanged page, character, option… by reference, so an unchanged page costs
// one lookup. splitSections builds fresh wrapper objects (page text = the page minus {n, render, balloons}), so the
// cache is anchored on the doc's own objects that each section is a pure function of (the page for `page:`/`art:`,
// the character for `char:`, the edition plus the page for `edp:`…), never on the wrappers.

import { createHash } from 'node:crypto';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { stableStringify } from '../../../../shared/comic/hash.js';
import {
  buildManifest,
  joinSections,
  manifestKeyHashes,
  parseSectionKey,
  sectionChunks,
  sectionContent,
  sectionsFromManifest,
  splitSections,
  type SectionChunk
} from '../../../../shared/comic/history/sections.js';
import type { Manifest } from '../../../../shared/comic/history/types.js';
import type { ChunkInput } from './storeTypes.js';

/** Hex characters kept from the sha256 (128 bits). */
export const HISTORY_HASH_CHARS = 32;
export const HISTORY_HASH_RE = /^[0-9a-f]{32}$/;
/** comic_version_chunks.paths cardinality cap. */
export const CHUNK_PATHS_MAX = 400;
/** A GC root longer than this is not a storage path. */
export const CHUNK_PATH_MAX_CHARS = 512;
/** comic_version_chunks.content cap for v5 chunks (bytes, UTF-8). */
export const CHUNK_CONTENT_MAX_BYTES = 1_048_576;
/** comic_versions.manifest cap (bytes of its JSON). */
export const MANIFEST_MAX_BYTES = 262_144;

/** sha256(content) as UTF-8, hex, first 32 characters — what comic_version_chunks_verify recomputes. */
export const historyHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex').slice(0, HISTORY_HASH_CHARS);

export const isHistoryHash = (value: unknown): value is string => typeof value === 'string' && HISTORY_HASH_RE.test(value);

/** The root hash of a manifest (sha256/128 of its canonical JSON). */
export const rootHashOf = (manifest: Manifest): string => historyHash(stableStringify(manifest));

// ── The paths rule ───────────────────────────────────────────────────────────

const NOT_A_PATH = /^(?:data|https?|blob):/i;
const WHITESPACE = /\s/;
const MAX_WALK_DEPTH = 200;

/** One string as a GC root (trimmed), or null: needs a '/', ≤ 512 characters, never data:/http(s):/blob:. */
export const gcRootOf = (value: string): string | null => {
  const s = value.trim();
  if (!s || s.length > CHUNK_PATH_MAX_CHARS || !s.includes('/') || NOT_A_PATH.test(s)) return null;
  return s;
};

/**
 * The image GC roots in a section body: every string leaf (object values and array items, never keys) that passes
 * gcRootOf. Sorted, unique, at most CHUNK_PATHS_MAX — storage-path-shaped strings (no whitespace) first, so a page of
 * dialogue full of "and/or" can never crowd a real image path out.
 */
export const chunkPaths = (body: unknown): string[] => {
  const found = new Set<string>();
  const stack: { v: unknown; d: number }[] = [{ v: body, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (typeof v === 'string') {
      const p = gcRootOf(v);
      if (p) found.add(p);
    } else if (v && typeof v === 'object' && d < MAX_WALK_DEPTH) {
      const values = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
      for (const x of values) stack.push({ v: x, d: d + 1 });
    }
  }
  const all = [...found].sort();
  if (all.length <= CHUNK_PATHS_MAX) return all;
  const pathLike = all.filter((p) => !WHITESPACE.test(p));
  const prose = all.filter((p) => WHITESPACE.test(p));
  return [...pathLike, ...prose].slice(0, CHUNK_PATHS_MAX).sort();
};

// ── The identity cache ───────────────────────────────────────────────────────

interface CacheEntry {
  content: string;
  hash: string;
  paths: string[];
  /** A second object the section also depends on (the page of an `edp:`, the page list of an `ed:`). */
  dep: unknown;
}

/** A WeakMap of {content, hash, paths} keyed by the doc's own (immutable) objects. Counts hits for tests and logs. */
export class ChunkCache {
  private readonly map = new WeakMap<object, Map<string, CacheEntry>>();
  hits = 0;
  misses = 0;

  get(anchor: object, slot: string, dep: unknown): CacheEntry | undefined {
    const hit = this.map.get(anchor)?.get(slot);
    if (hit && hit.dep === dep) {
      this.hits += 1;
      return hit;
    }
    this.misses += 1;
    return undefined;
  }

  set(anchor: object, slot: string, entry: CacheEntry): void {
    let slots = this.map.get(anchor);
    if (!slots) {
      slots = new Map();
      this.map.set(anchor, slots);
    }
    slots.set(slot, entry);
  }
}

/** The process-wide cache (weak: it never keeps a doc alive). */
export const defaultChunkCache = new ChunkCache();

interface Anchor {
  obj: object;
  slot: string;
  dep?: unknown;
}

const isObject = (v: unknown): v is object => !!v && typeof v === 'object';

/** section key → the doc object(s) its body is a pure function of (see the header). `meta` has none. */
const anchorsOf = (doc: ComicDoc): Map<string, Anchor> => {
  const out = new Map<string, Anchor>();
  /** Keys seen twice (duplicate ids): their section is not a function of one object, so they are never cached. */
  const twice = new Set<string>();
  const put = (key: string, obj: unknown, slot: string, dep?: unknown) => {
    if (out.has(key) || twice.has(key)) {
      out.delete(key);
      twice.add(key);
      return;
    }
    if (isObject(obj)) out.set(key, { obj, slot, dep });
  };
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const pagesById = new Map(pages.map((p) => [p.id, p]));
  put('source', doc.source, 'source');
  put('style', doc.style, 'style');
  put('cover', doc.cover, 'cover');
  put('places', doc.places, 'places');
  if (doc.i18n) put('glossary', doc.i18n.glossary, 'glossary');
  for (const o of doc.style?.options || []) put(`option:${o.id}`, o, 'option');
  for (const c of doc.cast || []) put(`char:${c.id}`, c, 'char');
  for (const p of pages) {
    put(`page:${p.id}`, p, 'page');
    put(`art:${p.id}`, p, 'art');
  }
  for (const [lang, edition] of Object.entries(doc.i18n?.editions || {})) {
    put(`ed:${lang}`, edition, 'ed', pages);
    for (const p of pages) put(`edp:${lang}:${p.id}`, edition, `edp:${p.id}`, pagesById.get(p.id));
  }
  if (Array.isArray(doc.archive)) {
    const blocks = Math.ceil(doc.archive.length / 32) + 1;
    for (let n = 0; n < blocks; n += 1) put(`archive:${n}`, doc.archive, `archive:${n}`);
  }
  for (const t of doc.trash || []) if (t?.page?.id !== undefined) put(`trash:${t.page.id}`, t, 'trash');
  return out;
};

// ── chunkBook ────────────────────────────────────────────────────────────────

/** One stored chunk of a book (ChunkInput) plus the section keys it serves (identical bodies share one chunk). */
export interface BookChunk extends ChunkInput {
  keys: string[];
}

export interface ChunkedBook {
  manifest: Manifest;
  rootHash: string;
  /** One per distinct hash, in section order. */
  chunks: BookChunk[];
  /** Every hash the manifest references (= chunks.map(c => c.hash)): VersionInput.chunks. */
  hashes: string[];
  /** Sum of the chunks' UTF-8 sizes (what a first capture would upload). */
  bytes: number;
}

export interface ChunkBookOptions {
  /** Default: the process-wide defaultChunkCache. Pass `false` to hash everything afresh. */
  cache?: ChunkCache | false;
}

/**
 * The doc as content-addressed chunks, its manifest and root hash (§3.1). Pure apart from the identity cache. The
 * doc is never modified; excluded keys (conversation, spend, settings…) never reach a chunk.
 */
export const chunkBook = (doc: ComicDoc, opts: ChunkBookOptions = {}): ChunkedBook => {
  const cache = opts.cache === false ? null : opts.cache ?? defaultChunkCache;
  const sections = splitSections(doc);
  const anchors = cache ? anchorsOf(doc) : new Map<string, Anchor>();
  const byKey = new Map<string, CacheEntry>();
  const entryOf = (chunk: SectionChunk): CacheEntry => {
    const known = byKey.get(chunk.key);
    if (known) return known;
    const anchor = anchors.get(chunk.key);
    let entry = anchor && cache ? cache.get(anchor.obj, anchor.slot, anchor.dep) : undefined;
    if (!entry) {
      const content = sectionContent(chunk.body);
      entry = { content, hash: historyHash(content), paths: chunkPaths(chunk.body), dep: anchor?.dep };
      if (anchor && cache) cache.set(anchor.obj, anchor.slot, entry);
    }
    byKey.set(chunk.key, entry);
    return entry;
  };
  const manifest = buildManifest(sections, (chunk) => entryOf(chunk).hash);
  const chunks: BookChunk[] = [];
  const byHash = new Map<string, BookChunk>();
  let bytes = 0;
  for (const chunk of sectionChunks(sections)) {
    const entry = entryOf(chunk);
    const seen = byHash.get(entry.hash);
    if (seen) {
      if (!seen.keys.includes(chunk.key)) seen.keys.push(chunk.key);
      continue;
    }
    const out: BookChunk = { hash: entry.hash, kind: chunk.kind, content: entry.content, paths: entry.paths, keys: [chunk.key] };
    byHash.set(entry.hash, out);
    chunks.push(out);
    bytes += Buffer.byteLength(entry.content, 'utf8');
  }
  return { manifest, rootHash: rootHashOf(manifest), chunks, hashes: chunks.map((c) => c.hash), bytes };
};

// ── Reading back ─────────────────────────────────────────────────────────────

/** Every distinct chunk hash a manifest references (sorted). */
export const manifestHashes = (manifest: Manifest): string[] => [...new Set(Object.values(manifestKeyHashes(manifest)))].sort();

/**
 * A stored chunk's body, only when its content still hashes to `hash` (read-side verification, §12) and parses.
 * undefined otherwise: the caller treats it as missing ("This version can't be opened. Nothing in your comic changed.").
 */
export const parseVerifiedChunk = (hash: string, content: unknown): unknown => {
  if (!isHistoryHash(hash) || typeof content !== 'string' || historyHash(content) !== hash) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * A version as a doc: sectionsFromManifest(manifest, bodies) → joinSections(sections, frame) → normalizeDoc. The frame
 * is excludedOf(liveDoc) for a restore, or versionFrame(id, at) for a standalone read. null when any chunk is missing.
 */
export const assembleBook = (
  manifest: Manifest,
  bodies: ReadonlyMap<string, unknown>,
  frame: Parameters<typeof joinSections>[1]
): ComicDoc | null => {
  const sections = sectionsFromManifest(manifest, (hash) => bodies.get(hash));
  return sections ? joinSections(sections, frame) : null;
};

/** The section kind of a chunk key, for logs ('page', 'edp'…). */
export const chunkKindOfKey = (key: string): string | null => parseSectionKey(key)?.kind ?? null;
