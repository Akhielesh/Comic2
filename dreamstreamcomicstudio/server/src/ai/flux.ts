import { FluxGenerateResponse } from '../../../apiTypes.js';
import {
  FLUX_FETCH_IMAGE_TIMEOUT_MS,
  FLUX_MODEL_ID,
  FLUX_REQUEST_TIMEOUT_MS,
  PIXAZO_ENDPOINT
} from '../config.js';
import { nowMs } from './utils.js';
import { buildUsage } from './usage.js';

const RESOLUTION_BASE: Record<string, number> = {
  '1K': 1024,
  '2K': 1536,
  '4K': 2048
};

const parseRatio = (ratio: string): number | null => {
  const parts = ratio.split(':').map((p) => Number(p.trim()));
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1]) || parts[0] <= 0 || parts[1] <= 0) {
    return null;
  }
  return parts[0] / parts[1];
};

const roundToMultiple = (value: number, multiple = 8) => Math.max(multiple, Math.round(value / multiple) * multiple);

const computeDimensions = (aspectRatio: string, resolution: string) => {
  const ratio = parseRatio(aspectRatio) || 1;
  const base = RESOLUTION_BASE[resolution] || RESOLUTION_BASE['1K'];
  let width = base;
  let height = base;
  if (ratio >= 1) {
    width = base;
    height = Math.round(base / ratio);
  } else {
    height = base;
    width = Math.round(base * ratio);
  }
  return {
    width: roundToMultiple(width),
    height: roundToMultiple(height)
  };
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
    `Timed out while downloading Flux output image after ${timeoutMs}ms. Try again or increase FLUX_FETCH_IMAGE_TIMEOUT_MS.`
  );

const bufferToDataUrl = (buffer: Buffer, mimeType: string) =>
  `data:${mimeType};base64,${buffer.toString('base64')}`;

const fetchImageAsDataUrl = async (
  url: string,
  timeoutMs = FLUX_FETCH_IMAGE_TIMEOUT_MS,
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
          // Wait and retry if 404 (maybe CDN propagation delay), bounded by timeout budget.
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
      console.warn(`[Flux] Attempt ${i + 1} failed to fetch image:`, err);
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

export const generateFluxImage = async (
  apiKey: string,
  args: {
    prompt: string;
    aspectRatio: string;
    resolution: string;
    negativePrompt?: string;
    seed?: number;
    steps?: number;
  }
): Promise<FluxGenerateResponse> => {
  const { prompt, negativePrompt, seed, steps = 4, aspectRatio, resolution } = args;
  const requestStart = nowMs();

  if (!apiKey) {
    throw new Error('Pixazo API key not found.');
  }

  const stepsClamped = Math.max(1, Math.min(8, steps));
  const finalPrompt = negativePrompt ? `${prompt}\n\nAvoid: ${negativePrompt}` : prompt;

  const requestBody = (overrides: Record<string, unknown> = {}) => ({
    prompt: finalPrompt,
    num_steps: stepsClamped,
    ...(typeof seed === 'number' ? { seed } : {}),
    ...overrides
  });

  const toFluxRequestTimeoutError = () =>
    new Error(
      `Flux image generation timed out after ${FLUX_REQUEST_TIMEOUT_MS}ms. Please retry with a simpler prompt or increase FLUX_REQUEST_TIMEOUT_MS.`
    );

  const callFlux = async (body: Record<string, unknown>) => {
    const response = await withTimeoutSignal(FLUX_REQUEST_TIMEOUT_MS, toFluxRequestTimeoutError, (signal) =>
      fetch(PIXAZO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Ocp-Apim-Subscription-Key': apiKey
        },
        body: JSON.stringify(body),
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

      if (providerMessage?.toLowerCase().includes('invalid api key')) {
        throw new Error('Invalid Pixazo API key. Please generate a fresh key in Pixazo settings.');
      }

      const detailSuffix = providerMessage ? ` Details: ${providerMessage}` : '';
      throw new Error(`Flux request failed (${response.status} ${response.statusText}).${detailSuffix}`);
    }

    return response.json();
  };

  const { width, height } = computeDimensions(aspectRatio, resolution);

  const isInvalidArgument = (err: any) => {
    const message = String(err?.message || err || '').toLowerCase();
    return message.includes('invalid') || message.includes('dimension') || message.includes('width') || message.includes('height');
  };

  let payload: any;
  try {
    payload = await callFlux(requestBody({ width, height }));
  } catch (err) {
    if (isInvalidArgument(err)) {
      const fallback = computeDimensions(aspectRatio, '1K');
      payload = await callFlux(requestBody({ width: fallback.width, height: fallback.height }));
    } else {
      throw err;
    }
  }

  const apiMs = Math.round(nowMs() - requestStart);
  const output = payload?.output;
  const outputUrl = Array.isArray(output) ? output[0] : output;
  console.log('[Flux] Output URL received:', outputUrl); // Debugging
  if (!outputUrl) {
    throw new Error('Flux response did not include output image.');
  }

  const { dataUrl, mimeType } = await fetchImageAsDataUrl(outputUrl);
  const totalMs = Math.round(nowMs() - requestStart);

  return {
    dataUrl,
    mimeType,
    prompt: finalPrompt,
    usage: buildUsage(finalPrompt),
    timings: { apiMs, totalMs },
    model: FLUX_MODEL_ID
  };
};
