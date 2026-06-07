import { describe, it, expect, vi } from 'vitest';

vi.mock('../image.js', () => ({
  generateGeminiImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,GEMINI', mimeType: 'image/png', prompt: 'x' })),
}));
vi.mock('../ideogram.js', () => ({ generateIdeogramImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,IDEO' })) }));
vi.mock('../flux.js', () => ({ generateFluxImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,FLUX' })) }));

import { makeImageTool, imageGenAvailable } from './imageGen.js';

describe('imageGen (BYOK)', () => {
  it('imageGenAvailable reflects whether any user key is present', () => {
    expect(imageGenAvailable({})).toBe(false);
    expect(imageGenAvailable({ geminiKey: 'k' })).toBe(true);
    expect(imageGenAvailable({ ideogramKey: 'k' })).toBe(true);
    expect(imageGenAvailable({ pixazoKey: 'k' })).toBe(true);
  });

  it('generates via Gemini with the user key and returns the image', async () => {
    const r = await makeImageTool({ geminiKey: 'k' }).execute({ prompt: 'a fox', aspectRatio: '16:9' });
    expect(r.images?.[0].url).toContain('GEMINI');
    expect(r.content).toMatch(/Gemini/);
  });

  it('falls back to Ideogram, then Flux, by available key', async () => {
    expect((await makeImageTool({ ideogramKey: 'k' }).execute({ prompt: 'x' })).images?.[0].url).toContain('IDEO');
    expect((await makeImageTool({ pixazoKey: 'k' }).execute({ prompt: 'x' })).images?.[0].url).toContain('FLUX');
  });

  it('returns a clear notice when no key is configured', async () => {
    const r = await makeImageTool({}).execute({ prompt: 'x' });
    expect(r.notice?.message).toMatch(/no image/i);
  });

  it('requires a prompt', async () => {
    const r = await makeImageTool({ geminiKey: 'k' }).execute({ prompt: '' });
    expect(r.content).toMatch(/provide a prompt/i);
  });
});
