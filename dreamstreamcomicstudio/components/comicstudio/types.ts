// Client-side contract for the Comic Studio (v4) UI.
//
// `useStudio(projectId)` (useStudio.ts) owns the mirrored ComicDoc, the signed-URL
// cache and the live stream; every pane renders from the StudioController it returns
// and talks back through it. Panes never call the API directly.
//
// Contract §13.1: the members below "v5" were added in wave 0 (P0-C) with minimal working
// implementations; P1-CLIENTSTATE completes them (undo stack, variants, upload progress).

import type { AssetRef, ClientAction, ComicDoc, NextStep, RefAsset, RefLabel, RefOwner, RenderTarget, StudioTab } from '../../shared/comic/doc';
import type { DocOp, StudioAction } from '../../shared/comic/ops';
import type { AttachmentTarget, StudioFocus } from '../../shared/comic/events';
import type { StudioCaps, StudioMode } from '../../shared/comic/capabilities';
import type { PublicationOwnerView } from '../../shared/comic/publication';

export type { StudioTab };
/** Alias kept for existing imports (contract §1: `BoardTab = StudioTab`). */
export type BoardTab = StudioTab;

export interface ActivityItem {
  id: string;
  label: string;
  phase: 'start' | 'end';
  ok?: boolean;
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
}

export interface StudioSelection {
  pageId: string;
  lineIds: string[];
  panelN?: number;
  surface: 'page_editor' | 'board';
}

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
  index?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
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

  /** Send a user message to the Comic Director. Overloaded: (text, PendingAttachment[]) stays valid. */
  send(text: string, opts?: SendOptions | PendingAttachment[]): Promise<void>;
  /** Run a direct action (button clicks): renders, gates, picks, patches. */
  act(action: StudioAction): Promise<void>;
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
  /** Fetched lazily (Share sheet / ReaderTab). */
  publication: PublicationOwnerView | null;
  refreshPublication(): Promise<void>;
}
