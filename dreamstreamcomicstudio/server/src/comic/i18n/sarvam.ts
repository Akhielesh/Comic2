import { sarvamTranslationPair } from '../../../../shared/comic/sarvam.js';
import { readTextCapped } from '../../ai/tools/cappedBody.js';
import { StudioError } from '../types.js';

const ENDPOINT = 'https://api.sarvam.ai/translate';
const MAX_RESPONSE = 24_000;

export async function translateComicLineWithSarvam(key: string, input: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
  const pair = sarvamTranslationPair(from, to);
  if (!pair || !input.trim() || input.length > 600) throw new StudioError('BAD_REQUEST', 'Choose a supported Sarvam language pair and a line of up to 600 characters.', { status: 400 });
  const timeout = AbortSignal.timeout(10_000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
      body: JSON.stringify({ input, ...pair }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error'
    });
    if (res.status === 403) throw new StudioError('FORBIDDEN', 'Sarvam rejected your API key. Check it in Settings.', { status: 403 });
    if (res.status === 429) throw new StudioError('COOLDOWN', 'Sarvam is rate-limiting requests. Try again in a moment.', { status: 429 });
    if (!res.ok) throw new Error('Sarvam request failed.');
    const body = await readTextCapped(res, MAX_RESPONSE);
    if (body.truncated) throw new Error('Sarvam response too large.');
    const result = JSON.parse(body.text) as { translated_text?: unknown };
    const translated = typeof result.translated_text === 'string' ? result.translated_text.trim() : '';
    if (!translated || translated.length > 600) throw new Error('Sarvam translation cannot fit the editor.');
    return translated;
  } catch (cause) {
    if (cause instanceof StudioError) throw cause;
    throw new StudioError('NOT_AVAILABLE', 'Sarvam couldn’t translate this line. Try again or translate it in the editor.', { status: 502, cause });
  }
}
