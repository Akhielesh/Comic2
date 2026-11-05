// @vitest-environment jsdom
// The program's faces (live/studio/compositor.ts): Hanken Grotesk is burned into broadcasts and
// recordings, and nothing in the page's own UI uses it any more, so the compositor asks for both
// weights it draws as soon as it starts — and redraws once they're in — instead of letting the first
// frames go out in the fallback face.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROGRAM_FONTS, ProgramCompositor, warmProgramFonts } from './compositor';

const SOURCE = readFileSync(path.join(process.cwd(), 'live/studio/compositor.ts'), 'utf8');

function stubFonts(load: (font: string) => Promise<unknown>) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: vi.fn(load) } });
  return (document as unknown as { fonts: { load: ReturnType<typeof vi.fn> } }).fonts.load;
}

afterEach(() => {
  delete (document as unknown as { fonts?: unknown }).fonts;
  vi.restoreAllMocks();
});

describe('the compositor’s faces', () => {
  it('warms every weight the draws use (and only Hanken Grotesk)', () => {
    const drawn = new Set([...SOURCE.matchAll(/ctx\.font = `(\d{3}) \$\{[^}]+\}px '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`));
    expect(drawn.size).toBeGreaterThan(0);
    const warmed = new Set(PROGRAM_FONTS.map((f) => /^(\d{3}) \d+px '([^']+)'$/.exec(f)!).map((m) => `${m[1]} ${m[2]}`));
    expect(warmed).toEqual(drawn);
    expect([...warmed].sort()).toEqual(['500 Hanken Grotesk', '600 Hanken Grotesk']);
  });

  it('asks document.fonts for both weights, then says when they are in', async () => {
    const load = stubFonts(async () => []);
    const ready = vi.fn();
    warmProgramFonts(ready);
    expect(load.mock.calls.map((c) => c[0])).toEqual([...PROGRAM_FONTS]);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  });

  it('never throws: no FontFaceSet, or a load that fails', async () => {
    expect(() => warmProgramFonts(() => {})).not.toThrow();
    const ready = vi.fn();
    stubFonts(() => Promise.reject(new Error('offline')));
    expect(() => warmProgramFonts(ready)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).not.toHaveBeenCalled();
  });

  it('starts warming when a compositor is made', () => {
    const load = stubFonts(async () => []);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as CanvasRenderingContext2D);
    new ProgramCompositor(1280, 720, 30);
    expect(load.mock.calls.map((c) => c[0])).toEqual([...PROGRAM_FONTS]);
  });
});
