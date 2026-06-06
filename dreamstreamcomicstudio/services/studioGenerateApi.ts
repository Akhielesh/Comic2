// Client for in-studio app generation (POST /api/studio/generate). Turns a plain-language
// idea into a runnable CodeStudioArtifact without the chat hand-off. Refine mode: pass the
// current files to iterate on an existing app.

import { post, postStream } from './apiClient';
import { readSSEStream } from './sse';
import { studioModelRequest } from './studioModelSelection';
import type { ModelSourceId } from './modelSelection';
import type { CodeStudioArtifact } from '../apiTypes';

export interface GenerateStudioInput {
  prompt: string;
  template?: string;
  /** When iterating on an existing app, its current files (triggers refine on the server). */
  files?: { path: string; content: string }[];
  /** Current project title, for continuity when refining. */
  title?: string;
  /** Override the studio's chosen coding model id (else taken from studioModelSelection). */
  model?: string;
  /** Override the source (else from studioModelSelection). */
  source?: ModelSourceId;
  /** Override spend preference for auto-pick. */
  costPref?: 'free' | 'cheap' | 'quality';
  /** Override sampling temperature (0–1). */
  temperature?: number;
}

/** Merge the studio's saved coding-model selection under the call's explicit overrides. */
const withStudioModel = (input: GenerateStudioInput): GenerateStudioInput => ({
  ...studioModelRequest(),
  ...input
});

/** Generate (or refine) an app from a prompt. Resolves to the runnable artifact. */
export const generateStudioApp = async (
  input: GenerateStudioInput,
  signal?: AbortSignal
): Promise<CodeStudioArtifact> => {
  const { artifact } = await post<GenerateStudioInput, { artifact: CodeStudioArtifact }>(
    '/api/studio/generate',
    withStudioModel(input),
    { signal }
  );
  return artifact;
};

// ---- Streaming generation (live activity feed) -----------------------------------------

export type StudioFileStatus = 'writing' | 'written';

export interface StudioGenerateHandlers {
  /** Stream opened; `refining` distinguishes new-app vs iterate. */
  onStart?: (d: { refining: boolean }) => void;
  /** A coarse phase label ("Designing your app…", "Writing files…"). */
  onPhase?: (label: string) => void;
  /** A file is being written, or finished writing (with its size). */
  onFile?: (f: { path: string; status: StudioFileStatus; bytes?: number }) => void;
  /** Generation finished — the runnable artifact is ready. */
  onResult?: (artifact: CodeStudioArtifact) => void;
  /** Generation failed (the model returned nothing usable, etc.). */
  onError?: (message: string) => void;
}

/**
 * Stream generation over SSE so the UI can show files appearing live. Resolves when the stream
 * ends. Throws on transport errors (non-2xx / network) so callers can fall back to the blocking
 * {@link generateStudioApp}.
 */
export const streamGenerateStudioApp = async (
  input: GenerateStudioInput,
  handlers: StudioGenerateHandlers,
  signal?: AbortSignal
): Promise<void> => {
  const res = await postStream('/api/studio/generate/stream', withStudioModel(input), { signal });
  await readSSEStream(res.body, ({ event, data }) => {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    switch (event) {
      case 'start':
        handlers.onStart?.(parsed as { refining: boolean });
        break;
      case 'phase':
        handlers.onPhase?.((parsed as { label?: string })?.label || '');
        break;
      case 'file':
        handlers.onFile?.(parsed as { path: string; status: StudioFileStatus; bytes?: number });
        break;
      case 'result':
        handlers.onResult?.((parsed as { artifact: CodeStudioArtifact }).artifact);
        break;
      case 'error':
        handlers.onError?.((parsed as { message?: string })?.message || 'Generation failed.');
        break;
    }
  });
};
