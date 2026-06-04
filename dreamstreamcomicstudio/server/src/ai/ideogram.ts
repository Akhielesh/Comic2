import { IdeogramGenerateResponse } from '../../../apiTypes.js';
import {
  IDEOGRAM_ENDPOINT,
  IDEOGRAM_FETCH_IMAGE_TIMEOUT_MS,
  IDEOGRAM_MODEL_ID,
  IDEOGRAM_MODEL_VERSION,
  IDEOGRAM_REQUEST_TIMEOUT_MS
} from '../config.js';
import { nowMs } from './utils.js';
import { buildUsage } from './usage.js';

// Map our catalog model ids to the model version string the Ideogram API expects.
const MODEL_VERSION_BY_ID: Record<string, string> = {
  'ideogram/ideogram-v2': 'V_2',
  'ideogram/ideogram-v2-turbo': 'V_2_TURBO'
};

// Map our aspect-ratio strings to Ideogram's ASPECT_* enum. Unsupported ratios fall back to 1:1.
const ASPECT_RATIO_MAP: Record<string, string> = {
  '1:1': 'ASPECT_1_1',
  '2:3': 'ASPECT_2_3',
  '3:2': 'ASPECT_3_2',
  '3:4': 'ASPECT_3_4',
  '4:3': 'ASPECT_4_3',
  '9:16': 'ASPECT_9_16',
  '16:9': 'ASPECT_16_9',
  '10:16': 'ASPECT_10_16',
  '16:10': 'ASPECT_16_10'
};

const resolveAspectRatio = (aspectRatio: string) => ASPECT_RATIO_MAP[aspectRatio] || 'ASPECT_1_1';

const resolveModelVersion = (modelId?: string) => {
  if (modelId && MODEL_VERSION_BY_ID[modelId]) return MODEL_VERSION_BY_ID[modelId];
  return IDEOGRAM_MODEL_VERSION;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isAbortError = (error: unknown) => {
  const maybeError = error as { name?: string; code?: string; message?: string };
  return maybeError?.name === 'AbortError' || maybeError?.code === 'ABORT_ERR';
};

const withTimeoutSignal = async <T>(
  ms: number,
  onTimeout: () => Error,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw onTimeout();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const toImageFetchTimeoutError = (timeoutMs: number) =>
  new Error(
    `Timed out while downloading Ideogram output image after ${timeoutMs}ms. Try again or increase IDEOGRAM_FETCH_IMAGE_TIMEOUT_MS.`
  );

const bufferToDataUrl = (buffer: Buffer, mimeType: string) =>
  `data:${mimeType};base64,${buffer.toString('base64')}`;

const fetchImageAsDataUrl = async (
  url: string,
  timeoutMs = IDEOGRAM_FETCH_IMAGE_TIMEOUT_MS,
  retries = 3
): Promise<{ dataUrl: string; mimeType: string }> => {
  const start = nowMs();

  for (let i = 0; i < retries; i++) {
    const elapsed = nowMs() - start;
    const remainingMs = Math.max(0, timeoutMs - elapsed);
    if (remainingMs <= 0) {
      throw toImageFetchTimeoutError(timeoutMs);
    }

    try {
      const response = await withTimeoutSignal(remainingMs, () => toImageFetchTimeoutError(timeoutMs), (signal) =>
        fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          signal
        })
      );

      if (!response.ok) {
        if (response.status === 404 && i < retries - 1) {
          const retryDelayMs = Math.min(1000, Math.max(0, timeoutMs - (nowMs() - start)));
          if (retryDelayMs > 0) {
            await wait(retryDelayMs);
            continue;
          }
        }
        throw new Error(`Failed to fetch output image (${response.status} ${response.statusText})`);
      }

      const mimeType = response.headers.get('content-type') || 'image/png';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return { dataUrl: bufferToDataUrl(buffer, mimeType), mimeType };
    } catch (err) {
      console.warn(`[Ideogram] Attempt ${i + 1} failed to fetch image:`, err);
      if (isAbortError(err)) {
        throw toImageFetchTimeoutError(timeoutMs);
      }
      if (i === retries - 1) throw err;

      const retryDelayMs = Math.min(1000, Math.max(0, timeoutMs - (nowMs() - start)));
      if (retryDelayMs <= 0) {
        throw toImageFetchTimeoutError(timeoutMs);
      }
      await wait(retryDelayMs);
    }
  }

  throw new Error('Failed to fetch image after retries');
};

export const generateIdeogramImage = async (
  apiKey: string,
  args: {
    prompt: string;
    aspectRatio: string;
    resolution: string;
    negativePrompt?: string;
    seed?: number;
    modelId?: string;
  }
): Promise<IdeogramGenerateResponse> => {
  const { prompt, negativePrompt, seed, aspectRatio, modelId } = args;
  const requestStart = nowMs();

  if (!apiKey) {
    throw new Error('Ideogram API key not found.');
  }

  const modelVersion = resolveModelVersion(modelId);
  const imageRequest: Record<string, unknown> = {
    prompt,
    model: modelVersion,
    aspect_ratio: resolveAspectRatio(aspectRatio),
    magic_prompt_option: 'AUTO',
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    ...(typeof seed === 'number' ? { seed } : {})
  };

  const toIdeogramRequestTimeoutError = () =>
    new Error(
      `Ideogram image generation timed out after ${IDEOGRAM_REQUEST_TIMEOUT_MS}ms. Please retry with a simpler prompt or increase IDEOGRAM_REQUEST_TIMEOUT_MS.`
    );

  const response = await withTimeoutSignal(IDEOGRAM_REQUEST_TIMEOUT_MS, toIdeogramRequestTimeoutError, (signal) =>
    fetch(IDEOGRAM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey
      },
      body: JSON.stringify({ image_request: imageRequest }),
      signal
    })
  );

  if (!response.ok) {
    let providerMessage: string | undefined;
    try {
      const errorPayload = await response.json();
      providerMessage = errorPayload?.error?.message || errorPayload?.message || JSON.stringify(errorPayload);
    } catch {
      const errorText = await response.text();
      providerMessage = errorText || undefined;
    }

    if (response.status === 401 || providerMessage?.toLowerCase().includes('api key') || providerMessage?.toLowerCase().includes('unauthorized')) {
      throw new Error('Invalid Ideogram API key. Please generate a fresh key at ideogram.ai/manage-api.');
    }

    const detailSuffix = providerMessage ? ` Details: ${providerMessage}` : '';
    throw new Error(`Ideogram request failed (${response.status} ${response.statusText}).${detailSuffix}`);
  }

  const payload = await response.json();
  const apiMs = Math.round(nowMs() - requestStart);
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const outputUrl = data[0]?.url;
  if (!outputUrl) {
    throw new Error('Ideogram response did not include output image.');
  }

  const { dataUrl, mimeType } = await fetchImageAsDataUrl(outputUrl);
  const totalMs = Math.round(nowMs() - requestStart);

  return {
    dataUrl,
    mimeType,
    prompt,
    usage: buildUsage(prompt),
    timings: { apiMs, totalMs },
    model: modelId || IDEOGRAM_MODEL_ID
  };
};
