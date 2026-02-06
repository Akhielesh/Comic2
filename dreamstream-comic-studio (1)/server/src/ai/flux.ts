import { FluxGenerateResponse } from '../../../apiTypes.js';
import { FLUX_MODEL_ID, PIXAZO_ENDPOINT } from '../config.js';
import { nowMs } from './utils.js';

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

const bufferToDataUrl = (buffer: Buffer, mimeType: string) =>
  `data:${mimeType};base64,${buffer.toString('base64')}`;

const fetchImageAsDataUrl = async (url: string): Promise<{ dataUrl: string; mimeType: string }> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch output image (${response.status}).`);
  }
  const mimeType = response.headers.get('content-type') || 'image/png';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return { dataUrl: bufferToDataUrl(buffer, mimeType), mimeType };
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

  const callFlux = async (body: Record<string, unknown>) => {
    const response = await fetch(PIXAZO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': apiKey
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      let message = `Flux request failed (${response.status}).`;
      try {
        const errorPayload = await response.json();
        message = errorPayload?.error?.message || errorPayload?.message || JSON.stringify(errorPayload);
      } catch {
        const errorText = await response.text();
        if (errorText) message = errorText;
      }
      if (message.toLowerCase().includes('invalid api key')) {
        message = 'Invalid Pixazo API key. Please generate a fresh key in Pixazo settings.';
      }
      throw new Error(message);
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
  if (!outputUrl) {
    throw new Error('Flux response did not include output image.');
  }

  const { dataUrl, mimeType } = await fetchImageAsDataUrl(outputUrl);
  const totalMs = Math.round(nowMs() - requestStart);

  return {
    dataUrl,
    mimeType,
    prompt: finalPrompt,
    timings: { apiMs, totalMs },
    model: FLUX_MODEL_ID
  };
};
