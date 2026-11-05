/**
 * @dreamstream/platform-render: the platform's light renderers (plan §4.2, W1.7).
 *
 * - `renderDocx(doc, opts)`: RichDoc v1 → `.docx` bytes, styled by a BrandKit.
 * - `renderPptx(deck, opts)`: DeckSpec v1 → `.pptx` bytes; refused while content elements overlap.
 * - `richdocFromMarkdown(md, opts)`: Markdown (CommonMark + GFM) → RichDoc v1, raw HTML and unsafe links dropped.
 *
 * None of them fetches a URL or reads a path: images are `data:` images, and a host asset id goes through the host's
 * own `resolveAsset`. In the browser, load this package only through `services/platformExport.ts`, which imports
 * `./docx.js`, `./pptx.js` and `./markdown.js` lazily, one chunk each, so `docx`, PptxGenJS and remark never reach the
 * entry chunk and an export loads only the renderer it uses.
 */
export { renderDocx, DOCX_STYLE_IDS } from './docx.js';
export type { DocxRenderOptions } from './docx.js';
export { renderPptx, contentOverlaps } from './pptx.js';
export type { PptxRenderOptions } from './pptx.js';
export { richdocFromMarkdown, MARKDOWN_MAX_CHARS } from './markdown.js';
export type { MarkdownOptions } from './markdown.js';
export { RenderError, isRenderError, RENDER_ERROR_CODES } from './errors.js';
export type { RenderErrorCode, SlideOverlap } from './errors.js';
export { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, decodeBase64, encodeBase64, imageSize, sniffImage } from './images.js';
export type { AssetResolver, ImageMime, ImageOptions, ImageTranscoder, PreparedImage } from './images.js';
export { DEFAULT_RENDER_BRAND, fontFamilyOf } from './style.js';
export type { FontFamilyResolver, RenderBrand, RenderDeckTheme, RenderDocStyles } from './style.js';

/** MIME types of the files the renderers write. */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
