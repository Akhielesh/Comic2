// Internal contracts between the Comic Studio (v4) server modules.
//
// Every module depends on these interfaces, not on each other's concrete
// implementations, so the director, job runner, prompt compiler, transports and
// persistence can be tested in isolation with in-memory fakes. See
// docs/features/comic-studio-v4.md §4 for how they fit together.

import type {
  AspectRatio,
  AssetRef,
  ComicDoc,
  Resolution,
  SpendKind
} from '../../../shared/comic/doc.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import type { ImageModelSpec, ImageRoute } from '../../../shared/comic/models.js';
import type { ChatMessage, JsonSchemaSpec, ToolCall, ToolSpec } from '../ai/providers/types.js';

// ── Errors ───────────────────────────────────────────────────────────────────

export type StudioErrorCode =
  | 'NO_IMAGE_KEY'
  | 'NO_TEXT_KEY'
  | 'SAFETY_BLOCKED'
  | 'NO_IMAGE'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'PROVIDER_ERROR'
  | 'BILLING_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CANCELLED'
  | 'INTERNAL';

export class StudioError extends Error {
  readonly code: StudioErrorCode;
  readonly status: number;
  /** Safe to show the user verbatim. */
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(code: StudioErrorCode, userMessage: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(userMessage);
    this.name = 'StudioError';
    this.code = code;
    this.userMessage = userMessage;
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export interface ResolvedKey {
  key: string;
  /** User's own key (BYOK) — not billed by DreamStream, but spend is still tracked. */
  byok: boolean;
}

export interface StudioKeys {
  openrouter?: ResolvedKey;
  gemini?: ResolvedKey;
}

// ── Text LLM ─────────────────────────────────────────────────────────────────

export type TextRole = 'director' | 'writer' | 'vision';

export interface LlmRequest {
  role: TextRole;
  messages: ChatMessage[];
  jsonSchema?: JsonSchemaSpec;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streaming text callback (director narration). */
  onDelta?: (text: string) => void;
}

export interface LlmResult {
  text: string;
  json?: unknown;
  toolCalls?: ToolCall[];
  model: string;
  /** Provider-reported USD cost when available. */
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  byok: boolean;
  provider: ImageRoute;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
}

// ── Images ───────────────────────────────────────────────────────────────────

export interface ImageReference {
  /** Human label used in the prompt legend ("CHARACTER SHEET: MAYA"). */
  label: string;
  /** data: URL (the transport never fetches storage itself). */
  dataUrl: string;
}

export interface ImageRequest {
  spec: ImageModelSpec;
  resolution: Resolution;
  aspect: AspectRatio;
  prompt: string;
  references: ImageReference[];
  signal?: AbortSignal;
}

export interface ImageResult {
  dataUrl: string;
  /** Provider model id actually used. */
  model: string;
  route: ImageRoute;
  byok: boolean;
  costUsd?: number;
  /** Any text the model returned alongside the image. */
  text?: string;
  latencyMs: number;
}

export type ImageGenerator = (req: ImageRequest) => Promise<ImageResult>;

/** A compiled image job: the prompt + which stored assets to attach (in order) with labels. */
export interface CompiledImageJob {
  spec: ImageModelSpec;
  resolution: Resolution;
  aspect: AspectRatio;
  prompt: string;
  references: { label: string; path: string }[];
}

// ── Assets ───────────────────────────────────────────────────────────────────

export interface AssetStore {
  /** Store a generated image (no cropping) under the project; returns its AssetRef. */
  saveGenerated(args: { userId: string; projectId: string; dataUrl: string; model?: string }): Promise<AssetRef>;
  /** Store a user upload (image data URL) under the project. */
  saveUpload(args: { userId: string; projectId: string; dataUrl: string }): Promise<AssetRef>;
  /** Load a stored asset as a data URL (for references). Implementations cache. */
  loadDataUrl(path: string): Promise<string>;
  /** Short-lived signed URLs for display. Missing/failed paths are omitted. */
  signUrls(paths: string[]): Promise<Record<string, string>>;
  /** Draw a red outline box (normalized) on a copy of an image (Mark-up edits). */
  outlineRegion(dataUrl: string, box: { x: number; y: number; w: number; h: number }): Promise<string>;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface ProjectRowSummary {
  title: string;
  coverPath?: string;
  logline?: string;
}

export interface DocStore {
  /** Owner-scoped load. Returns null when missing or not owned by userId. */
  load(projectId: string, userId: string): Promise<ComicDoc | null>;
  /** Create the projects row + comic_docs row. */
  create(args: { projectId: string; userId: string; doc: ComicDoc }): Promise<void>;
  /** Persist the doc (and mirror the listing summary onto the projects row). */
  save(args: { projectId: string; userId: string; doc: ComicDoc; summary: ProjectRowSummary }): Promise<void>;
  /** Public (published) read; null unless the project is public and not force-private. */
  loadPublic(projectId: string): Promise<ComicDoc | null>;
  /** Legacy ComicState for "open in the new studio" import (owner only). */
  loadLegacyState(projectId: string, userId: string): Promise<{ name: string; state: Record<string, unknown> } | null>;
}

// ── Billing ──────────────────────────────────────────────────────────────────

export interface BillingReservation {
  settle(args: { costUsd?: number; imageUnits?: number; promptTokens?: number; completionTokens?: number }): Promise<{ billableUsd?: number }>;
  release(reason: string): Promise<void>;
}

export type BillingReserveResult =
  | { ok: true; reservation: BillingReservation }
  | { ok: false; code: 'BILLING_DENIED'; message: string };

export interface BillingHooks {
  reserve(args: {
    operation: string;
    provider: ImageRoute;
    model: string;
    stage: SpendKind;
    imageUnits?: number;
    resolution?: Resolution;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<BillingReserveResult>;
}

// ── Session / context ────────────────────────────────────────────────────────

export type StudioEventListener = (event: StudioEvent) => void;

export interface StudioSessionApi {
  readonly projectId: string;
  readonly userId: string;
  /** Current committed doc (immutable snapshot). */
  get doc(): ComicDoc;
  /** Apply ops atomically, bump rev, emit an `ops` event, schedule persistence. Returns the new doc. */
  commit(ops: DocOp[]): ComicDoc;
  emit(event: StudioEvent): void;
  subscribe(listener: StudioEventListener): () => void;
  /** Persist now (end of turn). */
  flush(): Promise<void>;
  /** Abort controller for the currently running turn/jobs. */
  readonly abort: AbortController;
  resetAbort(): AbortController;
}

export interface StudioContext {
  session: StudioSessionApi;
  userId: string;
  projectId: string;
  keys: StudioKeys;
  llm: LlmClient;
  images: ImageGenerator;
  assets: AssetStore;
  billing: BillingHooks;
  signal: AbortSignal;
  /** Emit signed URLs for newly created assets to the client. */
  publishUrls(paths: string[]): Promise<void>;
  /** Tracks background work started by this turn so the stream stays open until it settles. */
  track<T>(work: Promise<T>): Promise<T>;
}
