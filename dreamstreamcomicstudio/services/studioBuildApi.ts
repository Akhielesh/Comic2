// Client for the agentic build SSE route (POST /api/studio/build). Streams the
// plan → run → observe → fix → done trace + a final result. Mirrors the server's BuildEvent.

import { postStream } from './apiClient';
import { readSSEStream } from './sse';

export type BuildStage = 'plan' | 'run' | 'observe' | 'fix' | 'done' | 'stopped';

export interface BuildObservationLite {
  summary?: string;
  kind?: string;
  file?: string;
  line?: number;
  [k: string]: unknown;
}

export interface BuildEvent {
  stage: BuildStage;
  iteration: number;
  message: string;
  observation?: BuildObservationLite;
  previewUrl?: string;
}

export interface BuildResult {
  ok: boolean;
  reason: string;
  iterations: number;
  previewUrl?: string;
  runId?: string;
}

export interface StudioBuildStart {
  runId?: string;
  projectId: string;
  sandboxId: string;
}

export interface StudioBuildPayload {
  projectId?: string;
  title?: string;
  template?: string;
  files: { path: string; content: string }[];
  maxIterations?: number;
}

export interface StudioBuildHandlers {
  onStart?: (d: StudioBuildStart) => void;
  onEvent?: (e: BuildEvent) => void;
  onResult?: (r: BuildResult) => void;
  onError?: (message: string) => void;
}

const STAGES = new Set<BuildStage>(['plan', 'run', 'observe', 'fix', 'done', 'stopped']);

/** POST the build and stream its trace. Resolves when the stream ends. */
export const streamStudioBuild = async (
  payload: StudioBuildPayload,
  handlers: StudioBuildHandlers,
  signal?: AbortSignal
): Promise<void> => {
  const res = await postStream('/api/studio/build', payload, { signal });
  await readSSEStream(res.body, ({ event, data }) => {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (event === 'start') handlers.onStart?.(parsed as StudioBuildStart);
    else if (STAGES.has(event as BuildStage)) handlers.onEvent?.(parsed as BuildEvent);
    else if (event === 'result') handlers.onResult?.(parsed as BuildResult);
    else if (event === 'error') handlers.onError?.((parsed as { message?: string })?.message || 'Build failed.');
  });
};
