// Test helpers for the library pipeline (no network, no spend): a fake image generator that
// returns real PNGs of the requested shape, vision replies, memory storage and wired deps.

import sharp from 'sharp';
import type { AspectRatio } from '../../../../shared/comic/doc.js';
import { aspectRatioOf } from '../../../../shared/comic/models.js';
import type { ImageRequest, ImageResult, LlmClient, LlmRequest, LlmResult, StudioKeys } from '../types.js';
import type { LibraryManifestEntry } from './manifest.js';
import { createMemoryLibraryRepo, type MemoryLibraryRepo } from './repo.js';
import type { LibraryDeps, LibraryStorage } from './runner.js';

export const TEST_KEYS: StudioKeys = { openrouter: { key: 'sk-or-test', byok: false } };

/** A noisy (never blank) PNG data URL; `mean` sets the luminance (0–255). */
export async function pngDataUrl(w: number, h: number, mean = 150): Promise<string> {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: mean, g: mean, b: mean }, noise: { type: 'gaussian', mean, sigma: 40 } } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const sizeFor = (aspect: AspectRatio, long = 320) => {
  const r = aspectRatioOf(aspect) || 1;
  return r >= 1 ? { w: long, h: Math.round(long / r) } : { w: Math.round(long * r), h: long };
};

export type ImageBehaviour = (req: ImageRequest, call: number) => { aspect?: AspectRatio; mean?: number; costUsd?: number } | Error | Promise<never> | undefined;

export interface FakeLibraryImages {
  calls: ImageRequest[];
  generate: (req: ImageRequest) => Promise<ImageResult>;
}

export function fakeLibraryImages(behave?: ImageBehaviour): FakeLibraryImages {
  const out: FakeLibraryImages = {
    calls: [],
    async generate(req) {
      out.calls.push(req);
      const b = behave?.(req, out.calls.length);
      if (b instanceof Promise) return b;
      if (b instanceof Error) throw b;
      const { w, h } = sizeFor(b?.aspect || req.aspect);
      return { dataUrl: await pngDataUrl(w, h, b?.mean ?? 150), model: req.spec.id, route: 'openrouter', byok: false, costUsd: b?.costUsd ?? 0.0336, latencyMs: 5 };
    }
  };
  return out;
}

export interface VisionScore {
  score?: number;
  briefMatch?: number;
  styleMatch?: number;
  technical?: number;
  textFound?: string[];
  panelCount?: number;
  watermarkOrSignature?: boolean;
}

export const visionJson = (v: VisionScore = {}) => ({
  caption: 'A girl and her dog on a canal bridge at dusk.',
  altText: 'A girl in a raincoat and her terrier on a stone bridge at dusk.',
  tags: ['dusk', 'canal'],
  subjects: ['girl', 'dog', 'bridge'],
  textFound: v.textFound ?? [],
  watermarkOrSignature: v.watermarkOrSignature ?? false,
  panelCount: v.panelCount ?? 0,
  briefMatch: v.briefMatch ?? v.score ?? 0.9,
  styleMatch: v.styleMatch ?? v.score ?? 0.9,
  technical: v.technical ?? v.score ?? 0.9,
  issues: [],
  score: v.score ?? 0.9
});

export interface FakeLibraryLlm extends LlmClient {
  calls: LlmRequest[];
}

/** Vision replies in order (the last one repeats); writer calls answer `rewrite`. */
export function fakeLibraryLlm(vision: Array<VisionScore | Error | 'garbage'> = [{}], rewrite = 'A rewritten prompt that keeps every subject and the style exactly as described.'): FakeLibraryLlm {
  let i = 0;
  const llm: FakeLibraryLlm = {
    calls: [],
    async complete(req) {
      llm.calls.push(req);
      const base: LlmResult = { text: '', model: `fake-${req.role}`, costUsd: 0.002, byok: false, provider: 'openrouter' };
      if (req.role === 'writer') return { ...base, json: { prompt: rewrite } };
      const step = vision[Math.min(i, vision.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      if (step === 'garbage') return { ...base, text: 'not json at all' };
      return { ...base, json: visionJson(step) };
    }
  };
  return llm;
}

export interface MemoryStorage extends LibraryStorage {
  objects: Map<string, Buffer>;
  loads: string[];
  removed: string[];
}

export function memoryStorage(): MemoryStorage {
  const s: MemoryStorage = {
    objects: new Map(),
    loads: [],
    removed: [],
    async put(path, buffer) {
      s.objects.set(path, buffer);
    },
    async loadDataUrl(path) {
      s.loads.push(path);
      const b = s.objects.get(path);
      if (!b) throw new Error(`missing ${path}`);
      return `data:image/webp;base64,${b.toString('base64')}`;
    },
    async remove(paths) {
      for (const p of paths) {
        s.removed.push(p);
        s.objects.delete(p);
      }
    },
    publicUrl: (path) => `https://cdn.test/storage/v1/object/public/comic-assets/${path}`
  };
  return s;
}

/** Five small, fast entries (1K, 1:1) for runner tests. */
export const TEST_MANIFEST: LibraryManifestEntry[] = ['one', 'two', 'three', 'four', 'five'].map((slug) => ({
  id: `style.test-${slug}`,
  kind: 'style_preview',
  prompt: `Test scene ${slug}. No text, no letters, no numbers, no speech balloons, no captions, no signage lettering, no logos, no signature, no watermark.`,
  model: 'nano-banana-2.1',
  resolution: '1K',
  aspect: '1:1',
  theme: 'any',
  presetId: 'noir-ink',
  tags: ['test'],
  alt: `Test asset ${slug}`
}));

export interface TestLibrary {
  deps: LibraryDeps;
  repo: MemoryLibraryRepo;
  storage: MemoryStorage;
  images: FakeLibraryImages;
  llm: FakeLibraryLlm;
  clock: { now: number };
  published: number;
}

export function testLibrary(opts: { images?: FakeLibraryImages; llm?: FakeLibraryLlm; keys?: StudioKeys | null; manifest?: LibraryManifestEntry[] } = {}): TestLibrary {
  const clock = { now: Date.parse('2026-10-22T10:00:00.000Z') };
  const repo = createMemoryLibraryRepo({ now: () => clock.now });
  const storage = memoryStorage();
  const images = opts.images || fakeLibraryImages();
  const llm = opts.llm || fakeLibraryLlm();
  const t: TestLibrary = {
    repo,
    storage,
    images,
    llm,
    clock,
    published: 0,
    deps: {
      repo,
      storage,
      keys: () => (opts.keys === undefined ? TEST_KEYS : opts.keys),
      images: () => images.generate,
      llm: () => llm,
      now: () => clock.now,
      bucket: 'comic-assets',
      manifest: opts.manifest || TEST_MANIFEST,
      onPublishedChange: () => {
        t.published += 1;
      }
    }
  };
  return t;
}
