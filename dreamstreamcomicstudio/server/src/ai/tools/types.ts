// Shared tool interface for the agentic chat loop.
//
// Kept separate from registry.ts so the many free-API tool modules can import the
// contract without importing the registry itself (which imports them).

import type { ChatArtifact } from '../../../../apiTypes.js';

/**
 * Per-request situational context made available to tools that benefit from it
 * (news region/language, "near me" geocoding, unit defaults).
 */
export interface ToolContext {
  timezone?: string;
  locale?: string;
  units?: 'metric' | 'imperial';
  location?: { city?: string; region?: string; country?: string; lat?: number; lng?: number };
  /** Files attached to the current user turn (base64 data URIs) — read by run_python. */
  attachments?: { name: string; mimeType: string; dataUri: string }[];
  /** The signed-in user — required for connector tools to scope to THEIR connections. */
  userId?: string;
}

export interface ToolExecResult {
  /** Text fed back to the model as the tool result. */
  content: string;
  /** Images to surface in the UI (image search, recipe photos, QR codes, etc.). */
  images?: { url: string; title?: string; thumbnail?: string; source?: string }[];
  /** Web citations to surface in the "sources" panel. */
  citations?: { url: string; title?: string }[];
  /** Typed rich-output artifacts (weather, etc.) rendered as components. */
  artifacts?: ChatArtifact[];
  /** A capability gap to surface (degraded mode, missing key, empty result). */
  notice?: { level: 'info' | 'warn' | 'error'; message: string; fix?: string };
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecResult>;
}
