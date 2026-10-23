// QA harness controller (P1-QA; mobile.md §10.2): a browser-safe stand-in for useStudio().
//
// conversation/testing/fixtures.ts imports `vi`, so it cannot ship to a browser. This file is its
// non-vitest twin for the QA entry (qa/comic-qa.html): a STATEFUL ComicStudioController whose
// `patch` applies the real shared `applyOps`, whose `urlFor` exercises the real variant pick
// (`variantFor`, DPR cap 2), and which RECORDS every call (`window.__qaOps`) so Playwright specs can
// assert "a drag sent exactly one balloon op with pinned:true" or "Enter on a phone sent nothing".
// It never touches the network, never spends, and only ever sees the synthetic fixtures.

import { useCallback, useMemo, useRef, useState } from 'react';
import { mapAssetRefs, variantFor, type AssetRef, type ClientAction, type ComicDoc, type NextStep, type RenderTarget, type StudioTab } from '../../../shared/comic/doc';
import { applyOps, type DocOp, type StudioAction } from '../../../shared/comic/ops';
import { DEFAULT_CAPS, type StudioCaps, type StudioMode } from '../../../shared/comic/capabilities';
import type { ComicStudioController } from '../useStudio';
import type { ActivityItem, PatchOptions, ReaderRequest, SendOptions, StudioNotice, StudioSelection } from '../types';
import { QA_FIXTURES, QA_NOW, isQaFixture, makeQaDoc, parseQaImagePath, type QaFixtureName } from './qaFixtures';

// ── Query parameters ─────────────────────────────────────────────────────────

export const QA_SURFACES = ['studio', 'board', 'editor', 'reader', 'classic-reader', 'public', 'kit'] as const;
export type QaSurface = (typeof QA_SURFACES)[number];

/** Scene states layered on a fixture (`state=`). */
export const QA_STATES = ['idle', 'loading', 'load-error', 'streaming', 'failed-send', 'error', 'busy'] as const;
export type QaState = (typeof QA_STATES)[number];

export type QaImageMode = 'png' | 'svg';

export interface QaParams {
  surface: QaSurface;
  fixture: QaFixtureName;
  tab: StudioTab;
  /** 1-based page (editor: the page to open; readers: the page to open on). */
  page: number | null;
  lang: string | null;
  theme: 'light' | 'dark';
  state: QaState;
  mode: StudioMode;
  rtl: boolean;
  /** Public surface: simulate the server answering 404 / 500 / never. */
  publicResult: 'ok' | 'not-found' | 'error' | 'slow';
  img: QaImageMode;
  /** Mask shimmer/caret/animations for deterministic screenshots. */
  still: boolean;
  /** surface=kit: the component scene (qa/KitScenes.tsx validates the name). */
  kit: string | null;
}

const TABS: readonly StudioTab[] = ['story', 'cast', 'style', 'pages', 'media', 'languages', 'read'];
const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => (value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);

/** Parse `?surface=studio|board|editor|reader|public|kit&fixture=…&tab=pages&page=2&lang=en&kit=…` (mobile.md §10.2). */
export const parseQaParams = (search: string, env: { webdriver?: boolean } = {}): QaParams => {
  const q = new URLSearchParams(search);
  const fixture = q.get('fixture');
  const pageRaw = Number(q.get('page') ?? q.get('p'));
  const lang = q.get('lang');
  return {
    surface: pick(q.get('surface'), QA_SURFACES, 'studio'),
    fixture: isQaFixture(fixture) ? fixture : 'heist-12p',
    tab: pick(q.get('tab'), TABS, 'pages'),
    page: Number.isInteger(pageRaw) && pageRaw > 0 && pageRaw <= 500 ? pageRaw : null,
    lang: lang && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : null,
    theme: q.get('theme') === 'dark' ? 'dark' : 'light',
    state: pick(q.get('state'), QA_STATES, 'idle'),
    mode: q.get('mode') === 'pro' ? 'pro' : 'easy',
    rtl: q.get('rtl') === '1',
    publicResult: pick(q.get('public'), ['ok', 'not-found', 'error', 'slow'] as const, 'ok'),
    // Under Playwright the PNG fixtures are served by a route; opened by hand, SVG data URLs need no server.
    img: pick(q.get('img'), ['png', 'svg'] as const, env.webdriver ? 'png' : 'svg'),
    still: q.get('still') === '1',
    kit: /^[a-z][a-z-]{0,31}$/.test(q.get('kit') || '') ? q.get('kit') : null
  };
};

export { QA_FIXTURES };

// ── Op recording (window.__qaOps) ────────────────────────────────────────────

export type QaOpKind =
  | 'patch'
  | 'act'
  | 'send'
  | 'cancel'
  | 'refresh'
  | 'setTab'
  | 'openPage'
  | 'setMode'
  | 'undo'
  | 'redo'
  | 'selection'
  | 'nextStep'
  | 'client'
  | 'upload'
  | 'retry'
  | 'dismiss'
  | 'publication'
  | 'net';

export interface QaOp {
  kind: QaOpKind;
  payload?: unknown;
  at: number;
}

export interface QaRuntimeInfo {
  params: QaParams;
  ready: boolean;
  pageCount: number;
  pageIds: string[];
  layout?: string;
}

declare global {
  interface Window {
    __qaOps?: QaOp[];
    __qa?: QaRuntimeInfo;
    /** The controller's CURRENT doc (after every patch), for spec assertions. */
    __qaDoc?: () => ComicDoc | null;
  }
}

const now = () => (typeof performance !== 'undefined' ? Math.round(performance.now()) : 0);

/** Append one call to `window.__qaOps` (a JSON-safe deep copy, so later mutations never rewrite history). */
export const recordQaOp = (kind: QaOpKind, payload?: unknown): void => {
  if (typeof window === 'undefined') return;
  let copy: unknown = payload;
  try {
    copy = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
  } catch {
    copy = String(payload);
  }
  (window.__qaOps ||= []).push({ kind, payload: copy, at: now() });
};

export const qaOps = (): QaOp[] => (typeof window === 'undefined' ? [] : window.__qaOps || []);
export const clearQaOps = (): void => {
  if (typeof window !== 'undefined') window.__qaOps = [];
};

// ── Images ───────────────────────────────────────────────────────────────────

const svgCache = new Map<string, string>();
const hueOf = (seed: string) => {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

/** Deterministic placeholder art (panel grid + label) as an SVG data URL sized like the asset. */
export const qaSvgDataUrl = (path: string): string | undefined => {
  const parsed = parseQaImagePath(path);
  if (!parsed) return undefined;
  const hit = svgCache.get(parsed.file);
  if (hit) return hit;
  const { w, h, seed } = parsed;
  const hue = hueOf(seed.replace(/-v\d+$/, ''));
  const m = Math.round(Math.min(w, h) * 0.025);
  const rowH = (h - m * 4) / 3;
  const half = (w - m * 3) / 2;
  const rects = [
    [m, m, w - 2 * m, rowH],
    [m, m * 2 + rowH, half, rowH],
    [m * 2 + half, m * 2 + rowH, half, rowH],
    [m, m * 3 + rowH * 2, w - 2 * m, rowH]
  ]
    .map(([x, y, pw, ph], i) => `<rect x="${x}" y="${y}" width="${pw}" height="${ph}" fill="hsl(${(hue + i * 40) % 360} 55% ${72 - i * 6}%)" stroke="#111" stroke-width="${Math.max(2, Math.round(w * 0.004))}"/>`)
    .join('');
  const label = parsed.file.replace(/\.png$/, '').replace(/[^a-z0-9 x._-]/gi, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fbf6ec"/>${rects}<text x="${w / 2}" y="${h - m * 1.4}" font-family="sans-serif" font-size="${Math.max(10, Math.round(w * 0.03))}" text-anchor="middle" fill="#333">${label}</text></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  svgCache.set(parsed.file, url);
  return url;
};

/** The URL the harness serves a fixture image path at (PNG route under Playwright, SVG otherwise). */
export const qaImageUrl = (path: string, mode: QaImageMode): string | undefined => {
  const parsed = parseQaImagePath(path);
  if (!parsed) return undefined;
  return mode === 'png' ? `/qa-assets/${parsed.file}` : qaSvgDataUrl(path);
};

const devicePixelRatioNow = (): number => (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

/** urlFor with the production variant rule: the smallest stored variant ≥ width × min(dpr, 2). */
export const makeQaUrlFor = (getDoc: () => ComicDoc | null, mode: QaImageMode) => {
  let indexed: { doc: ComicDoc | null; map: Map<string, AssetRef> } = { doc: null, map: new Map() };
  const withVariants = (path: string): AssetRef | undefined => {
    const doc = getDoc();
    if (!doc) return undefined;
    if (indexed.doc !== doc) {
      const map = new Map<string, AssetRef>();
      mapAssetRefs(doc, (a) => {
        if (a?.path && a.variants?.length) map.set(a.path, a);
        return a;
      });
      indexed = { doc, map };
    }
    return indexed.map.get(path);
  };
  return (asset?: AssetRef | string | null, opts?: { width?: number }): string | undefined => {
    const path = typeof asset === 'string' ? asset : asset?.path;
    if (!path) return undefined;
    if (/^(data:|blob:|https?:)/.test(path)) return path;
    let chosen = path;
    const width = opts?.width;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
      const ref = typeof asset === 'object' && asset?.variants?.length ? asset : withVariants(path);
      if (ref) chosen = variantFor(ref, width, devicePixelRatioNow()).path;
    }
    return qaImageUrl(chosen, mode);
  };
};

// ── Scene → controller ───────────────────────────────────────────────────────

export interface QaSceneInit {
  doc: ComicDoc | null;
  tab?: StudioTab;
  focusedPageId?: string | null;
  state?: QaState;
  mode?: StudioMode;
  caps?: Partial<StudioCaps>;
  img?: QaImageMode;
}

/** The scene a URL describes (fixture doc + tab/page/state), shared by every surface. */
export const qaSceneFromParams = (p: QaParams): QaSceneInit => {
  const doc = p.state === 'loading' || p.state === 'load-error' ? null : makeQaDoc(p.fixture, { rtl: p.rtl });
  const pageId = p.page && doc ? doc.pages.find((pg) => pg.n === p.page)?.id ?? null : null;
  return {
    doc,
    tab: p.tab,
    focusedPageId: p.surface === 'editor' ? pageId ?? doc?.pages[0]?.id ?? null : null,
    state: p.state,
    mode: p.mode,
    img: p.img
  };
};

const STREAM_DRAFT = 'Page 3 is on its way — I’m keeping Maya’s red scarf and the rain consistent with page 2… ';

const sceneActivity = (state: QaState | undefined): ActivityItem[] =>
  state === 'streaming' || state === 'busy'
    ? [
        { id: 'ac1', label: 'Drawing page 3 of 12 in the noir ink style with every character sheet as a reference', phase: 'start', at: QA_NOW, cost: 'image' },
        { id: 'ac2', label: 'Checked the plan — free, done by the editor', phase: 'end', ok: true, at: QA_NOW, cost: 'free' }
      ]
    : [];

/**
 * The QA controller hook. Real state for doc/tab/focus/mode/selection/undo; every call is recorded.
 * `patch` applies the shared applyOps synchronously (no server), so editors see their own edits.
 */
export const useQaController = (init: QaSceneInit): ComicStudioController => {
  const [doc, setDoc] = useState<ComicDoc | null>(init.doc);
  const docRef = useRef(doc);
  docRef.current = doc;
  if (typeof window !== 'undefined') window.__qaDoc = () => docRef.current;
  const [tab, setTabState] = useState<StudioTab>(init.tab || 'pages');
  const [focusedPageId, setFocused] = useState<string | null>(init.focusedPageId ?? null);
  const [mode, setModeState] = useState<StudioMode>(init.mode || 'easy');
  const [selection, setSelectionState] = useState<StudioSelection | null>(null);
  const [error, setError] = useState<string | null>(
    init.state === 'error' ? 'The director lost its connection mid-reply (the stream closed after 30 s). Your comic is safe — resync to pick up where it left off.' : null
  );
  const [notice, setNotice] = useState<StudioNotice | null>(null);
  const [readerRequest, setReaderRequest] = useState<ReaderRequest | null>(null);
  const [pendingFailed, setPendingFailed] = useState(init.state === 'failed-send');
  const undoStack = useRef<{ doc: ComicDoc; label?: string }[]>([]);
  const redoStack = useRef<{ doc: ComicDoc; label?: string }[]>([]);
  const [, bump] = useState(0);
  const caps = useMemo<StudioCaps>(() => ({ ...DEFAULT_CAPS, ...(init.caps || {}) }), [init.caps]);
  const urlFor = useMemo(() => makeQaUrlFor(() => docRef.current, init.img || 'svg'), [init.img]);

  const patch = useCallback(async (ops: DocOp[], opts?: PatchOptions) => {
    recordQaOp('patch', { ops, opts });
    const before = docRef.current;
    if (!before) return;
    const next = applyOps(before, ops, QA_NOW);
    if (opts?.undo !== false) {
      undoStack.current.push({ doc: before, label: opts?.label });
      redoStack.current = [];
    }
    docRef.current = next;
    setDoc(next);
  }, []);

  const undo = useCallback(() => {
    recordQaOp('undo');
    const entry = undoStack.current.pop();
    if (!entry || !docRef.current) {
      setNotice({ id: `n${now()}`, kind: 'info', text: 'Nothing to undo yet', at: QA_NOW });
      return;
    }
    redoStack.current.push({ doc: docRef.current, label: entry.label });
    docRef.current = entry.doc;
    setDoc(entry.doc);
    setNotice({ id: `n${now()}`, kind: 'undo', text: `Undid: ${entry.label || 'your last edit'}`, action: 'redo', at: QA_NOW });
  }, []);

  const redo = useCallback(() => {
    recordQaOp('redo');
    const entry = redoStack.current.pop();
    if (!entry || !docRef.current) return;
    undoStack.current.push({ doc: docRef.current, label: entry.label });
    docRef.current = entry.doc;
    setDoc(entry.doc);
    bump((n) => n + 1);
  }, []);

  const setTab = useCallback((t: StudioTab) => {
    recordQaOp('setTab', t);
    setTabState(t);
  }, []);
  const openPage = useCallback((id: string | null) => {
    recordQaOp('openPage', id);
    setFocused(id);
  }, []);
  const setMode = useCallback((m: StudioMode) => {
    recordQaOp('setMode', m);
    setModeState(m);
  }, []);
  const setSelection = useCallback((sel: StudioSelection | null) => {
    recordQaOp('selection', sel);
    setSelectionState(sel);
  }, []);

  const runClientAction = useCallback(
    (action: ClientAction) => {
      recordQaOp('client', action);
      switch (action.type) {
        case 'open_reader':
          setReaderRequest((r) => ({ seq: (r?.seq || 0) + 1, immersive: action.immersive !== false, guided: !!action.guided }));
          break;
        case 'open_page':
          setFocused(action.pageId);
          break;
        case 'open_tab':
          setTabState(action.tab);
          break;
        case 'open_share':
          window.dispatchEvent(new CustomEvent('ds:open-share'));
          break;
        case 'undo':
          undo();
          break;
        case 'set_mode':
          setModeState(action.mode);
          break;
      }
    },
    [undo]
  );

  const send = useCallback(async (text: string, opts?: SendOptions | unknown[]) => {
    recordQaOp('send', { text, opts: Array.isArray(opts) ? { attachments: opts.length } : opts });
  }, []);
  const act = useCallback(async (action: StudioAction) => {
    recordQaOp('act', action);
  }, []);
  const runNextStep = useCallback(
    async (step: NextStep) => {
      recordQaOp('nextStep', step);
      if (step.client) runClientAction(step.client);
      else if (step.action) recordQaOp('act', step.action);
      else recordQaOp('send', { text: step.say || step.label });
    },
    [runClientAction]
  );

  const isRendering = useCallback(
    (t: RenderTarget) => {
      const d = docRef.current;
      if (!d) return false;
      const busy = (s?: string) => s === 'queued' || s === 'rendering';
      switch (t.kind) {
        case 'page':
          return busy(d.pages.find((p) => p.id === t.id)?.render.status);
        case 'cover':
          return busy(d.cover.render.status);
        case 'sheet':
          return busy(d.cast.find((c) => c.id === t.id)?.sheet.status);
        case 'place':
          return busy(d.places.find((p) => p.id === t.id)?.sheet.status);
        case 'style_option':
          return busy(d.style.options.find((o) => o.id === t.id)?.render.status);
      }
      return false;
    },
    []
  );

  const streaming = init.state === 'streaming' || init.state === 'busy';
  const renderingTotal = doc
    ? doc.pages.filter((p) => p.render.status === 'queued' || p.render.status === 'rendering').length +
      doc.cast.filter((c) => c.sheet.status === 'queued' || c.sheet.status === 'rendering').length +
      doc.style.options.filter((o) => o.render.status === 'queued' || o.render.status === 'rendering').length
    : 0;
  const lastAssistant = doc ? [...doc.conversation].reverse().find((m) => m.role === 'assistant') : undefined;

  return {
    doc,
    loading: !doc && init.state !== 'load-error',
    loadError: init.state === 'load-error' ? 'This comic could not be opened (offline). Check your connection and try again.' : null,
    busy: streaming,
    drafts: init.state === 'streaming' && lastAssistant ? { [`${lastAssistant.id}_draft`]: STREAM_DRAFT.repeat(3) } : {},
    activity: sceneActivity(init.state),
    error,
    clearError: () => setError(null),
    urlFor,
    send,
    act,
    patch,
    cancel: async () => recordQaOp('cancel'),
    refresh: async () => recordQaOp('refresh'),
    tab,
    setTab,
    focusedPageId,
    openPage,
    isRendering,
    caps,
    mode,
    setMode,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    undoLabel: undoStack.current[undoStack.current.length - 1]?.label,
    redoLabel: redoStack.current[redoStack.current.length - 1]?.label,
    selection,
    setSelection,
    runNextStep,
    runClientAction,
    uploadRef: async (file, target, opts) => {
      recordQaOp('upload', { size: file.size, type: file.type, target, label: opts?.label, name: opts?.name });
      opts?.onProgress?.(1);
      return {};
    },
    publication: null,
    refreshPublication: async () => recordQaOp('publication'),
    notice,
    clearNotice: () => setNotice(null),
    readerRequest,
    errorCode: null,
    publicationLoading: false,
    // ComicStudioController
    messageBusy: streaming,
    pendingMessage: pendingFailed
      ? {
          id: 'pm_qa',
          text: 'Draw the remaining pages please, and keep the rain heavy on every rooftop panel',
          attachments: [],
          at: QA_NOW,
          status: 'failed',
          error: 'Couldn’t reach the studio. Check your connection.'
        }
      : null,
    retryPendingMessage: () => {
      recordQaOp('retry');
      setPendingFailed(false);
    },
    dismissPendingMessage: () => {
      recordQaOp('dismiss');
      setPendingFailed(false);
    },
    cancelling: false,
    refreshing: false,
    lastSpentUsd: 0.06,
    lastSavedUsd: 0.12,
    byok: caps.byok,
    renderingTotal
  };
};
