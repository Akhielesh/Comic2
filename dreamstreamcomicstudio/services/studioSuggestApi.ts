// Client for the Code Studio SUGGEST stage — real, app-specific "what to build next"
// recommendations from the current code. Attaches the studio's chosen coding model/source/options
// so it uses Code Studio's own model. Best-effort: any failure returns an empty list and the UI
// falls back to its local heuristic, so suggestions never break the studio.

import { post } from './apiClient';
import { studioModelRequest } from './studioModelSelection';
import type { StudioSuggestResult } from '../apiTypes';

export interface SuggestRequest {
  title?: string;
  files: { path: string; content: string }[];
}

export const suggestStudioNextSteps = async (
  input: SuggestRequest,
  signal?: AbortSignal,
): Promise<StudioSuggestResult> =>
  post<Record<string, unknown>, StudioSuggestResult>(
    '/api/studio/suggest',
    { ...studioModelRequest(), title: input.title, files: input.files },
    { signal, retry: { attempts: 2 } },
  );
