import { buildApiUrl } from './clientConfig';
import { getFluxKeyInfo, getOpenRouterKey } from './appSettings';
import { getActiveKeyValue } from './apiKeys';
import { getSelectedTextModel, getModelForStage, getSelectedTextSource } from './modelSelection';
import { supabase } from './supabase';

let cachedAccessToken: string | undefined;

// Keep token fresh in memory to avoid redundant storage reads
supabase.auth.onAuthStateChange((_event, session) => {
  cachedAccessToken = session?.access_token;
});

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

const getAuthToken = async (): Promise<string | undefined> => {
  if (cachedAccessToken) return cachedAccessToken;

  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    cachedAccessToken = session.access_token;
  }
  return session?.access_token;
};

export const post = async <TReq, TRes>(path: string, body: TReq, options?: { signal?: AbortSignal; apiKey?: string; modelId?: string; stage?: string }): Promise<TRes> => {
  // Active key per provider (multi-key store), falling back to legacy single keys.
  const geminiKey = getActiveKeyValue('gemini') || getGeminiKey();
  const fluxKey = getActiveKeyValue('pixazo') || getFluxKeyInfo().key;
  const openRouterKey = getActiveKeyValue('openrouter') || getOpenRouterKey();
  const nvidiaKey = getActiveKeyValue('nvidia');
  const token = await getAuthToken();
  // Per-stage override when a stage is supplied, else the global text model.
  const textModel = options?.stage ? getModelForStage(options.stage) : getSelectedTextModel();

  const res = await fetch(buildApiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.apiKey ? { 'X-Gemini-Key': options.apiKey } : (geminiKey ? { 'X-Gemini-Key': geminiKey } : {})),
      ...(fluxKey ? { 'X-Pixazo-Key': fluxKey } : {}),
      ...(openRouterKey ? { 'X-OpenRouter-Key': openRouterKey } : {}),
      ...(nvidiaKey ? { 'X-Nvidia-Key': nvidiaKey } : {}),
      ...(textModel ? { 'X-Text-Model': textModel } : {}),
      ...(getSelectedTextSource() ? { 'X-Text-Source': getSelectedTextSource() as string } : {}),
      ...(options?.stage ? { 'X-Pipeline-Stage': options.stage } : {}),
      ...(options?.modelId ? { 'X-Gemini-Model': options.modelId } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: options?.signal
  });

  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};

export const get = async <TRes>(path: string, options?: { modelId?: string }): Promise<TRes> => {
  const geminiKey = getActiveKeyValue('gemini') || getGeminiKey();
  const fluxKey = getActiveKeyValue('pixazo') || getFluxKeyInfo().key;
  const openRouterKey = getActiveKeyValue('openrouter') || getOpenRouterKey();
  const nvidiaKey = getActiveKeyValue('nvidia');
  const token = await getAuthToken();

  const res = await fetch(buildApiUrl(path), {
    headers: {
      ...(geminiKey ? { 'X-Gemini-Key': geminiKey } : {}),
      ...(fluxKey ? { 'X-Pixazo-Key': fluxKey } : {}),
      ...(openRouterKey ? { 'X-OpenRouter-Key': openRouterKey } : {}),
      ...(nvidiaKey ? { 'X-Nvidia-Key': nvidiaKey } : {}),
      ...(getSelectedTextModel() ? { 'X-Text-Model': getSelectedTextModel() as string } : {}),
      ...(getSelectedTextSource() ? { 'X-Text-Source': getSelectedTextSource() as string } : {}),
      ...(options?.modelId ? { 'X-Gemini-Model': options.modelId } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    }
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};
