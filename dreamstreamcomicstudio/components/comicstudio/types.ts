// Client-side contract for the Comic Studio (v4) UI.
//
// `useStudio(projectId)` (useStudio.ts) owns the mirrored ComicDoc, the signed-URL
// cache and the live stream; every pane renders from the StudioController it returns
// and talks back through it. Panes never call the API directly.

import type { AssetRef, ComicDoc, RenderTarget } from '../../shared/comic/doc';
import type { DocOp, StudioAction } from '../../shared/comic/ops';

export type BoardTab = 'story' | 'cast' | 'style' | 'pages' | 'read';

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

  /** Resolve a storage path to a displayable URL (signed). Undefined until signed. */
  urlFor(asset?: AssetRef | string | null): string | undefined;

  /** Send a user message (text and/or attachments) to the Comic Director. */
  send(text: string, attachments?: PendingAttachment[]): Promise<void>;
  /** Run a direct action (button clicks): renders, gates, picks, patches. */
  act(action: StudioAction): Promise<void>;
  /** Instant local+server content edit (dialogue text, names, settings). */
  patch(ops: DocOp[]): Promise<void>;
  cancel(): Promise<void>;
  /** Reload the document from the server. */
  refresh(): Promise<void>;

  /** Board navigation (cards and the director can focus a tab/target). */
  tab: BoardTab;
  setTab(tab: BoardTab): void;
  focusedPageId: string | null;
  openPage(pageId: string | null): void;
  /** Render targets currently queued/rendering (for spinners). */
  isRendering(target: RenderTarget): boolean;
}
