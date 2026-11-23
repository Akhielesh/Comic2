import { describe, it, expect, vi, beforeEach } from 'vitest';
const google = vi.hoisted(() => ({ generateContent:vi.fn() }));
vi.mock('./client.js', () => ({ createClient:() => ({ models:google }) }));
import { generateGeminiImage } from './image.js';
const ref = 'data:image/jpeg;base64,/9j/';
const part = (data: string, thought = false) => ({ inlineData:{ mimeType:'image/png', data }, thought });
beforeEach(() => google.generateContent.mockReset());
describe('finished Gemini artwork', () => {
  it('sends ten native reference parts and explicit 2K, and returns the final image after a thought image', async () => {
    google.generateContent.mockResolvedValue({ candidates:[{ content:{ parts:[part('RFJBRlQ=', true), part('RklOQUw=')] } }] });
    const image = await generateGeminiImage('fixture', 'A cabin', '16:9', '2K', Array(10).fill(ref), 'gemini-nano-banana-2.1');
    expect(google.generateContent).toHaveBeenCalledTimes(1);
    expect(google.generateContent.mock.calls[0][0].contents[0].parts).toHaveLength(11);
    expect(google.generateContent.mock.calls[0][0].config.imageConfig).toEqual({ imageSize:'2K', aspectRatio:'16:9' });
    expect(image.dataUrl).toBe('data:image/png;base64,RklOQUw=');
  });
  it('makes just one upstream attempt after an ambiguous paid-provider failure', async () => {
    google.generateContent.mockRejectedValue(new Error('503 load failed'));
    await expect(generateGeminiImage('fixture', 'A cabin', '16:9', '1K', [], 'gemini-2.5-flash-image', { singleRequest:true })).rejects.toThrow('503');
    expect(google.generateContent).toHaveBeenCalledTimes(1);
    expect(google.generateContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('does not persist or expose a draft when the provider supplied only thoughts', async () => {
    google.generateContent.mockResolvedValue({ candidates:[{ content:{parts:[part('RFJBRlQ=', true),{ thought:true, text:'private working' }]} }] });
    await expect(generateGeminiImage('fixture', 'A cabin', '', '1K', [], 'gemini-2.5-flash-image')).rejects.toThrow(/^Image generation returned no image\.$/);
  });
});
