import { describe, it, expect, vi } from 'vitest';

vi.mock('../image.js', () => ({
  generateGeminiImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,GEMINI', mimeType: 'image/png', prompt: 'x' })),
}));
vi.mock('../ideogram.js', () => ({ generateIdeogramImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,IDEO' })) }));
vi.mock('../flux.js', () => ({ generateFluxImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,FLUX' })) }));
const gatewayFailure = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('../gateway.js', () => ({
  getProvider: (id: string) => ({
    generateImage: vi.fn(async () => {
      if (gatewayFailure.next) {
        const err = gatewayFailure.next;
        gatewayFailure.next = null;
        throw err;
      }
      return { imageDataUrl: `data:image/png;base64,${id.toUpperCase()}`, images: [], model: id, usage: {} };
    })
  }),
  resolveProviderContext: (apiKey: string) => ({ apiKey, byok: true })
}));

import { makeImageTool, imageGenAvailable } from './imageGen.js';
import { generateGeminiImage } from '../image.js';
import { generateIdeogramImage } from '../ideogram.js';
import { generateFluxImage } from '../flux.js';

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

  it('returns a clear notice when no key is configured', async () => {
    const r = await makeImageTool({}).execute({ prompt: 'x' });
    expect(r.notice?.message).toMatch(/no image/i);
  });

  it('requires a prompt', async () => {
    const r = await makeImageTool({ geminiKey: 'k' }).execute({ prompt: '' });
    expect(r.content).toMatch(/provide a prompt/i);
  });

  describe('a failed picture returns a fixed sentence, never the raw error', () => {
    const FAKE = `sk-proj-${'test0000'.repeat(6)}`;
    const sentence = (vendor: string, why: string) =>
      `That picture couldn't be made with your ${vendor} key: ${why}. Try again, or pick another picture model.`;
    const tagged = (status: number, message: string) => Object.assign(new Error(message), { status });

    it('a provider error that contains a key yields the fixed sentence and no key text', async () => {
      gatewayFailure.next = new Error(`OpenAI /images/generations failed: 401 Unauthorized Incorrect API key provided: ${FAKE}`);
      const r = await makeImageTool({ openaiKey: 'k' }).execute({ prompt: 'x' });
      expect(r.content).toBe(sentence('OpenAI', 'it was refused'));
      expect(r.content).not.toContain('sk-');
      expect(r.images).toBeUndefined();
    });

    it('out of credit, refused and busy each get their own words', async () => {
      vi.mocked(generateGeminiImage).mockRejectedValueOnce(tagged(429, 'You exceeded your current quota, please check your plan and billing details.'));
      expect((await makeImageTool({ geminiKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('Google', 'it is out of credit'));

      vi.mocked(generateIdeogramImage).mockRejectedValueOnce(new Error('Invalid Ideogram API key. Please generate a fresh key at ideogram.ai/manage-api.'));
      expect((await makeImageTool({ ideogramKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('Ideogram', 'it was refused'));

      vi.mocked(generateFluxImage).mockRejectedValueOnce(new Error('Image request timed out after 90000ms'));
      expect((await makeImageTool({ pixazoKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('Pixazo', 'the service is busy'));

      gatewayFailure.next = new Error('xAI /images/generations failed: 402 Payment Required (insufficient_credits) top up');
      expect((await makeImageTool({ xaiKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('xAI', 'it is out of credit'));

      gatewayFailure.next = new Error('OpenAI /images/generations failed: 400 Bad Request (content_policy_violation) rejected');
      expect((await makeImageTool({ openaiKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('OpenAI', 'it was refused'));

      gatewayFailure.next = new Error('OpenAI /images/generations failed: 503 Service Unavailable');
      expect((await makeImageTool({ openaiKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('OpenAI', 'the service is busy'));
    });

    it('a picture blocked for safety reads as refused', async () => {
      vi.mocked(generateGeminiImage).mockRejectedValueOnce(new Error('Image generation returned no image. finishReason=SAFETY'));
      expect((await makeImageTool({ geminiKey: 'k' }).execute({ prompt: 'x' })).content).toBe(sentence('Google', 'it was refused'));
    });
  });
});
