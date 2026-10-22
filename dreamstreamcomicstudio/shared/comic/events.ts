// Studio stream protocol (Server-Sent Events) — server → client.
//
// One POST /api/comic/projects/:id/stream request carries either a user message
// (→ the Comic Director runs) or a direct StudioAction (→ the job runs). The response
// is an SSE stream of StudioEvents that stays open until the turn AND every render
// it started have settled, so the canvas fills in live. Heartbeat comments
// (": keep-alive") every 15s keep proxies from dropping it.

import type { DocOp, StudioAction } from './ops.js';
import type { CastKind, RefOwner } from './doc.js';

/** Who caused an ops batch (the client undo stack takes 'director' batches). */
export type OpsOrigin = 'user' | 'director' | 'job';
/** What the user is looking at / has selected when they send a message. */
export interface StudioFocus {
  pageId?: string;
  /** Selected balloons (≤ 80). */
  lineIds?: string[];
  panelN?: number;
  surface?: 'board' | 'page_editor' | 'reader' | 'timeline';
}
/** Optional quick-assign of one image attachment. */
export type AttachmentTarget = RefOwner | { kind: 'new_character'; name: string; castKind?: CastKind } | null;

export type StudioEvent =
  /** First event: the doc revision the server started from. Client refetches if it is behind. */
  | { type: 'hello'; rev: number; turnId: string }
  /** Committed doc changes. `rev` is the revision AFTER applying them. origin: who caused it; label: undo text. */
  | { type: 'ops'; rev: number; ops: DocOp[]; origin?: OpsOrigin; label?: string }
  /** Streaming assistant text for message `msgId` (append). */
  | { type: 'delta'; msgId: string; text: string }
  /** Agent / job activity for the live status line ("Drawing page 3…"). cost: tiny badge on the status line. */
  | { type: 'activity'; id: string; label: string; phase: 'start' | 'end'; ok?: boolean; cost?: 'free' | 'text' | 'image' }
  /** Signed, short-lived URLs for storage paths referenced by the doc. */
  | { type: 'urls'; urls: Record<string, string> }
  /** Codes include CONTENT_POLICY, COOLDOWN, LIMIT, NOT_READY, CONFLICT, NOT_AVAILABLE (additive strings). */
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; rev: number; spentUsd: number; savedUsd?: number };

export type StreamRequest =
  | {
      kind: 'message';
      text: string;
      /** Legacy data-URL items (old tabs) OR inbox paths already uploaded via POST /refs (new composer). */
      attachments?: ({ name: string; mimeType: string; dataUrl: string } | { inboxPath: string })[];
      /** Optional quick-assign per IMAGE attachment, aligned by order. */
      attachmentTargets?: AttachmentTarget[];
      focus?: StudioFocus;
    }
  | { kind: 'action'; action: StudioAction };

export const STREAM_EVENT_NAMES: ReadonlyArray<StudioEvent['type']> = [
  'hello',
  'ops',
  'delta',
  'activity',
  'urls',
  'error',
  'done'
];

/**
 * Serialize an event for the wire. DocOps clear fields by setting them to `undefined`
 * (e.g. `render.error` after a successful retry); plain JSON.stringify would DROP those
 * keys and the client's mirror would keep the stale value. Encoding them as `null`
 * makes the clear survive transport — applyOps treats null like "unset".
 */
export const encodeStudioEvent = (event: StudioEvent): string =>
  JSON.stringify(event, (_key, value) => (value === undefined ? null : value));
