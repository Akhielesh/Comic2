import { describe, expect, it } from 'vitest';
import { MAX_SVG_BYTES, STATIC_SVG_HELP, staticSvgImage } from './staticSvg';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (body: string, attrs = '') => `<svg xmlns="${SVG_NS}" viewBox="0 0 200 100" ${attrs}>${body}</svg>`;
const encode = (source: string) => new TextEncoder().encode(source);

async function markup(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('static SVG input for rasterization', () => {
  it('accepts normal geometry, fragment gradients and clipping, and bounds the decoded viewport', async () => {
    const doc = svg(`
      <defs><linearGradient id="paint"><stop offset="0%" stop-color="#123"/><stop offset="100%" stop-color="#456"/></linearGradient>
      <clipPath id="crop"><circle cx="55" cy="50" r="45"/></clipPath></defs>
      <g transform="translate(2, 3)" clip-path="url(#crop)"><path d="M0,0L100,0L100,100Z" fill="url(#paint)"/></g>
    `);
    const result = staticSvgImage(encode(`<?xml version="1.0" encoding="UTF-8"?>${doc}`), 2048);
    expect(result.type).toBe('image/svg+xml');
    expect(await markup(result)).toContain('width="2048" height="1024"');
    expect(await markup(result)).toContain('fill="url(#paint)"');
  });

  it('adds a namespace and viewBox to otherwise valid geometry', async () => {
    const result = staticSvgImage(encode('<svg width="300" height="200"><rect width="1" height="1"/></svg>'), 2048);
    const parsed = new DOMParser().parseFromString(await markup(result), 'image/svg+xml');
    expect(parsed.documentElement.namespaceURI).toBe(SVG_NS);
    expect(parsed.documentElement.getAttribute('viewBox')).toBe('0 0 300 200');
  });

  it.each([
    svg('<script/>'), svg('<foreignObject/>'), svg('<image href="https://example.com/image.png"/>'), svg('<animate/>'),
    svg('<use href="#shape"/>'), svg('<style>@import "https://example.com/external";</style>'),
    svg('<path d="M0 0" onload="run()"/>'), svg('<path d="M0 0" style="fill:#fff"/>'),
    svg('<rect fill="url(https://example.com/gradient)"/>'), svg('<rect fill="url(&#x68;ttps://example.com/gradient)"/>'),
    svg('<rect clip-path="url(#missing)"/>'), svg('<rect id="x"/><circle id="x"/>'),
    svg('<defs><clipPath id="x"><rect clip-path="url(#x)"/></clipPath></defs>'),
    svg('<svg viewBox="0 0 1 1"/>'), svg('<rect xmlns="http://example.com/foreign"/>'),
    `<?xml-stylesheet href="https://example.com/external"?>${svg('')}`,
    `<!DOCTYPE svg [<!ENTITY x SYSTEM "https://example.com/entity">]>${svg('<title>&x;</title>')}`,
    '<svg viewBox="0 0 0 100"/>', '<svg width="1e99" height="1"/>', '<svg><path></svg>'
  ])('rejects unsupported or active SVG before decode (%s)', (input) => {
    expect(() => staticSvgImage(encode(input), 2048)).toThrow(STATIC_SVG_HELP);
  });

  it('bounds source size, element count, nesting and path coordinate count', () => {
    expect(() => staticSvgImage(new Uint8Array(MAX_SVG_BYTES + 1), 2048)).toThrow(STATIC_SVG_HELP);
    expect(() => staticSvgImage(encode(svg('<g/>'.repeat(1200))), 2048)).toThrow(STATIC_SVG_HELP);
    expect(() => staticSvgImage(encode(svg('<g>'.repeat(25) + '</g>'.repeat(25))), 2048)).toThrow(STATIC_SVG_HELP);
    expect(() => staticSvgImage(encode(svg(`<path d="${'M0 0 '.repeat(6010)}"/>`)), 2048)).toThrow(STATIC_SVG_HELP);
  });
});
