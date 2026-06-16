import { describe, it, expect, vi } from 'vitest';

vi.mock('../image.js', () => ({
  generateGeminiImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,GEMINI', mimeType: 'image/png', prompt: 'x' })),
}));
vi.mock('../ideogram.js', () => ({ generateIdeogramImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,IDEO' })) }));
vi.mock('../flux.js', () => ({ generateFluxImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,FLUX' })) }));
vi.mock('../gateway.js', () => ({
  getProvider: (id: string) => ({
    generateImage: vi.fn(async () => ({ imageDataUrl: `data:image/png;base64,${id.toUpperCase()}`, images: [], model: id, usage: {} }))
  }),
  resolveProviderContext: (apiKey: string) => ({ apiKey, byok: true })
}));

import { makeImageTool, imageGenAvailable } from './imageGen.js';

describe('imageGen (BYOK)', () => {
  it('imageGenAvailable reflects whether any user key is present', () => {
    expect(imageGenAvailable({})).toBe(false);
    expect(imageGenAvailable({ geminiKey: 'k' })).toBe(true);
    expect(imageGenAvailable({ ideogramKey: 'k' })).toBe(true);
    expect(imageGenAvailable({ pixazoKey: 'k' })).toBe(true);
    expect(imageGenAvailable({ openaiKey: 'k' })).toBe(true);
    expect(imageGenAvailable({ xaiKey: 'k' })).toBe(true);
  });

  it('generates via OpenAI / xAI through the provider gateway when only those keys are present', async () => {
    expect((await makeImageTool({ openaiKey: 'k' }).execute({ prompt: 'x' })).images?.[0].url).toContain('OPENAI');
    const xai = await makeImageTool({ xaiKey: 'k' }).execute({ prompt: 'x' });
    expect(xai.images?.[0].url).toContain('XAI');
    expect(xai.content).toMatch(/xAI/);
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

  it('falls back to free Pollinations (no key, no error notice) when no BYOK key is configured', async () => {
    const r = await makeImageTool({}).execute({ prompt: 'a fox', aspectRatio: '16:9' });
    expect(r.notice).toBeUndefined();
    expect(r.images?.[0].url).toContain('image.pollinations.ai');
    expect(r.images?.[0].url).toContain('width=1280');
    expect(r.content).toMatch(/free/i);
  });

  it('requires a prompt', async () => {
    const r = await makeImageTool({ geminiKey: 'k' }).execute({ prompt: '' });
    expect(r.content).toMatch(/provide a prompt/i);
  });
});
