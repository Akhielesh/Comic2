// Client-side contract for the Comic Studio (v4) UI.
//
// `useStudio(projectId)` (useStudio.ts) owns the mirrored ComicDoc, the signed-URL
// cache and the live stream; every pane renders from the StudioController it returns
// and talks back through it. Panes never call the API directly.
//
// Contract §13.1: the members below "v5" were added in wave 0 (P0-C) and completed by
// P1-CLIENTSTATE (undo stack, variants, upload progress, publication). Members added after the
// contract froze are OPTIONAL so every existing consumer and test fake keeps compiling.

import type { AssetRef, ClientAction, ComicDoc, NextStep, RefAsset, RefLabel, RefOwner, RenderTarget, StudioTab } from '../../shared/comic/doc';
import type { DocOp, StudioAction } from '../../shared/comic/ops';
import type { AttachmentTarget, StudioFocus } from '../../shared/comic/events';
import type { StudioCaps, StudioMode } from '../../shared/comic/capabilities';
import type { PublicationOwnerView } from '../../shared/comic/publication';
import type { QueuedNote, QueueHold } from './messageQueue';

export type { StudioTab };
/** Alias kept for existing imports (contract §1: `BoardTab = StudioTab`). */
export type BoardTab = StudioTab;

/** What a finished stream reported (re-exported by useStudio.ts, where it is produced). */
export interface StreamOutcome {
  ok: boolean;
  error?: string;
  code?: string;
  aborted: boolean;
  /** Trying the same request again could succeed (network, busy, rate limit, server hiccup). */
  retryable: boolean;
}

/**
 * What `act()` resolves to: the stream's outcome plus `gated` — this action's stream committed an
 * OPEN approval gate (the spend waits for the user). Card sequences (conversation/cards/useAction
 * `stopsSequence`) stop on `ok: false`, `aborted` or `gated`, so a second spend never runs behind a
 * refusal and a second gate never replaces the first. Call sites that ignore the value keep working
 * (`void studio.act(…)`).
 */
export interface StudioActOutcome extends StreamOutcome {
  gated: boolean;
  /** The action never reached the server (a duplicate click, an invalid action, no comic loaded). */
  skipped?: boolean;
  /**
   * Comic History: the moment the server saved just before a `history_restore` (its stream's `done` event, versions
   * plan §6.1 step 8). The restore toast's Undo brings it back (history/historyActions.ts). Absent for every other
   * action and from servers that don't send it.
   */
  beforeVersionId?: string;
}

export interface ActivityItem {
  id: string;
  label: string;
  phase: 'start' | 'end';
  ok?: boolean;
  at: number;
  /** Tiny badge on the status line: free software work, a text-model call or an image. */
  cost?: 'free' | 'text' | 'image';
}

/**
 * A calm, transient studio notice (not an error): "Undid: move a balloon · Redo",
 * "Nothing to undo yet". Shown by the conversation/editor chrome and dismissible.
 */
export interface StudioNotice {
  id: string;
  kind: 'undo' | 'redo' | 'info';
  text: string;
  /** The follow-up the notice offers as a button. */
  action?: 'undo' | 'redo';
  at: number;
}

/** A request to open the reader (chips, cards, the director): the Read tab host consumes it. */
export interface ReaderRequest {
  /** Changes on every request, so the same request twice still opens it. */
  seq: number;
  immersive: boolean;
  guided: boolean;
}

// --- live agent (agent-editor plan §3 A1/A2/A4; K3 contract) ---

/**
 * What `send()` did with a message (A1): 'sent' = a stream started; 'queued' = added to Up next while the director works;
 * 'held' = queued but waiting (an unanswered question, an open spend gate, Stop pressed); 'refused' = nothing was sent or
 * queued (the composer keeps the draft and shows why). Never silent: every outcome but 'sent' has visible copy.
 */
export type SendOutcome = 'sent' | 'queued' | 'held' | 'refused';

/** Where the director is working right now (activity.where; A2/A4): the page editor outlines "Director is editing". */
export interface StudioPresence {
  pageId?: string;
  lineIds: string[];
  /** The live activity line it came from ("Moving a balloon"). */
  label: string;
  /** When it started (ms); cleared on the activity's end or the stream's done. */
  at: number;
}

export interface PendingAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface PatchOptions {
  /** Push onto the undo stack (default true for user edits). */
  undo?: boolean;
  /** Drags/scrubs with the same key within 600 ms merge into one undo entry. */
  coalesce?: string;
  /** Undo toast text ("Undo move balloon"). */
  label?: string;
  /** Called if the server rejects or cannot confirm the optimistic edit. */
  onFailed?: (retryable: boolean) => void;
}

export interface StudioSelection {
  pageId: string;
  lineIds: string[];
  panelN?: number;
  surface: 'page_editor' | 'board';
  // --- Ship 2 (pro plan §4.5; K2b registration, C1 fills them): the pro editor's selected panels (frames) and overlays
  //     ('ly_…') on pageId. A director focus derived from the selection carries them (StudioFocus.panelIds / layerIds). ---
  panelIds?: string[];
  layerIds?: string[];
}

/**
 * Ship 2 (pro plan §4.6 "Never lose work"; K2b registration, C3 fills it): where the editor's edits are. 'saved' = on the
 * server; 'saving' = sending; 'local' = saved on this device, will sync; 'offline' = waiting for the network; 'error' =
 * the server refused one (rolled back, with its sentence).
 */
export type StudioSaveState = 'saved' | 'saving' | 'local' | 'offline' | 'error';

export interface SendOptions {
  /** Legacy data URLs (still accepted). */
  attachments?: PendingAttachment[];
  /** Uploaded via uploadRef(..., {kind:'inbox'}). */
  inboxPaths?: string[];
  attachmentTargets?: AttachmentTarget[];
  /** 'selection' ⇒ derived from `selection`. */
  focus?: StudioFocus | 'selection';
}

export interface RefUploadResult {
  ref?: RefAsset;
  duplicateOf?: string;
  notice?: { kind: 'near_duplicate'; of: string };
}

export interface RefUploadOptions {
  label?: RefLabel;
  name?: string;
  /** 0-based insert position (0 = main ref). */
  index?: number;
  /** 0..1: bytes sent map to 0..0.95, 1 once the server has checked and stored the image. */
  onProgress?: (fraction: number) => void;
  /** Aborts the upload (the XHR is cancelled; the promise rejects with kind 'aborted'). */
  signal?: AbortSignal;
  /** sha256(original bytes) first 16 hex — exact-duplicate hint (the server re-checks). */
  hash?: string;
}

export interface StudioController {
  /** null while the first load is in flight. */
  doc: ComicDoc | null;
  loading: boolean;
  /** Fatal load error (project missing, forbidden, offline). */
  loadError: string | null;
  /** True while a stream (director turn or job) is open. */
  busy: boolean;
  /** Streaming assistant text keyed by message id (before the final `message` op lands). */
  drafts: Record<string, string>;
  /** Live status lines (most recent last); cleared when a stream ends. */
  activity: ActivityItem[];
  /** Last non-fatal stream error (shown as a dismissible notice). */
  error: string | null;
  clearError(): void;

  /**
   * Resolve a storage path to a displayable URL (signed). Undefined until signed.
   * opts.width picks the smallest variant ≥ width × min(dpr, 2); no opts ⇒ original (back-compat).
   */
  urlFor(asset?: AssetRef | string | null, opts?: { width?: number }): string | undefined;
  /**
   * Whether the signer has given up on this stored path for good (never stored, broken, out of sign attempts): the
   * same condition urlFor uses to skip a variant. Chat tiles read it (conversation/cards/renderTile unsignableOf) and
   * say "Preview unavailable", still, instead of a shimmer that never ends (PF-2 #7). Reads refs only: no request.
   */
  isUnsignable(path: string): boolean;

  /**
   * Send a user message to the Comic Director. Overloaded: (text, PendingAttachment[]) stays valid. The live controller
   * resolves a SendOutcome once the live queue ships (agent-editor plan §3 A1); `void` stays allowed for test fakes and
   * older controllers (treat void as 'sent').
   */
  send(text: string, opts?: SendOptions | PendingAttachment[]): Promise<SendOutcome | void>;
  /**
   * Run a direct action (button clicks): renders, gates, picks, patches. The live controller resolves the
   * action's StudioActOutcome (`ok`, `aborted`, `gated`, …) so card sequences can stop on a refusal or an
   * open gate; `void` stays allowed for test fakes and older controllers (read it with `actOutcomeOf`).
   */
  act(action: StudioAction): Promise<StudioActOutcome | void>;
  /** Instant local+server content edit (dialogue text, names, settings). Undo defaults to true for user edits. */
  patch(ops: DocOp[], opts?: PatchOptions): Promise<void>;
  cancel(): Promise<void>;
  /** Reload the document from the server. */
  refresh(): Promise<void>;

  /** Board navigation (cards and the director can focus a tab/target). */
  tab: StudioTab;
  setTab(tab: StudioTab): void;
  focusedPageId: string | null;
  openPage(pageId: string | null): void;
  /** Render targets currently queued/rendering (for spinners). */
  isRendering(target: RenderTarget): boolean;

  // ── v5 (contract §13.1) ──────────────────────────────────────────────────

  /** DEFAULT_CAPS until the project loads. */
  caps: StudioCaps;
  /** Easy/Pro VIEW: localStorage 'comicstudio.mode' ?? caps.defaultMode (Pro needs caps.proEditor). */
  mode: StudioMode;
  setMode(mode: StudioMode): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  selection: StudioSelection | null;
  setSelection(sel: StudioSelection | null): void;
  /** action → act(); client → runClientAction(); say/label → send(). */
  runNextStep(step: NextStep): Promise<void>;
  runClientAction(action: ClientAction): void;
  uploadRef(file: Blob, target: RefOwner, opts?: RefUploadOptions): Promise<RefUploadResult>;
  /** Fetched lazily (Share sheet / ReaderTab); refreshed when the doc's publication mirror changes. */
  publication: PublicationOwnerView | null;
  refreshPublication(): Promise<void>;

  // ── P1-CLIENTSTATE additions (optional; see the header note) ─────────────

  /** What redo would re-apply ("move a balloon"). */
  redoLabel?: string;
  /** Calm transient notice (typed "undo", chip undo, nothing to undo). */
  notice?: StudioNotice | null;
  clearNotice?(): void;
  /** Latest "open the reader" request (chips/cards); the Read tab host opens the immersive reader on a new seq. */
  readerRequest?: ReaderRequest | null;
  /** Server code of the last error (`COOLDOWN`, `CONTENT_POLICY`, `LIMIT`, `NOT_READY`, …), for tailored UI. */
  errorCode?: string | null;
  /** True while the owner's publication view is being fetched. */
  publicationLoading?: boolean;

  // ── Ship 2 (pro plan §4.6; optional: C3 fills it, absent = today's behaviour) ─────────────────────────────

  /** The save pill's state (always visible in the pro editor once C3 ships). */
  saveState?: StudioSaveState;

  // ── Live agent (agent-editor plan §3 A4; optional: absent = today's behaviour) ─────────────────────────────

  /** Where the director is editing right now (from activity.where), or null. */
  presence?: StudioPresence | null;

  // ── Live agent: the message queue, "Up next" (agent-editor plan §3 A1; optional: present only while
  //    caps.liveAgent.queue is on — absent = no queue, today's behaviour) ─────────────────────────────────────────

  /** Notes waiting in Up next, in the order they will go. */
  queue?: QueuedNote[];
  /** Why the queue waits instead of draining when the director finishes (null = it goes then). Always shown in words. */
  queueHold?: QueueHold | null;
  /** The note "Send now" sends as soon as the director has stopped (steering off, D2), or null. */
  queueSendingNow?: string | null;
  /** False once the automatic retries after a BUSY (another tab or device) are used up: the queue waits for a tap. */
  queueRetriesLeft?: boolean;
  /** "Send now" adds a text note to the director's running step (steering on and wired) instead of stopping it. */
  queueSteers?: boolean;
  /** The server's turn lock is (or may be) held — a director turn, or a plan_pages run: a message now goes to Up next. */
  turnLocked?: boolean;
  /** Replace a queued note's text (an empty edit changes nothing). */
  editQueued?(id: string, text: string): void;
  /** Move a queued note one step up (-1) or down (+1). */
  moveQueued?(id: string, dir: -1 | 1): void;
  /** Move a queued note to a position (drag and drop). */
  moveQueuedTo?(id: string, index: number): void;
  removeQueued?(id: string): void;
  /** Remove every queued note. */
  clearQueue?(): void;
  /** "Send anyway" / "Send" / "Try again": lift the hold; the queue drains as soon as the turn is free. */
  releaseQueue?(): void;
  /** Send this note now: into the running turn with steering on, else Stop the director and then send it (D2). */
  sendNow?(id: string): Promise<SendOutcome>;
}
