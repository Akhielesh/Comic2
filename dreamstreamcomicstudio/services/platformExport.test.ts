// @vitest-environment jsdom
//
// services/platformExport.ts (plan §12 W1.7): the renderers are loaded lazily, only when a file is made (never by
// importing this module, and never through a static import that would pull them into the entry chunk), and every
// failure reaches the caller as the app's `ExportError` with a message written for the person exporting.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { DeckSpec } from '../packages/platform-core/src/contract/deck';
import type { RichDoc } from '../packages/platform-core/src/contract/richdoc';

const ROOT = resolve(__dirname, '..');
const fixture = <T>(rel: string): T => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as T;
const MINIMAL = fixture<RichDoc>('packages/platform-core/fixtures/contract/richdoc/minimal.json');
const FULL_DECK = fixture<DeckSpec>('packages/platform-core/fixtures/contract/deck/full.json');
const IMAGES = fixture<{ png: string }>('packages/platform-render/fixtures/render/images.json');

const RENDER_ENTRY = '../packages/platform-render/src/index';

/** The module under test and the error class it throws, from the same module graph (tests reset modules). */
const load = async () => ({ ...(await import('./platformExport')), ...(await import('../components/comicstudio/export/errors')) });

/** jsdom's Blob has no arrayBuffer(). */
const blobBytes = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(r.result as ArrayBuffer);
    r.onerror = () => fail(r.error);
    r.readAsArrayBuffer(blob);
  });

afterEach(() => {
  vi.doUnmock(RENDER_ENTRY);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('platformExport: the renderers load lazily', () => {
  it('imports no renderer statically: only `import type` and one dynamic import() of platform-render', () => {
    const file = resolve(ROOT, 'services/platformExport.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const staticRuntime: string[] = [];
    const dynamic: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const typeOnly = !!node.importClause && (node.importClause.isTypeOnly || (!node.importClause.name && !!node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every((e) => e.isTypeOnly)));
        if (!typeOnly) staticRuntime.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) dynamic.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(staticRuntime.filter((s) => /platform-render|platform-core|^docx$|unified|remark|pptxgen|jszip/.test(s))).toEqual([]);
    expect(dynamic).toEqual([RENDER_ENTRY]);
  });

  it('importing the module loads nothing; the first export loads the renderers once', async () => {
    let loads = 0;
    const renderDocx = vi.fn(async () => new Uint8Array([80, 75, 3, 4]));
    vi.doMock(RENDER_ENTRY, () => {
      loads++;
      return { renderDocx, renderPptx: vi.fn(), richdocFromMarkdown: vi.fn() };
    });
    const mod = await import('./platformExport');
    expect(loads).toBe(0);
    expect(mod.platformRenderRequested()).toBe(false);
    const file = await mod.exportDocx(MINIMAL);
    expect(loads).toBe(1);
    expect(mod.platformRenderRequested()).toBe(true);
    await mod.exportDocx(MINIMAL, { fileName: 'Second / copy?' });
    expect(loads).toBe(1);
    expect(renderDocx).toHaveBeenCalledTimes(2);
    expect(file).toMatchObject({ fileName: 'notes.docx', mime: mod.DOCX_MIME, size: 4 });
    expect(file.blob.type).toBe(mod.DOCX_MIME);
  });

  it('a chunk that fails to load is an ExportError, and the next export tries again', async () => {
    vi.doMock(RENDER_ENTRY, () => {
      throw new Error('the chunk is gone');
    });
    const mod = await load();
    await expect(mod.loadPlatformRender()).rejects.toBeInstanceOf(Error);
    expect(mod.platformRenderRequested()).toBe(false); // the failed load is forgotten, so the next export retries
    // How browsers report a dynamic import that could not be fetched (Chromium/Firefox, then Safari).
    for (const reason of ['Failed to fetch dynamically imported module: https://app.example/assets/render-abc.js', 'Importing a module script failed.']) {
      const err = (await mod.exportDocx(MINIMAL, { load: () => Promise.reject(new TypeError(reason)) }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(mod.ExportError);
      expect(err.message).toBe("Couldn't load the Word file maker. Check your connection and try again.");
    }
  });
});

describe('platformExport: failures map to ExportError', () => {
  const renderError = (code: string, message = 'renderer message', overlaps?: unknown[]) => Object.assign(new Error(message), { name: 'RenderError', code, overlaps });
  const failingLoad = (err: unknown) => async () => ({ renderDocx: async () => Promise.reject(err), renderPptx: async () => Promise.reject(err), richdocFromMarkdown: () => MINIMAL }) as never;

  it('each renderer refusal has its own message for people; the code and pairs stay readable', async () => {
    const { exportDocx, exportPptx, PlatformExportError, ExportError } = await load();
    const blocked = await exportDocx(MINIMAL, { load: failingLoad(renderError('blocked')) }).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ExportError);
    expect(blocked).toBeInstanceOf(PlatformExportError);
    expect((blocked as Error).message).toBe("This Word file can't include one of its images: only pictures already saved in your library can go into a download.");
    expect((blocked as InstanceType<typeof PlatformExportError>).renderCode).toBe('blocked');

    const pairs = [{ slideId: 's', slideNumber: 2, a: 'x', b: 'y', area: 0.1 }];
    const overlap = (await exportPptx(FULL_DECK, { load: failingLoad(renderError('overlap', 'Some things overlap on slide 2. Move them apart, then export again.', pairs)) }).catch((e: unknown) => e)) as InstanceType<typeof PlatformExportError>;
    expect(overlap.message).toBe('Some things overlap on slide 2. Move them apart, then export again.');
    expect(overlap.overlaps).toEqual(pairs);

    const big = (await exportDocx(MINIMAL, { load: failingLoad(renderError('too-large', 'The image is over 5 MB.')) }).catch((e: unknown) => e)) as InstanceType<typeof ExportError>;
    expect(big.code).toBe('too_big');
    for (const [code, text] of [
      ['asset-missing', "One of the images in this Word file couldn't be found. Try again, or remove that image."],
      ['unsupported', "One of the images is in a format that can't go into a Word file. Try again in another browser, or replace that image."],
      ['invalid', "This couldn't be turned into a Word file. Try again; if it keeps happening, tell us."],
    ]) {
      expect(((await exportDocx(MINIMAL, { load: failingLoad(renderError(code)) }).catch((e: unknown) => e)) as Error).message).toBe(text);
    }
    const unknown = (await exportPptx(FULL_DECK, { load: failingLoad(new RangeError('boom')) }).catch((e: unknown) => e)) as Error;
    expect(unknown).toBeInstanceOf(ExportError);
    expect(unknown.message).toBe('Something went wrong making the PowerPoint file. Try again.');
  });

  it('a file over maxBytes is too_big; an aborted export is cancelled before any work', async () => {
    const { exportDocx, ExportError, CANCELLED } = await load();
    const loader = vi.fn(async () => ({ renderDocx: async () => new Uint8Array(2 * 1000 * 1000) }) as never);
    const tooBig = (await exportDocx(MINIMAL, { load: loader, maxBytes: 1000 * 1000 }).catch((e: unknown) => e)) as InstanceType<typeof ExportError>;
    expect(tooBig.code).toBe('too_big');
    expect(tooBig.message).toBe('This Word file would be 2 MB, over the 1 MB limit. Try fewer pages or smaller pictures.');
    const ac = new AbortController();
    ac.abort();
    const cancelled = (await exportDocx(MINIMAL, { load: loader, signal: ac.signal }).catch((e: unknown) => e)) as Error;
    expect(cancelled).toBeInstanceOf(ExportError);
    expect(cancelled.message).toBe(CANCELLED);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('platformExport: real files', () => {
  it('exportDocx, exportPptx and exportMarkdownDocx make files Word and PowerPoint can open', async () => {
    const { exportDocx, exportMarkdownDocx, exportPptx, downloadPlatformFile, DOCX_MIME, PPTX_MIME } = await load();
    const docx = await exportDocx(MINIMAL);
    expect(docx.fileName).toBe('notes.docx');
    expect(Object.keys((await JSZip.loadAsync(await blobBytes(docx.blob))).files)).toContain('word/document.xml');
    const pptx = await exportPptx(FULL_DECK, { resolveAsset: () => IMAGES.png, transcode: async () => ({ bytes: new Uint8Array(Buffer.from(IMAGES.png.split(',')[1], 'base64')), mime: 'image/png' }) });
    expect(pptx).toMatchObject({ fileName: 'the-lighthouse-keeper-pitch.pptx', mime: PPTX_MIME });
    expect(Object.keys((await JSZip.loadAsync(await blobBytes(pptx.blob))).files)).toContain('ppt/slides/slide7.xml');
    const md = await exportMarkdownDocx('# Plan\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(md).toMatchObject({ fileName: 'plan.docx', mime: DOCX_MIME });
    const xml = await (await JSZip.loadAsync(await blobBytes(md.blob))).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:tbl>');
    expect(xml).not.toContain('alert');
    const saved: string[] = [];
    downloadPlatformFile(md, (_blob, name) => saved.push(name));
    expect(saved).toEqual(['plan.docx']);
  }, 30_000);

  it('the browser transcoder re-encodes WebP as PNG on a canvas, and as JPEG on white paper when the PNG is too big', async () => {
    const calls: string[] = [];
    let pngSize = 1000;
    class FakeCanvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return {
          drawImage: () => calls.push('draw'),
          fillRect: (_x: number, _y: number, w: number, h: number) => calls.push(`fill ${w}x${h}`),
          set globalCompositeOperation(v: string) { calls.push(`op ${v}`); },
          set fillStyle(v: string) { calls.push(`style ${v}`); },
        };
      }
      async convertToBlob(o: { type: string; quality?: number }) {
        calls.push(`encode ${o.type}${o.quality ? ` ${o.quality}` : ''}`);
        const bytes = o.type === 'image/png' ? new Uint8Array(pngSize) : new Uint8Array([0xff, 0xd8, 0xff]);
        return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    vi.stubGlobal('createImageBitmap', async () => ({ width: 40, height: 30, close: () => calls.push('close') }));
    try {
      const { browserTranscoder, TRANSCODE_PNG_MAX_BYTES } = await load();
      const t = browserTranscoder()!;
      const small = await t({ bytes: new Uint8Array([1]), mime: 'image/webp' });
      expect(small.mime).toBe('image/png');
      expect(calls).toEqual(['draw', 'encode image/png', 'close']);
      calls.length = 0;
      pngSize = TRANSCODE_PNG_MAX_BYTES + 1;
      const big = await t({ bytes: new Uint8Array([1]), mime: 'image/webp' });
      expect(big).toEqual({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: 'image/jpeg' });
      expect(calls).toEqual(['draw', 'encode image/png', 'op destination-over', 'style #ffffff', 'fill 40x30', 'encode image/jpeg 0.92', 'close']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a WebP image without a canvas transcoder (jsdom has no createImageBitmap) is a clear refusal', async () => {
    const { exportDocx, browserTranscoder, ExportError } = await load();
    expect(browserTranscoder()).toBeUndefined();
    const webpDoc: RichDoc = { v: 1, title: 'W', sections: [{ id: 's', pageBreakBefore: false, blocks: [{ type: 'image', id: 'i', alt: 'w', ref: { kind: 'data', dataUri: fixture<{ webp: string }>('packages/platform-render/fixtures/render/images.json').webp } }] }] };
    const err = (await exportDocx(webpDoc).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toContain("can't go into a Word file");
  });
});
