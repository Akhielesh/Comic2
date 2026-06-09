// The honest "which build mode am I in?" copy for the Code Studio, derived from whether the live
// agentic Worker is actually configured on the server (getStudioStatus). Pure + dependency-free so
// the badge component stays presentational and this stays unit-testable.
//
// The whole point: stop the studio from silently behaving like a one-shot generator while the user
// assumes it's the full agentic loop. The badge tells them which one they've got and what's missing.

export type StudioMode = 'agentic' | 'oneshot' | 'unknown';

export interface StudioModeInfo {
  mode: StudioMode;
  /** Short pill label. */
  label: string;
  /** Visual emphasis: live = good/active, fallback = needs setup, neutral = unknown. */
  tone: 'live' | 'fallback' | 'neutral';
  /** One-line explanation for the tooltip / popover. */
  summary: string;
}

/**
 * Map the server's `liveConfigured` signal to mode copy. `undefined` = not known yet (status still
 * loading or the check failed) → 'unknown', which the badge hides rather than guessing.
 */
export const studioModeInfo = (liveConfigured: boolean | undefined): StudioModeInfo => {
  if (liveConfigured === undefined) {
    return { mode: 'unknown', label: 'Checking…', tone: 'neutral', summary: 'Checking the build mode…' };
  }
  if (liveConfigured) {
    return {
      mode: 'agentic',
      label: 'Agentic · live',
      tone: 'live',
      summary:
        'Full agentic loop: your app runs in a cloud sandbox, the agent reads the real runtime errors and fixes the files itself, and a build keeps running even if you switch projects.'
    };
  }
  return {
    mode: 'oneshot',
    label: 'One-shot mode',
    tone: 'fallback',
    summary:
      'Generates a complete app and verifies it statically, then auto-repairs — but it does NOT run your app to catch runtime errors. The full agentic loop (live cloud run, self-fixing, background builds) needs the Studio Worker enabled. See docs/studio/AGENTIC-ACTIVATION.md.'
  };
};
