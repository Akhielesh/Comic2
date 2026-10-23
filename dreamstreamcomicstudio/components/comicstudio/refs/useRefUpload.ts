// Upload queue for reference photos (refs.md §7.1 useRefUploader, §7.5). Owner: P1-REFS.
//
// Per item:  queued → preparing → uploading (real XHR progress %) → checking → done
//                                                        ↘ duplicate | near_duplicate | rejected | failed | over_cap
// Prepare (decode + downscale) runs 1 at a time (phone memory); uploads run 3 at a time. Network
// failures, 429 and 5xx retry twice (1 s, 3 s; a 429's Retry-After wins when short); 409 / 413 /
// 415 / 422 never retry. Each row can be cancelled (xhr.abort). Over-cap files are refused inline
// BEFORE uploading ("MAYA can hold 12 photos — remove one to add more."), an exact duplicate (same
// original-file hash) is skipped for free, and a blocked image is a red row with no retry.
//
// One queue per project lives at module level, so uploads keep going when the drawer closes or the
// tab changes, and reopening the drawer shows the same rows. A `beforeunload` warning is on while
// anything is in flight. Nothing here runs on a timer except the retry back-off of a failed upload.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ComicDoc, RefAsset, RefLabel, RefOwner } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { REF_LIMITS, capFor, refOwnerKey, refsOf, totalRefs } from '../../../shared/comic/refs';
import { buildApiUrl } from '../../../services/clientConfig';
import type { StudioController } from '../types';
import { PrepareError, prepareImageFile, quickReject, type PreparedImage } from './downscale';
import { ownerLabel } from './refsModel';

export type UploadState =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'checking'
  | 'done'
  | 'duplicate'
  | 'near_duplicate'
  | 'rejected'
  | 'failed'
  | 'over_cap';

export interface UploadItem {
  id: string;
  name: string;
  owner: RefOwner;
  state: UploadState;
  /** 0..1 of the bytes sent (uploading). */
  progress: number;
  /** Row copy for every non-progress state. */
  message?: string;
  /** failed: whether [Retry] makes sense. */
  retryable?: boolean;
  /** done / near_duplicate: the stored ref. */
  ref?: RefAsset;
  /** near_duplicate: the existing look-alike's path. */
  nearOf?: string;
  /** Local thumbnail (object URL) while uploading; never for rejected images. */
  previewUrl?: string;
  attempts: number;
  label?: RefLabel;
  index?: number;
  /** sha256(original bytes) first 16 hex, once prepared (catches the same file added twice). */
  hash?: string;
}

export interface UploadParams {
  to: RefOwner;
  label?: RefLabel;
  name?: string;
  hash?: string;
  index?: number;
}

export interface UploadResponse {
  ref?: RefAsset;
  duplicateOf?: string;
  notice?: { kind: 'near_duplicate'; of: string };
  rev?: number;
  ops: DocOp[];
  urls: Record<string, string>;
}

export class RefUploadError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RefUploadError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type UploadTransport = (args: {
  projectId: string;
  blob: Blob;
  params: UploadParams;
  onProgress(fraction: number): void;
  signal: AbortSignal;
}) => Promise<UploadResponse>;

// ── XHR transport (fetch has no portable upload progress) ────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const NETWORK_COPY = "Couldn't upload — check your connection.";
export const BLOCKED_COPY = "Not added — this image doesn't fit DreamStream's content rules.";

/** The signed-in user's bearer token (lazy, like studioApi). */
async function bearer(): Promise<string | undefined> {
  try {
    const { supabase } = await import('../../../services/supabase');
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || undefined;
  } catch {
    return undefined;
  }
}

export const refsQuery = (params: UploadParams): string => {
  const q = new URLSearchParams({ to: refOwnerKey(params.to) });
  if (params.label) q.set('label', params.label);
  if (params.name) q.set('name', params.name.slice(0, REF_LIMITS.nameChars));
  if (params.hash && /^[0-9a-f]{16}$/.test(params.hash)) q.set('hash', params.hash);
  if (typeof params.index === 'number' && Number.isInteger(params.index) && params.index >= 0) q.set('index', String(params.index));
  return q.toString();
};

const parseResponse = (text: string): UploadResponse => {
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const ref = isObject(body.ref) && typeof body.ref.path === 'string' ? (body.ref as unknown as RefAsset) : undefined;
  const notice =
    isObject(body.notice) && body.notice.kind === 'near_duplicate' && typeof body.notice.of === 'string' ? { kind: 'near_duplicate' as const, of: body.notice.of } : undefined;
  const urls: Record<string, string> = {};
  if (isObject(body.urls)) for (const [k, v] of Object.entries(body.urls)) if (typeof v === 'string') urls[k] = v;
  return {
    ...(ref ? { ref } : {}),
    ...(typeof body.duplicateOf === 'string' && body.duplicateOf ? { duplicateOf: body.duplicateOf } : {}),
    ...(notice ? { notice } : {}),
    ...(typeof body.rev === 'number' ? { rev: body.rev } : {}),
    ops: Array.isArray(body.ops) ? (body.ops.filter((o) => isObject(o) && typeof o.op === 'string') as unknown as DocOp[]) : [],
    urls
  };
};

const errorFrom = (status: number, text: string, retryAfter: string | null): RefUploadError => {
  let message = '';
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    if (typeof body?.error?.message === 'string') message = body.error.message;
    if (typeof body?.error?.code === 'string') code = body.error.code;
  } catch {
    /* not JSON */
  }
  const seconds = retryAfter && /^\d{1,4}$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  if (!message) {
    message =
      status === 413
        ? 'That image is larger than 10 MB even after shrinking.'
        : status === 415
          ? 'Use a JPG, PNG, WebP, GIF or AVIF image.'
          : status === 429
            ? 'Lots of uploads at once — pausing for a moment.'
            : status >= 500
              ? 'The studio is busy — trying again.'
              : "Couldn't add that photo.";
  }
  return new RefUploadError(status, message, code, seconds !== undefined ? seconds * 1000 : undefined);
};

/** POST /api/comic/projects/:id/refs with real upload progress (XMLHttpRequest). */
export function xhrUploadRef(
  projectId: string,
  blob: Blob,
  params: UploadParams,
  opts: { onProgress?(fraction: number): void; signal?: AbortSignal; token?: string; XHR?: typeof XMLHttpRequest; timeoutMs?: number } = {}
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const Ctor = opts.XHR || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined);
    if (!Ctor) {
      reject(new RefUploadError(0, NETWORK_COPY, 'NETWORK'));
      return;
    }
    if (opts.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new Ctor();
    xhr.open('POST', buildApiUrl(`/api/comic/projects/${encodeURIComponent(projectId)}/refs?${refsQuery(params)}`));
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    if (opts.token) xhr.setRequestHeader('Authorization', `Bearer ${opts.token}`);
    xhr.timeout = opts.timeoutMs ?? 120_000;
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => opts.signal?.removeEventListener('abort', onAbort);
    if (xhr.upload) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total));
      };
      xhr.upload.onload = () => opts.onProgress?.(1);
    }
    xhr.onload = () => {
      done();
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (xhr.status >= 200 && xhr.status < 300) resolve(parseResponse(text));
      else reject(errorFrom(xhr.status, text, xhr.getResponseHeader?.('Retry-After') ?? null));
    };
    xhr.onerror = () => {
      done();
      reject(new RefUploadError(0, NETWORK_COPY, 'NETWORK'));
    };
    xhr.ontimeout = () => {
      done();
      reject(new RefUploadError(0, 'The upload timed out — check your connection.', 'NETWORK'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    xhr.send(blob);
  });
}

/** The default transport: XHR with the signed-in user's token. */
export const xhrTransport: UploadTransport = async ({ projectId, blob, params, onProgress, signal }) =>
  xhrUploadRef(projectId, blob, params, { onProgress, signal, token: await bearer() });

// ── Queue store (framework-agnostic; React binds it below) ───────────────────

export interface UploadQueueHandlers {
  /** The live doc (caps, duplicate hashes, owner names). */
  getDoc(): ComicDoc | null;
  /** Apply a stored upload to the studio (merge urls / resync). */
  onUploaded?(res: UploadResponse, item: UploadItem): void;
}

export interface UploadQueueOptions extends UploadQueueHandlers {
  projectId: string;
  transport?: UploadTransport;
  prepare?(file: Blob & { name?: string }): Promise<PreparedImage>;
  sleep?(ms: number): Promise<void>;
  maxUploads?: number;
  retryDelaysMs?: number[];
}

export interface AddOptions {
  label?: RefLabel;
  /** Insert position for the first file (0 = make it the main photo). */
  index?: number;
}

export interface UploadQueueStore {
  getSnapshot(): readonly UploadItem[];
  subscribe(listener: () => void): () => void;
  add(files: (Blob & { name?: string })[], owner: RefOwner, opts?: AddOptions): Promise<void>;
  cancel(id: string): void;
  retry(id: string): void;
  dismiss(id: string): void;
  /** Drop every finished row (done / duplicate / rejected / over_cap / failed) for an owner. */
  clearFinished(owner?: RefOwner): void;
  busy(): boolean;
  setHandlers(h: UploadQueueHandlers): void;
}

const ACTIVE: ReadonlySet<UploadState> = new Set(['queued', 'preparing', 'uploading', 'checking']);
const FINISHED: ReadonlySet<UploadState> = new Set(['done', 'duplicate', 'near_duplicate', 'rejected', 'failed', 'over_cap']);
export const isActiveUpload = (s: UploadState) => ACTIVE.has(s);

let seq = 0;
const nextId = () => `up_${Date.now().toString(36)}_${(seq += 1).toString(36)}`;
const objectUrl = (blob: Blob): string | undefined => {
  try {
    return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined;
  } catch {
    return undefined;
  }
};
const revoke = (url?: string) => {
  try {
    if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
};
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const overCapCopy = (doc: ComicDoc | null, owner: RefOwner, project = false): string => {
  if (project) return `This comic can hold ${REF_LIMITS.project} reference photos — remove some to add more.`;
  if (owner.kind === 'inbox') return `Send or assign the ${REF_LIMITS.inbox} photos you've added first.`;
  return `${ownerLabel(doc, owner)} can hold ${capFor(owner)} photos — remove one to add more.`;
};

export function createUploadQueue(options: UploadQueueOptions): UploadQueueStore {
  let items: UploadItem[] = [];
  let handlers: UploadQueueHandlers = { getDoc: options.getDoc, onUploaded: options.onUploaded };
  const listeners = new Set<() => void>();
  const files = new Map<string, Blob & { name?: string }>();
  const prepared = new Map<string, PreparedImage>();
  const aborts = new Map<string, AbortController>();
  const transport = options.transport || xhrTransport;
  const prepare = options.prepare || ((f: Blob & { name?: string }) => prepareImageFile(f));
  const sleep = options.sleep || defaultSleep;
  const maxUploads = Math.max(1, options.maxUploads ?? 3);
  const delays = options.retryDelaysMs ?? [1000, 3000];
  let preparing = 0;
  let uploading = 0;

  const emit = () => {
    items = [...items];
    for (const l of listeners) l();
  };
  const patch = (id: string, change: Partial<UploadItem>) => {
    const at = items.findIndex((i) => i.id === id);
    if (at < 0) return;
    items[at] = { ...items[at], ...change };
    emit();
  };
  const get = (id: string) => items.find((i) => i.id === id);
  const inFlight = new Set<string>();
  const finish = (id: string, change: Partial<UploadItem>) => {
    const item = get(id);
    if (!item) return;
    // A retryable failure keeps its bytes for [Retry]; everything else lets them go.
    const keepBytes = change.state === 'failed' && !!change.retryable;
    const keepPreview = keepBytes || change.state === 'done' || change.state === 'near_duplicate';
    if (!keepPreview) revoke(item.previewUrl);
    patch(id, { ...change, ...(keepPreview ? {} : { previewUrl: undefined }) });
    if (!keepBytes) {
      files.delete(id);
      prepared.delete(id);
    }
    aborts.delete(id);
  };
  const removeRow = (id: string) => {
    const cur = get(id);
    if (!cur) return;
    revoke(cur.previewUrl);
    items = items.filter((i) => i.id !== id);
    files.delete(id);
    prepared.delete(id);
    aborts.delete(id);
    emit();
  };

  /** Slots still open on an owner / the comic, counting rows already in flight. */
  const room = (owner: RefOwner, exceptId?: string): { owner: number; project: number } => {
    const doc = handlers.getDoc();
    const list = doc ? refsOf(doc, owner) : undefined;
    if (!doc || !list) return { owner: 0, project: 0 };
    const key = refOwnerKey(owner);
    const inflight = items.filter((i) => i.id !== exceptId && ACTIVE.has(i.state));
    return {
      owner: capFor(owner) - list.length - inflight.filter((i) => refOwnerKey(i.owner) === key).length,
      project: REF_LIMITS.project - totalRefs(doc) - inflight.length
    };
  };

  const pump = () => {
    // 1. Prepare one at a time.
    while (preparing < 1) {
      const next = items.find((i) => i.state === 'queued' && !prepared.has(i.id) && files.has(i.id));
      if (!next) break;
      preparing += 1;
      void runPrepare(next.id).finally(() => {
        preparing -= 1;
        pump();
      });
    }
    // 2. Upload up to maxUploads at a time.
    while (uploading < maxUploads) {
      const next = items.find((i) => i.state === 'queued' && prepared.has(i.id));
      if (!next) break;
      uploading += 1;
      void runUpload(next.id).finally(() => {
        uploading -= 1;
        pump();
      });
    }
  };

  const runPrepare = async (id: string) => {
    const file = files.get(id);
    if (!file) return;
    patch(id, { state: 'preparing' });
    try {
      const img = await prepare(file);
      const item = get(id);
      if (!item || item.state !== 'preparing') return;
      // Exact duplicate of a photo already on this owner (or another row of this batch): free skip.
      const doc = handlers.getDoc();
      const list = doc ? refsOf(doc, item.owner) || [] : [];
      const key = refOwnerKey(item.owner);
      // (A finished row keeps its hash, so the same file added again right after it landed — before
      // the studio resync shows it — is still caught here instead of costing another upload.)
      if (
        img.hash &&
        (list.some((r) => r.hash === img.hash) ||
          items.some(
            (o) => o.id !== id && refOwnerKey(o.owner) === key && (o.state === 'done' || o.state === 'near_duplicate' || ACTIVE.has(o.state)) && o.hash === img.hash
          ))
      ) {
        finish(id, { state: 'duplicate', message: 'Already added' });
        return;
      }
      prepared.set(id, img);
      patch(id, { state: 'queued', previewUrl: objectUrl(img.blob), ...(img.hash ? { hash: img.hash } : {}) });
    } catch (err) {
      const message = err instanceof PrepareError ? err.message : "That file couldn't be opened as an image.";
      finish(id, { state: 'failed', message, retryable: false });
    }
  };

  const runUpload = async (id: string) => {
    const img = prepared.get(id);
    const item = get(id);
    if (!img || !item) return;
    const controller = new AbortController();
    aborts.set(id, controller);
    inFlight.add(id);
    patch(id, { state: 'uploading', progress: 0, attempts: item.attempts + 1 });
    try {
      const res = await transport({
        projectId: options.projectId,
        blob: img.blob,
        params: { to: item.owner, ...(item.label ? { label: item.label } : {}), name: img.name, ...(img.hash ? { hash: img.hash } : {}), ...(item.index !== undefined ? { index: item.index } : {}) },
        signal: controller.signal,
        onProgress: (f) => {
          const cur = get(id);
          if (!cur || (cur.state !== 'uploading' && cur.state !== 'checking')) return;
          patch(id, f >= 1 ? { state: 'checking', progress: 1 } : { progress: f });
        }
      });
      inFlight.delete(id);
      if (!get(id)) return;
      if (res.duplicateOf) {
        finish(id, { state: 'duplicate', message: 'Already added' });
        return;
      }
      if (res.ref) {
        const doc = handlers.getDoc();
        const near = res.notice?.of;
        const list = doc ? refsOf(doc, item.owner) || [] : [];
        const n = near ? list.findIndex((r) => r.path === near) + 1 : 0;
        finish(id, near ? { state: 'near_duplicate', ref: res.ref, nearOf: near, message: n > 0 ? `Looks the same as photo ${n}` : 'Looks the same as a photo already here' } : { state: 'done', ref: res.ref, message: undefined });
        handlers.onUploaded?.(res, get(id)!);
        return;
      }
      finish(id, { state: 'failed', message: "Couldn't add that photo.", retryable: true });
    } catch (err) {
      inFlight.delete(id);
      if ((err as { name?: string })?.name === 'AbortError') {
        removeRow(id);
        return;
      }
      const e = err instanceof RefUploadError ? err : new RefUploadError(0, NETWORK_COPY, 'NETWORK');
      if (e.status === 422) return finish(id, { state: 'rejected', message: e.code === 'CONTENT_POLICY' || !e.message ? BLOCKED_COPY : `Not added — ${e.message.replace(/^./, (c) => c.toLowerCase())}` });
      if (e.status === 409 && e.code === 'LIMIT') return finish(id, { state: 'over_cap', message: e.message });
      const transient = e.status === 0 || e.status === 429 || e.status >= 500 || (e.status === 409 && e.code === 'CONFLICT');
      const cur = get(id);
      if (transient && cur && cur.attempts <= delays.length) {
        const wait = e.status === 429 && e.retryAfterMs && e.retryAfterMs <= 30_000 ? e.retryAfterMs : delays[cur.attempts - 1];
        patch(id, { state: 'checking', message: e.status === 429 ? 'Pausing for a moment…' : 'Retrying…' });
        await sleep(wait);
        const again = get(id);
        if (again && again.state === 'checking') patch(id, { state: 'queued', message: undefined, progress: 0 });
        return;
      }
      finish(id, { state: 'failed', message: e.status === 0 ? NETWORK_COPY : e.message, retryable: transient || e.status === 0 });
    }
  };

  const store: UploadQueueStore = {
    getSnapshot: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async add(list, owner, opts = {}) {
      const doc = handlers.getDoc();
      const additions: UploadItem[] = [];
      let left = room(owner);
      let index = opts.index;
      for (const file of list) {
        const id = nextId();
        const name = (file as { name?: string }).name || 'image';
        const base: UploadItem = { id, name, owner, state: 'queued', progress: 0, attempts: 0, ...(opts.label ? { label: opts.label } : {}) };
        const rejected = await quickReject(file);
        if (rejected) {
          additions.push({ ...base, state: 'failed', message: rejected, retryable: false });
          continue;
        }
        if (!doc || !refsOf(doc, owner)) {
          additions.push({
            ...base,
            state: 'failed',
            retryable: false,
            message: doc ? `${ownerLabel(doc, owner)} is no longer in the story, so nothing was uploaded.` : 'The comic is still loading — add the photo again in a moment.'
          });
          continue;
        }
        if (left.owner <= 0 || left.project <= 0) {
          additions.push({ ...base, state: 'over_cap', message: overCapCopy(doc, owner, left.owner > 0) });
          continue;
        }
        left = { owner: left.owner - 1, project: left.project - 1 };
        files.set(id, file);
        additions.push({ ...base, ...(index !== undefined ? { index } : {}) });
        if (index !== undefined) index += 1;
      }
      if (!additions.length) return;
      items = [...items, ...additions];
      emit();
      pump();
    },
    cancel(id) {
      if (!get(id)) return;
      const ctrl = aborts.get(id);
      if (ctrl && inFlight.has(id)) {
        ctrl.abort(); // the transport rejects with AbortError → the row goes
        return;
      }
      removeRow(id);
    },
    retry(id) {
      const item = get(id);
      if (!item || item.state !== 'failed' || !item.retryable) return;
      if (!files.has(id) && !prepared.has(id)) return;
      patch(id, { state: 'queued', message: undefined, progress: 0, attempts: 0 });
      pump();
    },
    dismiss(id) {
      const item = get(id);
      if (!item || ACTIVE.has(item.state)) return;
      revoke(item.previewUrl);
      items = items.filter((i) => i.id !== id);
      emit();
    },
    clearFinished(owner) {
      const key = owner ? refOwnerKey(owner) : undefined;
      const before = items.length;
      items = items.filter((i) => {
        const drop = FINISHED.has(i.state) && (!key || refOwnerKey(i.owner) === key);
        if (drop) revoke(i.previewUrl);
        return !drop;
      });
      if (items.length !== before) emit();
    },
    busy: () => items.some((i) => ACTIVE.has(i.state)),
    setHandlers(h) {
      handlers = h;
    }
  };
  return store;
}

// ── React binding ────────────────────────────────────────────────────────────

const queues = new Map<string, UploadQueueStore>();

/** The project's upload queue (one per project, survives drawer close / tab switches). */
export function uploadQueueFor(projectId: string, handlers: UploadQueueHandlers, opts: Omit<UploadQueueOptions, 'projectId' | 'getDoc' | 'onUploaded'> = {}): UploadQueueStore {
  let q = queues.get(projectId);
  if (!q) {
    q = createUploadQueue({ projectId, ...handlers, ...opts });
    queues.set(projectId, q);
  } else q.setHandlers(handlers);
  return q;
}

/** Test hook. */
export const __resetUploadQueues = () => queues.clear();

/**
 * Coalesce resyncs: an upload committed `ref_add` outside any stream, so the studio reloads once
 * (and signs the new photo). While a reload runs, another completion only marks one more reload.
 */
const refreshers = new WeakMap<StudioController, { running: boolean; again: boolean }>();
export function scheduleRefresh(studio: StudioController): void {
  let s = refreshers.get(studio);
  if (!s) {
    s = { running: false, again: false };
    refreshers.set(studio, s);
  }
  const state = s;
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  void (async () => {
    try {
      do {
        state.again = false;
        await studio.refresh().catch(() => undefined);
      } while (state.again);
    } finally {
      state.running = false;
    }
  })();
}

export interface UseRefUpload {
  items: readonly UploadItem[];
  add(files: (Blob & { name?: string })[], owner: RefOwner, opts?: AddOptions): Promise<void>;
  cancel(id: string): void;
  retry(id: string): void;
  dismiss(id: string): void;
  clearFinished(owner?: RefOwner): void;
  busy: boolean;
}

/**
 * The studio's reference-upload queue. `transport` defaults to XHR (real progress); tests pass a fake.
 * Completed uploads resync the studio once (coalesced) so the new tiles appear with signed URLs.
 */
export function useRefUpload(studio: StudioController, opts: { transport?: UploadTransport; prepare?: UploadQueueOptions['prepare']; sleep?: UploadQueueOptions['sleep'] } = {}): UseRefUpload {
  const projectId = studio.doc?.id || '';
  const handlers: UploadQueueHandlers = {
    getDoc: () => studio.doc,
    onUploaded: () => scheduleRefresh(studio)
  };
  const store = useMemo(
    () => uploadQueueFor(projectId || 'none', handlers, { transport: opts.transport, prepare: opts.prepare, sleep: opts.sleep }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId]
  );
  store.setHandlers(handlers);
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const busy = items.some((i) => isActiveUpload(i.state));

  useEffect(() => {
    if (!busy || typeof window === 'undefined') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  return {
    items,
    add: store.add,
    cancel: store.cancel,
    retry: store.retry,
    dismiss: store.dismiss,
    clearFinished: store.clearFinished,
    busy
  };
}
