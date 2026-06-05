// Chat → Code Studio hand-off (Sprint 0).
//
// The chat is a *feeder* for Code Studio (plan decision D6): a code_studio artifact card
// offers "Open in Code Studio", which stashes the artifact here and bumps `requestId`. The
// top-level App watches `requestId` and routes to the `codestudio` view, which reads
// `artifact`. A tiny zustand store (already a dependency) keeps the card decoupled from the
// App's routing internals — no prop-drilling through the chat tree.

import { create } from 'zustand';
import type { CodeStudioArtifact } from '../apiTypes';

interface StudioHandoffState {
  /** The most recent artifact handed off from chat (if any). */
  artifact: CodeStudioArtifact | null;
  /** Monotonically increments on every open() — App reacts to the change to navigate. */
  requestId: number;
  /** Hand an artifact to Code Studio and request navigation. */
  open: (artifact: CodeStudioArtifact) => void;
  /** Clear the stashed artifact (e.g. when leaving the studio). */
  clear: () => void;
}

export const useStudioHandoff = create<StudioHandoffState>((set) => ({
  artifact: null,
  requestId: 0,
  open: (artifact) => set((s) => ({ artifact, requestId: s.requestId + 1 })),
  clear: () => set({ artifact: null }),
}));
