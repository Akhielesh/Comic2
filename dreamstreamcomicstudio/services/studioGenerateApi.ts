// Client for in-studio app generation (POST /api/studio/generate). Turns a plain-language
// idea into a runnable CodeStudioArtifact without the chat hand-off. Refine mode: pass the
// current files to iterate on an existing app.

import { post } from './apiClient';
import type { CodeStudioArtifact } from '../apiTypes';

export interface GenerateStudioInput {
  prompt: string;
  template?: string;
  /** When iterating on an existing app, its current files (triggers refine on the server). */
  files?: { path: string; content: string }[];
  /** Current project title, for continuity when refining. */
  title?: string;
}

/** Generate (or refine) an app from a prompt. Resolves to the runnable artifact. */
export const generateStudioApp = async (
  input: GenerateStudioInput,
  signal?: AbortSignal
): Promise<CodeStudioArtifact> => {
  const { artifact } = await post<GenerateStudioInput, { artifact: CodeStudioArtifact }>(
    '/api/studio/generate',
    input,
    { signal }
  );
  return artifact;
};
