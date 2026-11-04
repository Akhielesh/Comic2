// Shared tool interface for the agentic chat loop.
//
// Kept separate from registry.ts so the many free-API tool modules can import the
// contract without importing the registry itself (which imports them).

import type { ApiUsage, ChatArtifact } from '../../../../apiTypes.js';
import type { PlatformDocsAccess } from './platformDocs.js';

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
  /**
   * Server-only: this request's platform-docs answer (ai/tools/platformDocs.ts `platformDocsFor(req)`). The platform
   * tools (email_draft, deck_create) are built only from an answer that module issued and enabled; a value copied
   * from the client (`clientContext.platformDocs`) or any look-alike object is ignored.
   */
  platformDocs?: PlatformDocsAccess;
  /** The user's usage is governed (shares of usage, never '$'). Absent counts as governed. */
  governed?: boolean;
  /**
   * Addresses the user typed in their OWN latest message (never attachments, thread bodies, pasted-text blocks or tool
   * output): the only recipients a platform email draft may pre-fill. Absent: every recipient is shown as a suggestion
   * only.
   */
  userTypedAddresses?: string[];
  /**
   * Addresses inside the pasted-text blocks of that message (ai/tools/platformDocs.ts `addressesPastedIn`): a platform
   * email draft flags them with reason 'pasted' and never pre-fills them.
   */
  pastedAddresses?: string[];
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
  /**
   * Provider usage of the model calls this tool made itself (the agent meta-tools: swarm,
   * delegate, deep research). runChat adds it into the turn's usage so the route settles it;
   * it is never shown to the model.
   */
  usage?: ApiUsage;
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecResult>;
}
