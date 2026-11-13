import { afterEach, expect, it, vi } from 'vitest';
import { sarvamTranslationPair } from '../../../../shared/comic/sarvam.js';
import { translateComicLineWithSarvam } from './sarvam.js';

afterEach(() => vi.unstubAllGlobals());

it('selects conversational English–Indic translation and the formal model for broader pairs', () => {
  expect(sarvamTranslationPair('en-US', 'te')).toMatchObject({ source_language_code: 'en-IN', target_language_code: 'te-IN', model: 'mayura:v1', mode: 'modern-colloquial' });
  expect(sarvamTranslationPair('hi', 'ur')).toMatchObject({ model: 'sarvam-translate:v1', mode: 'formal' });
  expect(sarvamTranslationPair('fr', 'te')).toBeUndefined();
  expect(sarvamTranslationPair('en-GB', 'en')).toBeUndefined();
});

it('sends one line with the BYOK header and returns an unsaved suggestion', async () => {
  const fetcher = vi.fn(async () => Response.json({ translated_text: 'నమస్తే' }));
  vi.stubGlobal('fetch', fetcher);
  await expect(translateComicLineWithSarvam('test-key', 'Hello', 'en', 'te')).resolves.toBe('నమస్తే');
  expect(fetcher).toHaveBeenCalledWith('https://api.sarvam.ai/translate', expect.objectContaining({
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': 'test-key' },
    body: JSON.stringify({ input: 'Hello', ...sarvamTranslationPair('en', 'te') }), redirect: 'error'
  }));
});

it('refuses unsupported languages before any call and gives a key-specific error for a refusal', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(translateComicLineWithSarvam('test-key', 'Hello', 'en', 'fr')).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(translateComicLineWithSarvam('test-key', 'Hello', 'en', 'hi')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
});
