import { buildApiUrl } from './clientConfig';
import { getFluxKeyInfo } from './appSettings';

const getGeminiKey = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('dreamstream_api_key');
  } catch {
    return null;
  }
};

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const parseError = async (res: Response) => {
  try {
    const data = await res.json();
    const message = data?.error?.message || res.statusText;
    return new ApiError(message, res.status, data?.error?.details ?? data);
  } catch {
    return new ApiError(res.statusText, res.status);
  }
};

export const post = async <TReq, TRes>(path: string, body: TReq, options?: { signal?: AbortSignal }): Promise<TRes> => {
  const geminiKey = getGeminiKey();
  const fluxInfo = getFluxKeyInfo();
  const res = await fetch(buildApiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(geminiKey ? { 'X-Gemini-Key': geminiKey } : {}),
      ...(fluxInfo.key ? { 'X-Pixazo-Key': fluxInfo.key } : {})
    },
    body: JSON.stringify(body),
    signal: options?.signal
  });

  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};

export const get = async <TRes>(path: string): Promise<TRes> => {
  const geminiKey = getGeminiKey();
  const fluxInfo = getFluxKeyInfo();
  const res = await fetch(buildApiUrl(path), {
    headers: {
      ...(geminiKey ? { 'X-Gemini-Key': geminiKey } : {}),
      ...(fluxInfo.key ? { 'X-Pixazo-Key': fluxInfo.key } : {})
    }
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};
