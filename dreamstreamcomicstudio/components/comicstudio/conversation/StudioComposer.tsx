// The studio composer: a calm glass box where the user talks to the Comic Director.
//
//  - Auto-growing textarea (capped at 240 px, or 30 % of the visible height on phones so the
//    keyboard never pushes the conversation away). Cmd/Ctrl+K focuses it.
//  - Enter rule (contract §13.4): on touch devices (coarse pointer — phones AND tablets) Enter is
//    a newline and the Send button sends, like mainstream mobile chat apps, so half-typed scripts
//    never go out by accident. On fine pointers Enter sends and Shift+Enter is a newline.
//    ⌘/Ctrl+Enter always sends. 16 px text on every coarse pointer (no iOS focus zoom).
//  - Attach (+), paste or drop: photos (JPG/PNG/WebP/GIF/AVIF, and HEIC where the browser can
//    read it) and scripts. On touch, + opens an action sheet: Photo library · Take a photo
//    (camera) · Script or document. Photos go through the ONE refs pipeline (refs/downscale:
//    quickReject → prepareImageFile, ≤ 40 MB originals shrunk to ≤ 2048 px, hashed) and upload to
//    the comic's inbox right away (`uploadRef(…, {kind:'inbox'})`, up to 3 at a time, with a
//    progress ring per photo); the message carries their `inboxPaths`, and Send waits until every
//    photo is in (the server only takes inbox paths that exist). An exact duplicate reuses the
//    earlier upload (free); a photo the content rules refuse, or one that doesn't fit, gets an
//    honest row (refs/UploadQueue) instead of a silent drop; an upload that keeps failing goes
//    inline with the message as before — never lost. Removing a photo deletes the inbox copy it
//    uploaded (a reused copy stays: it may belong to the other composer or to a failed message's
//    "Try again").
//    Up to 12 photos per message (REF_LIMITS.perMessageImages).
//  - Quick-assign ("Who's this?"): tap a photo to say who it is — a cast member, a new
//    character, a place or the art style — or "Assign all…" for several; the message sends
//    those as `attachmentTargets` and the server files them for free before the director turn.
//    Script files are read IN THE
//    BROWSER to plain text before upload — .txt/.md as-is, and .docx (mammoth), .pdf
//    (pdf.js) and .fdx (Final Draft XML) via scriptImport, whose parsers load only when
//    such a file is attached. The server appends short scripts to the message and saves
//    long ones as the comic's source script. Long pasted text stays in the box (a script
//    is the message); past the server's message cap it is sent as a script file instead.
//  - Voice via DictationButton with the base-snapshot pattern (partials replace only the
//    dictated segment). "Auto-send when I stop talking" sends the transcript on stop.
//  - Gemini-style option chips (format · style · quality) open anchored panels above the
//    composer; changes there are instant doc patches.
//  - While a director turn streams the send button becomes Stop ("Stop the director"). Once its
//    reply lands Send comes back while the pages it started keep drawing; their Stop is the
//    activity line's ("Stop drawing") above the docked composer, and beside Send in the phone
//    sheet, which has no activity line.
//  - A selection in the page editor shows as a focus chip ("Page 3 · 2 balloons ×"); the next
//    message is about it (`focus: 'selection'`) unless the chip is dismissed.

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, AudioLines, Camera, Crosshair, FileText, Image as ImageIcon, Palette, Plus, Sparkles, Square, Users, X } from 'lucide-react';
import { TIER_PRESETS } from '../../../shared/comic/models';
import { refInboxOf } from '../../../shared/comic/doc';
import type { AttachmentTarget } from '../../../shared/comic/events';
import { REF_LIMITS } from '../../../shared/comic/refs';
import { deleteInboxRef } from '../studioApi';
import { ACCEPT_ATTR, prepareImageFile, quickReject } from '../refs/downscale';
import { UploadQueue } from '../refs/UploadQueue';
import { BLOCKED_COPY, type UploadItem } from '../refs/useRefUpload';
import { AssignMenu, targetLabel } from './AssignMenu';
import { DictationButton } from '../../chat/DictationButton';
import { voiceInputSupported } from '../../../hooks/useDictation';
import { CONTROL_BTN, GLASS_STRONG, HAIRLINE, MUTED, RADIUS_PANEL, SHADOW_SOFT, TRANSITION } from '../../chat/studioDesign';
import type { PendingAttachment, SendOptions } from '../types';
import type { ComicStudioController } from '../useStudio';
import { COMPOSE_EVENT, type ComposeRequest } from './composerBus';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { isPhoneLayout } from '../mobile/formFactor';
import { useFormFactor } from '../mobile/useFormFactor';
import { FormatPanel } from './panels/FormatPanel';
import { StylePanel } from './panels/StylePanel';
import { QualityPanel } from './panels/QualityPanel';
import { AspectGlyph, cx } from './ui';
import { useElementSize } from '../board/ui';
import { importScriptFile, scriptKindOf, ScriptImportError, SCRIPT_ACCEPT } from './scriptImport';

export const VOICE_AUTOSEND_KEY = 'comicstudio.voiceAutoSend';
/** Largest upload body after the in-browser shrink (originals may be up to 40 MB). */
export const MAX_IMAGE_BYTES = REF_LIMITS.maxUploadBytes;
/** Files that travel INSIDE the message (scripts, and photos that couldn't upload) — server cap. */
export const MAX_ATTACHMENTS = 6;
/** Photos per message (server cap; they upload to the inbox first). */
export const MAX_IMAGES = REF_LIMITS.perMessageImages;
/** Photos uploading at the same time (preparing runs one at a time — phone memory). */
export const MAX_PARALLEL_UPLOADS = 3;
/** Characters the server keeps from one text file. */
export const MAX_TEXT_CHARS = 200_000;
/** Longest message text the server accepts; longer text is sent as a script file. */
export const MAX_MESSAGE_CHARS = 60_000;
/** The request body is capped at 10 MB of JSON; keep attachments safely under it. */
export const MAX_PAYLOAD_CHARS = 9_000_000;
const MAX_TEXTAREA_PX = 240;

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
const TEXT_EXT = /\.(txt|md|markdown|text|fountain)$/i;
// .docx/.pdf/.fdx need in-browser extraction (mammoth/pdf.js/XML); the rest are plain text.
const RICH_SCRIPT_KINDS = new Set(['docx', 'pdf', 'fdx']);
// HEIC is deliberately not listed: the iOS picker then hands over JPEG (refs.md §7.4).
const IMAGE_ACCEPT = ACCEPT_ATTR;
const ACCEPT = `${IMAGE_ACCEPT},${SCRIPT_ACCEPT}`;
/** Below this composer width the quality chip and the voice auto-send toggle step aside. */
const ROOMY_PX = 400;

export type ComposerPanel = 'format' | 'style' | 'quality';

/** A photo's way into the comic's inbox. */
export type ComposerUploadState = 'preparing' | 'queued' | 'uploading' | 'done' | 'failed';

interface ComposerAttachment extends PendingAttachment {
  id: string;
  kind: 'image' | 'text';
  /** Characters in a text attachment (for the chip). */
  chars?: number;
  truncated?: boolean;
  /**
   * Photos: inbox upload state. 'done' carries `inboxPath`; 'failed' goes inline (its `dataUrl` is
   * filled when it fails); undefined = no uploader here, the photo always goes inline.
   */
  upload?: ComposerUploadState;
  inboxPath?: string;
  /** 0..1 while uploading. */
  progress?: number;
  /** Local preview (object URL or data URL). */
  previewUrl?: string;
  /** Why the upload failed (shown on its row). */
  error?: string;
  /** The server stored it but it looks like a photo already in the inbox. */
  near?: boolean;
  /** Quick-assign: who/what this photo is (undefined = the director decides). */
  target?: AttachmentTarget;
  /** Its row (failed / looks-the-same) was dismissed; the photo stays in the message. */
  quiet?: boolean;
}

/** Photos still on their way in (Send waits for them). */
export const isUploadBusy = (state: ComposerUploadState | undefined): boolean => state === 'preparing' || state === 'queued' || state === 'uploading';

/**
 * What Enter does in the composer (contract §13.4): coarse pointers insert a newline (the Send
 * button sends); fine pointers send, Shift+Enter is a newline; ⌘/Ctrl+Enter always sends; IME
 * composition is never interrupted.
 */
export const enterAction = (
  e: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean },
  coarse: boolean
): 'send' | 'newline' | 'none' => {
  if (e.key !== 'Enter' || e.isComposing) return 'none';
  if (e.metaKey || e.ctrlKey) return 'send';
  if (coarse || e.shiftKey) return 'newline';
  return 'send';
};

/** A data: URL as a Blob (the downscaled photo is what goes to the inbox, not the 12 MB original). */
export const dataUrlToBlob = (dataUrl: string): Blob | null => {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const type = m[1] || 'application/octet-stream';
    if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type });
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
};

/** The focus chip's words for a selection ("Page 3 · 2 balloons"). */
export const selectionLabel = (
  doc: { pages: { id: string; n: number }[] } | null | undefined,
  sel: { pageId: string; lineIds: string[]; panelN?: number } | null | undefined
): string | null => {
  if (!doc || !sel?.pageId) return null;
  const page = doc.pages.find((p) => p.id === sel.pageId);
  if (!page) return null;
  const n = sel.lineIds?.length || 0;
  const detail = n ? ` · ${n} ${n === 1 ? 'balloon' : 'balloons'}` : typeof sel.panelN === 'number' ? ` · panel ${sel.panelN}` : '';
  return `Page ${page.n}${detail}`;
};

export interface StudioComposerHandle {
  focus(): void;
  addFiles(files: FileList | File[]): void;
  openPanel(panel: ComposerPanel | null): void;
}

export const readVoiceAutoSend = (): boolean => {
  try {
    const raw = window.localStorage.getItem(VOICE_AUTOSEND_KEY);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
};

const writeVoiceAutoSend = (on: boolean) => {
  try {
    window.localStorage.setItem(VOICE_AUTOSEND_KEY, on ? 'true' : 'false');
  } catch {
    /* preference just won't persist */
  }
};

const readAs = (file: File, mode: 'dataUrl' | 'text'): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    if (mode === 'dataUrl') reader.readAsDataURL(file);
    else reader.readAsText(file);
  });

/** Anything that claims to be a picture goes to the photo pipeline (which refuses SVG and friends honestly). */
const isImageFile = (f: File) => f.type.toLowerCase().startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.name || '');
const isTextFile = (f: File) => TEXT_TYPES.has(f.type.toLowerCase()) || TEXT_EXT.test(f.name);

const charCount = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k chars` : `${n} chars`);

let attachSeq = 0;
const attachId = () => `att_${Date.now().toString(36)}_${(attachSeq += 1)}`;

/** UTF-8 text as a base64 data: URL (btoa alone breaks on non-Latin-1 characters). */
export const textToDataUrl = (text: string, mimeType = 'text/plain'): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mimeType};base64,${btoa(binary)}`;
};

/**
 * What actually goes to the director: the typed text plus every attachment. Text over
 * the server's message cap becomes a script file (the server saves it as the source)
 * instead of failing the send.
 */
export const buildOutgoing = (text: string, list: PendingAttachment[]): { text: string; attachments: PendingAttachment[] } => {
  let message = text.trim();
  const attachments = list.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl }));
  if (message.length > MAX_MESSAGE_CHARS && attachments.length < MAX_ATTACHMENTS) {
    attachments.push({ name: 'pasted-script.txt', mimeType: 'text/plain', dataUrl: textToDataUrl(message.slice(0, MAX_TEXT_CHARS)) });
    message = '';
  }
  return { text: message, attachments };
};

/**
 * What goes to `studio.send`: the legacy array form unless inbox uploads, photo assignments or a
 * focus ride along. `attachmentTargets` (aligned with the IMAGE attachments in send order: inline
 * photos first, then inbox photos — useStudio.send and the server keep that order) is only sent
 * when at least one photo is assigned.
 */
export const sendArgs = (
  outgoing: { text: string; attachments: PendingAttachment[] },
  inboxPaths: string[],
  focusSelection: boolean,
  attachmentTargets?: AttachmentTarget[]
): [string, SendOptions | PendingAttachment[]] => {
  const targets = attachmentTargets && attachmentTargets.some(Boolean) ? attachmentTargets : undefined;
  if (!inboxPaths.length && !focusSelection && !targets) return [outgoing.text, outgoing.attachments];
  return [
    outgoing.text,
    {
      attachments: outgoing.attachments,
      ...(inboxPaths.length ? { inboxPaths } : {}),
      ...(targets ? { attachmentTargets: targets } : {}),
      ...(focusSelection ? { focus: 'selection' as const } : {})
    }
  ];
};

/** A blob as a data: URL (inline fallback and previews where object URLs don't exist). */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });

const objectUrlFor = (blob: Blob): string | undefined => {
  try {
    return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined;
  } catch {
    return undefined;
  }
};
const revokeUrl = (url?: string) => {
  try {
    if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
};

const NETWORK_COPY = 'Couldn’t upload yet — it will go with your message instead.';

/** An upload error the user can't fix by trying again right now. */
const errorInfo = (err: unknown): { kind: string; code: string; message: string; retryable: boolean; aborted: boolean } => {
  const e = (err && typeof err === 'object' ? err : {}) as { kind?: unknown; code?: unknown; message?: unknown; retryable?: unknown; name?: unknown };
  const kind = typeof e.kind === 'string' ? e.kind : '';
  return {
    kind,
    code: typeof e.code === 'string' ? e.code : '',
    message: typeof e.message === 'string' ? e.message : '',
    retryable: e.retryable === true || kind === 'network' || kind === 'server' || kind === 'rate_limit' || kind === 'connection_lost',
    aborted: e.name === 'AbortError' || kind === 'aborted'
  };
};

/** The progress ring over a photo chip: preparing / waiting (spinning), uploading (real %), checking. */
const UploadRing: React.FC<{ name: string; state?: ComposerUploadState; progress?: number }> = ({ name, state, progress }) => {
  const pct = Math.round(Math.max(0, Math.min(1, progress || 0)) * 100);
  const determinate = state === 'uploading';
  const checking = determinate && pct >= 95;
  const label =
    state === 'preparing' ? `Preparing ${name}` : state === 'queued' ? `Waiting to upload ${name}` : checking ? `Checking ${name}` : `Uploading ${name}`;
  const r = 19;
  const c = 2 * Math.PI * r;
  const spin = !determinate || checking;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(determinate ? { 'aria-valuenow': pct } : {})}
      className="absolute inset-0 grid place-items-center bg-black/25"
    >
      <svg viewBox="0 0 48 48" className={cx('h-9 w-9', spin && 'animate-spin motion-reduce:animate-none')} aria-hidden focusable="false">
        <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="4" />
        <circle
          cx="24"
          cy="24"
          r={r}
          fill="none"
          stroke="#fff"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={spin ? c * 0.72 : c * (1 - Math.max(0.06, pct / 100))}
          transform="rotate(-90 24 24)"
          className="transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none"
        />
      </svg>
    </span>
  );
};

export interface StudioComposerProps {
  studio: ComicStudioController;
  apiRef?: React.Ref<StudioComposerHandle>;
  className?: string;
  /**
   * 'docked' (default): the conversation's composer — listens to the composer bus and ⌘/Ctrl+K.
   * 'sheet': a second composer inside the phone Board's "Ask the Director…" sheet — no global
   * listeners (the docked one owns them), panels always open as bottom sheets.
   */
  variant?: 'docked' | 'sheet';
  /** A message went out (the phone sheet closes itself). */
  onSent?: () => void;
  /** Placeholder override (the sheet: "Ask the director about this board…"). */
  placeholder?: string;
}

export const StudioComposer: React.FC<StudioComposerProps> = ({ studio, apiRef, className, variant = 'docked', onSent, placeholder: placeholderProp }) => {
  const { doc, messageBusy, cancelling } = studio;
  const ff = useFormFactor();
  const coarse = ff.coarse;
  const phone = isPhoneLayout(ff.layout);
  const inSheet = variant === 'sheet';
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [panel, setPanel] = useState<ComposerPanel | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [autoSend, setAutoSend] = useState<boolean>(() => (typeof window === 'undefined' ? true : readVoiceAutoSend()));
  const [voiceOk] = useState<boolean>(() => {
    try {
      return voiceInputSupported();
    } catch {
      return false;
    }
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const dictationBaseRef = useRef('');
  const dragDepth = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Measured on the COMPOSER, not the window: a 320 px chat pane on a tablet is as tight as a phone.
  // Narrow: shorter placeholder; the quality chip lives in the header / ⋯ menu.
  const [rootSizeRef, rootSize] = useElementSize<HTMLDivElement>();
  const roomy = rootSize.width === 0 ? !phone : rootSize.width >= ROOMY_PX;
  // On touch, or when the voice toggle has stepped aside, + opens the attach sheet (camera, toggle).
  const attachSheet = coarse || !roomy;
  // The chip row scrolls sideways when the column is narrow — fade the clipped edge so it reads as "more".
  const [chipsClipped, setChipsClipped] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const measureChips = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    setChipsClipped((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    measureChips();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measureChips);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureChips]);
  // Chip labels change width (style name, page count, tier) without resizing the row.
  useEffect(measureChips, [measureChips, roomy, doc?.style.name, doc?.style.status, doc?.settings.quality, doc?.format.pageAspect, doc?.format.pageCount]);

  const ready = !!doc;
  const hasContent = text.trim().length > 0 || attachments.length > 0;
  // Photos still uploading hold Send (the server only takes inbox paths that exist).
  const uploadsBusy = attachments.some((a) => a.kind === 'image' && isUploadBusy(a.upload));
  const canSend = ready && hasContent && !messageBusy && !uploadsBusy;
  // The phone sheet has no activity line: renders still drawing after the reply get their Stop here.
  const stopDrawing = inSheet && ready && !messageBusy && studio.renderingTotal > 0;

  // The page-editor selection rides along as the message's focus ("Page 3 · 2 balloons") until the
  // user dismisses the chip; a new selection brings the chip back.
  const selection = studio.selection ?? null;
  const focusText = selectionLabel(doc, selection);
  const selectionKey = selection ? `${selection.pageId}|${(selection.lineIds || []).join(',')}|${selection.panelN ?? ''}` : '';
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);
  const focusActive = !!focusText && dismissedFocus !== selectionKey;

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    let cap = MAX_TEXTAREA_PX;
    try {
      const mh = parseFloat(getComputedStyle(el).maxHeight);
      if (Number.isFinite(mh) && mh > 0) cap = Math.min(cap, mh);
    } catch {
      /* jsdom */
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, []);

  // Re-measure when the composer's width changes (split drag, rotation) — visualqa P1-2.
  const lastWidth = useRef(0);
  useEffect(() => {
    if (Math.abs(rootSize.width - lastWidth.current) < 0.5) return;
    lastWidth.current = rootSize.width;
    autoGrow();
  }, [rootSize.width, autoGrow]);

  const focusEnd = useCallback(() => {
    const place = (el: HTMLTextAreaElement) => {
      autoGrow();
      const end = el.value.length;
      try {
        el.setSelectionRange(end, end);
      } catch {
        /* some input types don't support selection */
      }
    };
    // Focus synchronously when we can: iOS only raises the keyboard for a focus() inside the tap.
    const now = textareaRef.current;
    if (now && !now.disabled) {
      try {
        now.focus({ preventScroll: true });
      } catch {
        now.focus();
      }
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      if (document.activeElement !== el) el.focus();
      place(el);
    });
  }, [autoGrow]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 7000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    []
  );

  // ── Files ──────────────────────────────────────────────────────────────────

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const docRef = useRef(doc);
  docRef.current = doc;
  const studioRef = useRef(studio);
  studioRef.current = studio;
  const showNoticeRef = useRef(showNotice);
  showNoticeRef.current = showNotice;

  /**
   * Per-photo runtime (not render state): the picked file, the prepared upload body, its hash,
   * the inbox path once stored, and the abort handle. A photo is "alive" while it has an entry.
   */
  const runtime = useRef(
    new Map<
      string,
      {
        file: File;
        name: string;
        blob?: Blob;
        hash?: string;
        inboxPath?: string;
        /**
         * This composer stored that inbox copy itself. A REUSED copy (already waiting in the inbox, or
         * the server's `duplicateOf`) may belong to the other composer or to a failed message's
         * "Try again", so taking the photo out of this message must not delete it.
         */
        owned?: boolean;
        ctrl?: AbortController;
        attempts: number;
        preview?: string;
      }
    >()
  );
  const prepQueue = useRef<string[]>([]);
  const preparingNow = useRef(false);
  const uploadQueue = useRef<string[]>([]);
  const uploadingNow = useRef(0);
  /** Rows for photos that never became attachments (refused, didn't fit, couldn't be read). */
  const [rows, setRows] = useState<UploadItem[]>([]);
  const mountedRef = useRef(true);

  const patchAtt = useCallback((id: string, p: Partial<ComposerAttachment>) => {
    if (!mountedRef.current) return;
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a)));
  }, []);

  const addRow = useCallback((row: Omit<UploadItem, 'owner' | 'progress' | 'attempts'>) => {
    if (!mountedRef.current) return;
    const item: UploadItem = { owner: { kind: 'inbox' }, progress: 0, attempts: 0, ...row };
    setRows((prev) => [...prev.filter((r) => r.id !== row.id), item].slice(-MAX_IMAGES));
  }, []);

  /** Drop the comic's inbox copy of a photo the user took out (the inbox also prunes itself after 24 h). */
  const dropInboxCopy = useCallback((path: string | undefined) => {
    const projectId = docRef.current?.id;
    if (!path || !projectId) return;
    // Another photo of this message may still use the same stored copy (a re-added duplicate).
    for (const rt of runtime.current.values()) if (rt.inboxPath === path) return;
    void deleteInboxRef(projectId, path).catch(() => undefined);
  }, []);

  /** Take a photo out of the message (and out of the pipeline). */
  const forget = useCallback((id: string) => {
    const rt = runtime.current.get(id);
    runtime.current.delete(id);
    rt?.ctrl?.abort();
    revokeUrl(rt?.preview);
    prepQueue.current = prepQueue.current.filter((x) => x !== id);
    uploadQueue.current = uploadQueue.current.filter((x) => x !== id);
    if (mountedRef.current) setAttachments((prev) => prev.filter((a) => a.id !== id));
    return rt;
  }, []);

  // Abort in-flight uploads and free previews when the composer goes away.
  useEffect(() => {
    mountedRef.current = true;
    const map = runtime.current;
    return () => {
      mountedRef.current = false;
      map.forEach((rt) => {
        rt.ctrl?.abort();
        revokeUrl(rt.preview);
      });
      map.clear();
    };
  }, []);

  /** Another photo of this message already uses that inbox path. */
  const pathTaken = (path: string, exceptId: string) => {
    for (const [id, rt] of runtime.current) if (id !== exceptId && rt.inboxPath === path) return true;
    return false;
  };

  /** A failed upload keeps the photo: it travels inline with the message (as before). */
  const failToInline = useCallback(
    async (id: string, message: string) => {
      const rt = runtime.current.get(id);
      if (!rt) return;
      let dataUrl = '';
      try {
        dataUrl = await blobToDataUrl(rt.blob || rt.file);
      } catch {
        /* unreadable: the row says so and the photo can be removed */
      }
      if (!runtime.current.has(id)) return;
      patchAtt(id, { upload: 'failed', error: dataUrl ? message : 'Couldn’t read this photo — remove it and add it again.', dataUrl, mimeType: (rt.blob || rt.file).type || 'image/jpeg', progress: 0 });
    },
    [patchAtt]
  );

  const pumpUploads = useCallback(() => {
    while (uploadingNow.current < MAX_PARALLEL_UPLOADS && uploadQueue.current.length) {
      const id = uploadQueue.current.shift()!;
      const rt = runtime.current.get(id);
      if (!rt?.blob) continue;
      uploadingNow.current += 1;
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      void uploadOne(id).finally(() => {
        uploadingNow.current -= 1;
        pumpUploads();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadOne = useCallback(
    async (id: string): Promise<void> => {
      const rt = runtime.current.get(id);
      const upload = studioRef.current.uploadRef;
      if (!rt?.blob || typeof upload !== 'function') return;
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      rt.ctrl = ctrl;
      rt.attempts += 1;
      patchAtt(id, { upload: 'uploading', progress: 0, error: undefined });
      try {
        const res = await upload(rt.blob, { kind: 'inbox' }, {
          name: rt.name,
          ...(rt.hash ? { hash: rt.hash } : {}),
          ...(ctrl ? { signal: ctrl.signal } : {}),
          onProgress: (f) => {
            if (runtime.current.has(id)) patchAtt(id, { progress: Math.max(0, Math.min(1, f)) });
          }
        });
        const stored = res?.ref?.path;
        // An exact duplicate of a photo already in the inbox: use that copy (free, no second upload).
        const path = stored || res?.duplicateOf;
        if (!runtime.current.has(id)) {
          // Removed while it was uploading: don't leave the new copy behind.
          if (stored && !res?.duplicateOf) dropInboxCopy(stored);
          return;
        }
        if (!path) {
          await failToInline(id, 'Couldn’t add that photo to the comic — it will go with your message instead.');
          return;
        }
        if (pathTaken(path, id)) {
          forget(id);
          showNoticeRef.current(`${rt.name} is already in this message.`);
          return;
        }
        rt.inboxPath = path;
        rt.owned = !!stored && !res?.duplicateOf;
        patchAtt(id, { upload: 'done', inboxPath: path, progress: 1, near: !!stored && res?.notice?.kind === 'near_duplicate' });
      } catch (err) {
        if (!runtime.current.has(id)) return;
        const e = errorInfo(err);
        if (e.aborted) return;
        // Refused by the content rules: out of the message, with an honest row (never re-sent inline to fail later).
        if (e.kind === 'content_policy' || e.code === 'CONTENT_POLICY' || e.code === 'SAFETY_BLOCKED') {
          forget(id);
          addRow({ id, name: rt.name, state: 'rejected', message: e.message ? `Not added — ${e.message.replace(/^./, (c) => c.toLowerCase())}` : BLOCKED_COPY });
          return;
        }
        // The inbox (or the comic) is full: say so; nothing was stored.
        if (e.kind === 'limit' || e.code === 'LIMIT') {
          forget(id);
          addRow({ id, name: rt.name, state: 'over_cap', message: e.message || 'This comic can’t take more photos right now — send or remove some first.' });
          return;
        }
        // One calm automatic retry for a network blip or a busy server; then the photo goes inline.
        if (e.retryable && rt.attempts < 2) {
          patchAtt(id, { upload: 'queued', progress: 0 });
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
          if (!runtime.current.has(id)) return;
          uploadQueue.current.push(id);
          return;
        }
        await failToInline(id, e.kind === 'network' || e.kind === 'connection_lost' || !e.message ? NETWORK_COPY : `${e.message} It will go with your message instead.`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchAtt, failToInline, forget, addRow, dropInboxCopy]
  );

  const pumpPrepare = useCallback(async () => {
    if (preparingNow.current) return;
    preparingNow.current = true;
    try {
      while (prepQueue.current.length) {
        const id = prepQueue.current.shift()!;
        const rt = runtime.current.get(id);
        if (!rt) continue;
        try {
          const img = await prepareImageFile(rt.file);
          if (!runtime.current.has(id)) continue;
          // The same picture twice in one message: keep the first.
          if (img.hash && [...runtime.current].some(([other, r]) => other !== id && r.hash === img.hash)) {
            forget(id);
            showNoticeRef.current(`${rt.name} is already in this message.`);
            continue;
          }
          rt.blob = img.blob;
          rt.hash = img.hash;
          const preview = objectUrlFor(img.blob) || (await blobToDataUrl(img.blob).catch(() => ''));
          if (!runtime.current.has(id)) {
            revokeUrl(preview);
            continue;
          }
          rt.preview = preview;
          // Already in this comic's inbox (added earlier, not sent yet): reuse that copy — free.
          const inboxDoc = docRef.current;
          const known = img.hash && inboxDoc ? refInboxOf(inboxDoc).find((r) => r.hash === img.hash) : undefined;
          if (known && !pathTaken(known.path, id)) {
            rt.inboxPath = known.path;
            patchAtt(id, { upload: 'done', inboxPath: known.path, progress: 1, previewUrl: preview, mimeType: img.mimeType });
            continue;
          }
          if (typeof studioRef.current.uploadRef !== 'function') {
            // No uploader (an older controller): the photo travels inline, already shrunk.
            const dataUrl = await blobToDataUrl(img.blob).catch(() => '');
            if (runtime.current.has(id)) patchAtt(id, { upload: undefined, dataUrl, previewUrl: preview, mimeType: img.mimeType });
            continue;
          }
          patchAtt(id, { upload: 'queued', previewUrl: preview, mimeType: img.mimeType, progress: 0 });
          uploadQueue.current.push(id);
          pumpUploads();
        } catch (err) {
          if (!runtime.current.has(id)) continue;
          forget(id);
          addRow({ id, name: rt.name, state: 'failed', retryable: false, message: err instanceof Error && err.message ? err.message : 'That file couldn’t be opened as an image.' });
        }
      }
    } finally {
      preparingNow.current = false;
    }
  }, [patchAtt, pumpUploads, forget, addRow]);

  const addFiles = useCallback(
    async (input: FileList | File[]) => {
      const files = Array.from(input || []);
      if (!files.length) return;
      const problems: string[] = [];
      const added: ComposerAttachment[] = [];
      let images = attachmentsRef.current.filter((a) => a.kind === 'image').length;
      let texts = attachmentsRef.current.filter((a) => a.kind === 'text').length;
      let payload = attachmentsRef.current.filter((a) => a.kind === 'text').reduce((n, a) => n + a.dataUrl.length, 0);
      const fits = (dataUrl: string, name: string) => {
        if (payload + dataUrl.length > MAX_PAYLOAD_CHARS) {
          problems.push(`${name} doesn't fit — one message can carry about 9 MB of text files. Send it in the next message`);
          return false;
        }
        return true;
      };
      for (const file of files) {
        if (isImageFile(file)) {
          if (images >= MAX_IMAGES) {
            if (!problems.some((p) => p.startsWith('Up to'))) problems.push(`Up to ${MAX_IMAGES} photos per message — send these, then add more`);
            continue;
          }
          const name = file.name || 'photo.jpg';
          // Cheap checks first (type, the 40 MB original limit) — the honest reason, before any work.
          const refused = await quickReject(file);
          if (refused) {
            addRow({ id: attachId(), name, state: 'failed', retryable: false, message: refused });
            continue;
          }
          const att: ComposerAttachment = { id: attachId(), kind: 'image', name, mimeType: file.type || 'image/jpeg', dataUrl: '', upload: 'preparing', progress: 0 };
          runtime.current.set(att.id, { file, name, attempts: 0 });
          prepQueue.current.push(att.id);
          added.push(att);
          images += 1;
        } else if (isTextFile(file)) {
          if (texts >= MAX_ATTACHMENTS) {
            problems.push(`Up to ${MAX_ATTACHMENTS} files per message`);
            continue;
          }
          try {
            const content = (await readAs(file, 'text')).replace(/\r\n?/g, '\n');
            if (!content.trim()) {
              problems.push(`${file.name} is empty`);
              continue;
            }
            const truncated = content.length > MAX_TEXT_CHARS;
            const kept = truncated ? content.slice(0, MAX_TEXT_CHARS) : content;
            const mimeType = /\.(md|markdown)$/i.test(file.name) ? 'text/markdown' : 'text/plain';
            const dataUrl = textToDataUrl(kept, mimeType);
            if (!fits(dataUrl, file.name || 'That file')) continue;
            added.push({ id: attachId(), kind: 'text', name: file.name || 'script.txt', mimeType, dataUrl, chars: kept.length, truncated });
            payload += dataUrl.length;
            texts += 1;
            if (truncated) problems.push(`${file.name} was trimmed to the first ${charCount(MAX_TEXT_CHARS)}`);
          } catch {
            problems.push(`Couldn't read ${file.name}`);
          }
        } else if (RICH_SCRIPT_KINDS.has(scriptKindOf(file.name, file.type) || '')) {
          if (texts >= MAX_ATTACHMENTS) {
            problems.push(`Up to ${MAX_ATTACHMENTS} files per message`);
            continue;
          }
          // .docx / .pdf / .fdx — extract to plain text in the browser, then upload the text.
          try {
            const imported = await importScriptFile(file);
            const dataUrl = textToDataUrl(imported.text, 'text/plain');
            if (!fits(dataUrl, file.name || 'That script')) continue;
            added.push({ id: attachId(), kind: 'text', name: `${imported.name}.txt`, mimeType: 'text/plain', dataUrl, chars: imported.text.length, truncated: imported.truncated });
            payload += dataUrl.length;
            texts += 1;
            if (imported.truncated) problems.push(`${file.name} was trimmed to the first ${charCount(MAX_TEXT_CHARS)}`);
          } catch (err) {
            problems.push(err instanceof ScriptImportError ? err.message : `Couldn't read ${file.name}`);
          }
        } else {
          problems.push(`${file.name || 'That file'} isn't supported — use JPG, PNG, WebP, GIF or AVIF photos, or .txt/.md/.docx/.pdf/.fdx/.fountain scripts`);
        }
      }
      if (added.length) {
        setAttachments((prev) => [...prev, ...added]);
        void pumpPrepare();
      }
      if (problems.length) {
        showNotice(`${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}.`);
      }
      for (const input of [fileInputRef, photoInputRef, cameraInputRef, scriptInputRef]) if (input.current) input.current.value = '';
      // Phones: don't pop the keyboard over the photo the user just picked.
      if (added.length && !coarse) focusEnd();
    },
    [focusEnd, showNotice, pumpPrepare, addRow, coarse]
  );

  const removeAttachment = (id: string) => {
    const rt = forget(id);
    // Only the copy this composer uploaded: a reused inbox copy is someone else's to keep.
    if (rt?.owned) dropInboxCopy(rt.inboxPath);
    // Its "Who's this?" menu (or "Assign all" over fewer than two photos) has nothing left to point at.
    setAssigning((cur) => (cur === id || (cur === 'all' && attachmentsRef.current.filter((a) => a.kind === 'image' && a.id !== id).length < 2) ? null : cur));
  };

  /** Retry a photo whose upload failed (it was going to go inline). */
  const retryAttachment = (id: string) => {
    const rt = runtime.current.get(id);
    if (!rt?.blob) return;
    rt.attempts = 0;
    patchAtt(id, { upload: 'queued', error: undefined, progress: 0, quiet: false });
    uploadQueue.current.push(id);
    pumpUploads();
  };

  // ── Quick-assign ("Who's this?") ──────────────────────────────────────────

  /** Which photo's menu is open ('all' = Assign all…). */
  const [assigning, setAssigning] = useState<string | 'all' | null>(null);
  const assignAnchorRef = useRef<HTMLElement | null>(null);
  const assignAllRef = useRef<HTMLButtonElement>(null);
  const imageAttachments = attachments.filter((a) => a.kind === 'image');
  const assignTo = (target: AttachmentTarget) => {
    const ids = assigning === 'all' ? imageAttachments.map((a) => a.id) : assigning ? [assigning] : [];
    // `null` (let the director decide) clears the choice.
    setAttachments((prev) => prev.map((a) => (ids.includes(a.id) ? { ...a, target: target || undefined } : a)));
    setAssigning(null);
  };

  /** Rows under the photos: refused / didn't fit / couldn't read, plus failed or look-alike photos. */
  const queueItems: UploadItem[] = [
    ...rows,
    ...attachments
      .filter((a) => a.kind === 'image' && !a.quiet && (a.upload === 'failed' || a.near))
      .map(
        (a): UploadItem => ({
          id: a.id,
          name: a.name,
          owner: { kind: 'inbox' },
          progress: 0,
          attempts: 0,
          state: a.upload === 'failed' ? 'failed' : 'near_duplicate',
          message: a.upload === 'failed' ? a.error || NETWORK_COPY : 'Looks the same as a photo you added earlier',
          retryable: a.upload === 'failed' && !!runtime.current.get(a.id)?.blob && typeof studio.uploadRef === 'function',
          ...(a.previewUrl ? { previewUrl: a.previewUrl } : {})
        })
      )
  ];

  /** The ✕ on a chip. The corner position lives on a wrapper: on touch, index.css's
   *  `.tap-target { position: relative }` (unlayered, after the utilities) would override `absolute`
   *  on the button itself and drop the ✕ into the flow under the thumbnail. */
  const removeButton = (a: ComposerAttachment) => (
    <span className="absolute -right-1.5 -top-1.5 flex" data-attachment-remove>
      <button
        type="button"
        onClick={() => removeAttachment(a.id)}
        aria-label={`Remove ${a.name}`}
        className={`tap-target grid h-5 w-5 place-items-center rounded-full bg-[var(--ds-ink)] text-[var(--ds-canvas)] ${SHADOW_SOFT} ${TRANSITION} hover:scale-105 coarse:h-6 coarse:w-6`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );

  // ── Send ───────────────────────────────────────────────────────────────────

  const busyCount = attachments.filter((a) => a.kind === 'image' && isUploadBusy(a.upload)).length;

  const sendNow = useCallback(
    (rawText: string, list: ComposerAttachment[]) => {
      if (!ready || messageBusy) return false;
      // Photos still on their way in: the server only takes inbox paths that exist — wait.
      if (list.some((a) => a.kind === 'image' && isUploadBusy(a.upload))) return false;
      // Photos in the comic's inbox travel by path; the rest (no uploader, failed) go inline.
      const uploaded = list.filter((a) => a.kind === 'image' && a.upload === 'done' && a.inboxPath);
      const inline = list.filter((a) => !uploaded.includes(a) && (a.kind === 'text' || !!a.dataUrl));
      if (inline.length > MAX_ATTACHMENTS || inline.reduce((n, a) => n + a.dataUrl.length, 0) > MAX_PAYLOAD_CHARS) {
        showNotice('That’s too much to carry inside one message — retry the photos that didn’t upload, or remove some.');
        return false;
      }
      const inboxPaths = uploaded.map((a) => a.inboxPath as string);
      const outgoing = buildOutgoing(rawText, inline);
      if (!outgoing.text && !outgoing.attachments.length && !inboxPaths.length) return false;
      // Aligned with the IMAGE attachments as sent: inline photos first, then inbox photos.
      const targets: AttachmentTarget[] = [...inline.filter((a) => a.kind === 'image'), ...uploaded].map((a) => a.target ?? null);
      const [sendText, opts] = sendArgs(outgoing, inboxPaths, focusActive, targets);
      void studio.send(sendText, opts);
      // Sent photos leave the pipeline (their inbox copies now belong to the message).
      for (const a of list) {
        const rt = runtime.current.get(a.id);
        runtime.current.delete(a.id);
        revokeUrl(rt?.preview);
      }
      setText('');
      setAttachments([]);
      setRows([]);
      setHint(null);
      setPanel(null);
      setAttachOpen(false);
      setAssigning(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      });
      onSent?.();
      return true;
    },
    [messageBusy, ready, studio, focusActive, onSent, showNotice]
  );

  const submit = () => {
    if (!canSend) return;
    sendNow(text, attachments);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = enterAction(
      { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing },
      coarse
    );
    if (action !== 'send') return; // a newline (or any other key) is the textarea's own default
    e.preventDefault();
    submit();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []);
    const usable = files.filter((f) => isImageFile(f) || isTextFile(f));
    if (!usable.length) return; // plain text (even a long script) pastes normally
    e.preventDefault();
    void addFiles(usable);
  };

  // ── Voice ──────────────────────────────────────────────────────────────────

  const joinDictation = (spoken: string) => {
    const base = dictationBaseRef.current;
    return base ? `${base.replace(/\s+$/, '')} ${spoken}` : spoken;
  };

  const applyDictation = (spoken: string) => {
    if (!spoken) return;
    setText(joinDictation(spoken));
    requestAnimationFrame(autoGrow);
  };

  const onDictationFinal = (spoken: string) => {
    const said = (spoken || '').trim();
    if (!said) return;
    const joined = joinDictation(said);
    if (autoSend && ready && !messageBusy && sendNow(joined, attachmentsRef.current)) return;
    // Not sent (photos still uploading, or auto-send is off): the words wait in the box.
    setText(joined);
    if (autoSend && attachmentsRef.current.some((a) => a.kind === 'image' && isUploadBusy(a.upload))) {
      showNotice('Your photos are still uploading — tap Send when they’re in.');
    }
    focusEnd();
  };

  const toggleAutoSend = () => {
    setAutoSend((on) => {
      writeVoiceAutoSend(!on);
      return !on;
    });
  };

  // ── External requests (empty state, cards, board, shortcuts) ──────────────

  useImperativeHandle(
    apiRef,
    () => ({
      focus: focusEnd,
      addFiles: (files) => void addFiles(files),
      openPanel: (p) => setPanel(p)
    }),
    [addFiles, focusEnd]
  );

  useEffect(() => {
    if (inSheet) return; // the docked composer is the bus's one listener
    const onCompose = (e: Event) => {
      const req = ((e as CustomEvent<ComposeRequest>).detail || {}) as ComposeRequest;
      if (typeof req.text === 'string') setText((prev) => (req.append && prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${req.text}` : req.text!));
      if (req.hint !== undefined) setHint(req.hint || null);
      if (req.openPanel === 'format' || req.openPanel === 'style' || req.openPanel === 'quality') setPanel(req.openPanel);
      if (req.pickFiles) fileInputRef.current?.click();
      else if (req.focus !== false && !req.openPanel) focusEnd();
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [focusEnd, inSheet]);

  useEffect(() => {
    if (inSheet) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusEnd();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusEnd, inSheet]);

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      void addFiles(e.dataTransfer.files);
    }
  };


  // ── Render ─────────────────────────────────────────────────────────────────

  const format = doc?.format;
  const styleName = doc?.style.status !== 'empty' ? doc?.style.name : undefined;
  const tierLabel = TIER_PRESETS[doc?.settings.quality || 'standard']?.label || 'Standard';
  const placeholder =
    hint ||
    placeholderProp ||
    (doc?.conversation.length
      ? 'Reply, or describe a change…'
      : roomy
        ? 'Describe your comic, paste a script, or drop in character photos…'
        : 'Describe your comic or paste a script…');
  const panelLabel = panel === 'format' ? 'Format' : panel === 'style' ? 'Style' : 'Quality';
  // Phones: the box never grows past 30 % of the visible height, so the keyboard can't push the
  // conversation away (mobile.md §3.8); elsewhere the 240 px cap of today.
  const textareaMaxHeight = phone ? `min(${MAX_TEXTAREA_PX}px, calc(var(--app-h, 100dvh) * 0.3))` : `${MAX_TEXTAREA_PX}px`;
  const showVoiceToggleInline = voiceOk && roomy;
  const iconBtn = 'grid h-8 w-8 shrink-0 place-items-center rounded-full coarse:h-11 coarse:w-11';

  // The chip's accessible name is its visible text with a spoken prefix ("Format: 2:3 · 6p"), so
  // voice-control users can say what they see; the title keeps the longer description.
  const chip = (id: ComposerPanel, label: React.ReactNode, title: string, extra?: string, spoken?: string) => (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={panel === id}
      title={title}
      disabled={!ready}
      onClick={() => setPanel((p) => (p === id ? null : id))}
      className={cx(
        `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium ${TRANSITION} disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:px-3.5 coarse:text-[13px]`,
        panel === id
          ? 'border-[#D97757]/45 bg-[#D97757]/10 text-[var(--ds-ink)]'
          : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]',
        extra
      )}
    >
      {spoken && <span className="sr-only">{spoken}: </span>}
      {label}
    </button>
  );

  /** A row of the attach sheet (44 px, 48 on touch); picking it opens the native picker in the same tap. */
  const attachRow = (key: string, icon: React.ReactNode, label: string, detail: string, onPick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      onClick={() => {
        onPick();
        setAttachOpen(false);
      }}
      className={`press flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:bg-[var(--ds-hover)] focus-visible:outline-none coarse:min-h-[48px]`}
    >
      <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--ds-surface-soft)] text-[var(--ds-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-[var(--ds-ink)]">{label}</span>
        <span className={`block truncate text-[11.5px] ${MUTED}`}>{detail}</span>
      </span>
    </button>
  );

  return (
    <div ref={rootSizeRef} className={cx('relative min-w-0', className)} data-composer={variant} {...dropHandlers}>
      {doc && (
        <AdaptiveSheet
          open={panel !== null}
          onClose={() => setPanel(null)}
          label={panelLabel}
          title={panelLabel}
          anchorRef={chipsRef}
          // Inside the phone sheet the panels stack as their own bottom sheet; elsewhere they pop above
          // the composer as before (popover), or become a bottom sheet on phones / with the keyboard up.
          presentation={inSheet ? 'bottom' : 'auto'}
          strategy="absolute"
        >
          {panel === 'format' && <FormatPanel doc={doc} patch={studio.patch} byok={studio.byok} caps={studio.caps} />}
          {panel === 'style' && (
            <StylePanel
              doc={doc}
              patch={studio.patch}
              act={studio.act}
              byok={studio.byok}
              caps={studio.caps}
              onDone={() => setPanel(null)}
              onDescribeOwn={() => {
                setText((prev) => (prev.trim() ? prev : 'Art style: '));
                setHint('Describe the look — medium, line, color, mood, artists you love…');
                focusEnd();
              }}
            />
          )}
          {panel === 'quality' && <QualityPanel doc={doc} patch={studio.patch} byok={studio.byok} caps={studio.caps} onDone={() => setPanel(null)} />}
        </AdaptiveSheet>
      )}

      <AdaptiveSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        label="Add to your message"
        title="Add to your message"
        anchorRef={plusRef}
        placement="above"
        align="start"
        presentation={inSheet ? 'bottom' : 'auto'}
        className="w-72 py-1"
      >
        <div role="menu" aria-label="Add to your message" className="flex flex-col p-1.5">
          {attachRow('photos', <ImageIcon className="h-4 w-4" />, 'Photo library', 'Character photos or style references', () => photoInputRef.current?.click())}
          {coarse && attachRow('camera', <Camera className="h-4 w-4" />, 'Take a photo', 'Use the camera — a person, a sketch, a place', () => cameraInputRef.current?.click())}
          {attachRow('script', <FileText className="h-4 w-4" />, 'Script or document', '.txt · .md · .docx · .pdf · .fdx · .fountain', () => scriptInputRef.current?.click())}
          {voiceOk && !showVoiceToggleInline && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={autoSend}
              onClick={toggleAutoSend}
              className={`press mt-1 flex min-h-[44px] w-full items-center gap-3 rounded-xl border-t border-[var(--ds-hairline-soft)] px-3 py-1.5 text-left ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:bg-[var(--ds-hover)] focus-visible:outline-none coarse:min-h-[48px]`}
            >
              <AudioLines className={cx('h-4 w-4 shrink-0', autoSend ? 'text-[var(--ds-accent)]' : MUTED)} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-[var(--ds-ink)]">Voice sends when I stop talking</span>
                <span className={`block truncate text-[11.5px] ${MUTED}`}>{autoSend ? 'On — tap to review before sending' : 'Off — the text waits for you'}</span>
              </span>
            </button>
          )}
        </div>
      </AdaptiveSheet>

      {doc && (
        <AdaptiveSheet
          open={assigning !== null}
          onClose={() => setAssigning(null)}
          label={assigning === 'all' ? 'Who’s in these photos?' : 'Who’s in this photo?'}
          title={assigning === 'all' ? 'Who’s in these photos?' : 'Who’s in this photo?'}
          anchorRef={assigning === 'all' ? assignAllRef : assignAnchorRef}
          placement="above"
          align="start"
          presentation={inSheet ? 'bottom' : 'auto'}
          className="w-[min(18rem,calc(100vw-24px))] py-1"
        >
          {assigning !== null && (
            <AssignMenu
              doc={doc}
              count={assigning === 'all' ? imageAttachments.length : 1}
              value={
                assigning === 'all'
                  ? imageAttachments.every((a) => JSON.stringify(a.target ?? null) === JSON.stringify(imageAttachments[0]?.target ?? null))
                    ? imageAttachments[0]?.target
                    : undefined
                  : attachments.find((a) => a.id === assigning)?.target
              }
              onPick={assignTo}
              allowClear
            />
          )}
        </AdaptiveSheet>
      )}

      <div
        className={cx(
          `${GLASS_STRONG} ${HAIRLINE} ${inSheet ? '' : SHADOW_SOFT} ${RADIUS_PANEL} px-3 pb-2.5 pt-2 transition-shadow duration-300 focus-within:border-[#D97757]/40 focus-within:shadow-[0_0_0_1px_rgba(217,119,87,0.35),0_2px_10px_rgba(217,119,87,0.14),0_18px_46px_rgba(217,119,87,0.10)]`,
          dragOver && 'border-[#D97757]/60 ring-2 ring-[#D97757]/30'
        )}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-[var(--ds-surface-strong)] text-[13px] font-medium text-[var(--ds-ink)]">
            Drop images or a script to attach
          </div>
        )}

        {focusActive && (
          <div className="mb-1.5 flex min-w-0 pt-0.5">
            <span
              data-focus-chip
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-[#D97757]/35 bg-[#D97757]/10 py-0.5 pl-2.5 pr-0.5 text-[12px] font-medium text-[var(--ds-ink)]"
            >
              <Crosshair className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
              <span className="min-w-0 truncate" title={`Your next message is about ${focusText}`}>
                About {focusText}
              </span>
              <button
                type="button"
                onClick={() => setDismissedFocus(selectionKey)}
                aria-label={`Don’t tie the next message to ${focusText}`}
                title="Not about this selection"
                className={`tap-target grid h-6 w-6 shrink-0 place-items-center rounded-full ${MUTED} ${TRANSITION} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          </div>
        )}

        {queueItems.length > 0 && (
          <UploadQueue
            className="mb-2"
            items={queueItems}
            onCancel={(id) => removeAttachment(id)}
            onRetry={(id) => retryAttachment(id)}
            onDismiss={(id) => {
              // A row of a photo that is still in the message only hides (the photo stays);
              // a row of a photo that never made it in simply goes.
              if (runtime.current.has(id)) patchAtt(id, { near: false, error: undefined, quiet: true });
              else setRows((prev) => prev.filter((r) => r.id !== id));
            }}
            onRemoveNew={(item) => removeAttachment(item.id)}
          />
        )}

        {attachments.length > 0 && (
          <div className="mb-2 min-w-0 pt-1">
            <ul className="flex flex-wrap gap-2" aria-label="Attachments">
              {attachments.map((a) => {
                if (a.kind !== 'image') {
                  return (
                    <li key={a.id} className="relative">
                      <div className={`flex h-14 max-w-[200px] items-center gap-2 rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] pl-2.5 pr-3`}>
                        <FileText className="h-5 w-5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-medium text-[var(--ds-ink)]">{a.name}</span>
                          <span className={`block text-[10px] ${MUTED}`}>
                            {charCount(a.chars || 0)}
                            {a.truncated ? ' · trimmed' : ''}
                          </span>
                        </span>
                      </div>
                      {removeButton(a)}
                    </li>
                  );
                }
                const busy = isUploadBusy(a.upload);
                const who = doc ? targetLabel(doc, a.target) : null;
                return (
                  <li key={a.id} className="relative w-14" data-upload={a.upload || 'inline'}>
                    {/* Tapping the photo asks who it is (quick-assign, free). */}
                    <button
                      type="button"
                      onClick={(e) => {
                        assignAnchorRef.current = e.currentTarget;
                        setAssigning((cur) => (cur === a.id ? null : a.id));
                      }}
                      disabled={!doc}
                      aria-haspopup="menu"
                      aria-expanded={assigning === a.id}
                      aria-label={who ? `${a.name}: ${who}. Change who this is` : `${a.name}: who's this?`}
                      title={who ? `${who} — tap to change` : 'Who’s this? Tap to say'}
                      className={cx(
                        `relative block h-14 w-14 overflow-hidden rounded-xl ${HAIRLINE} bg-[var(--ds-well)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50`,
                        who && 'ring-2 ring-[#D97757]/45'
                      )}
                    >
                      {a.previewUrl || a.dataUrl ? (
                        <img src={a.previewUrl || a.dataUrl} alt={a.name} className={cx('h-full w-full object-cover', busy && 'opacity-75')} draggable={false} />
                      ) : (
                        <span className="studio-shimmer block h-full w-full" aria-hidden />
                      )}
                      {busy && <UploadRing name={a.name} state={a.upload} progress={a.progress} />}
                      {a.upload === 'failed' && (
                        <span className="absolute bottom-1 left-1 grid h-5 w-5 place-items-center rounded-full bg-amber-500 text-white shadow" title={a.error} aria-hidden>
                          <AlertTriangle className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                    <span
                      className={cx('mt-0.5 block w-14 truncate text-center text-[10px] leading-tight', who ? 'font-semibold text-[var(--ds-ink)]' : MUTED)}
                      aria-hidden
                    >
                      {who || 'Who’s this?'}
                    </span>
                    {removeButton(a)}
                  </li>
                );
              })}
            </ul>
            {(busyCount > 0 || imageAttachments.length >= 2) && (
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {busyCount > 0 && (
                  <span role="status" aria-live="polite" className={`min-w-0 text-[11.5px] ${MUTED}`}>
                    {busyCount === 1 ? 'Uploading 1 photo' : `Uploading ${busyCount} photos`} — Send waits until {busyCount === 1 ? 'it’s' : 'they’re'} in.
                  </span>
                )}
                {imageAttachments.length >= 2 && doc && (
                  <button
                    ref={assignAllRef}
                    type="button"
                    onClick={() => setAssigning((cur) => (cur === 'all' ? null : 'all'))}
                    aria-haspopup="menu"
                    aria-expanded={assigning === 'all'}
                    className={`inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium text-[var(--ds-accent)] ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-[44px] coarse:px-3`}
                  >
                    <Users className="h-3.5 w-3.5" aria-hidden /> Assign all {imageAttachments.length} to…
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={!ready}
          aria-label="Message the Comic Director"
          placeholder={placeholder}
          // Touch: Enter is a newline (the Send button sends) — the keyboard key says so.
          enterKeyHint={coarse ? 'enter' : 'send'}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{ maxHeight: textareaMaxHeight }}
          className={cx(
            'block min-h-[44px] w-full resize-none bg-transparent px-1.5 py-2 leading-relaxed text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] disabled:opacity-60',
            // 16 px on every touch device (iOS never zooms into the field); 14 px with a mouse on wide screens.
            coarse ? 'text-base' : 'text-base sm:text-[14px]'
          )}
        />

        {text.trim().length > MAX_MESSAGE_CHARS && (
          <p className="mb-1.5 px-1.5 text-[11.5px] text-[var(--ds-muted)]">
            That's a long one ({charCount(text.trim().length)}) — it will be sent as your script file and saved as the comic's source.
          </p>
        )}

        {notice && (
          <div role="status" className="mb-1.5 flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="tap-target shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex min-w-0 items-center gap-1.5">
          <input ref={fileInputRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} data-testid="composer-file-input" />
          <input ref={photoInputRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} data-testid="composer-photo-input" />
          <input
            ref={cameraInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            capture="environment"
            hidden
            onChange={(e) => e.target.files && void addFiles(e.target.files)}
            data-testid="composer-camera-input"
          />
          <input ref={scriptInputRef} type="file" accept={SCRIPT_ACCEPT} hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} data-testid="composer-script-input" />
          <button
            ref={plusRef}
            type="button"
            onClick={() => (attachSheet ? setAttachOpen((o) => !o) : fileInputRef.current?.click())}
            disabled={!ready}
            aria-label="Add images or a script"
            aria-haspopup={attachSheet ? 'menu' : undefined}
            aria-expanded={attachSheet ? attachOpen : undefined}
            title={attachSheet ? 'Add a photo, take one, or attach a script' : 'Add character photos, style references or a script (.txt, .md)'}
            className={`${iconBtn} ${CONTROL_BTN} ${MUTED} hover:text-[var(--ds-ink)] disabled:opacity-40`}
          >
            <Plus className="h-4 w-4" />
          </button>
          {voiceOk && (
            <>
              {/* The shared dictation control keeps its desktop look; on touch the mic and its settings caret are real 44 px targets. */}
              <span className="contents coarse:[&_button]:min-h-[44px] coarse:[&_button]:min-w-[44px]">
                <DictationButton
                  disabled={!ready || messageBusy}
                  onStart={() => {
                    dictationBaseRef.current = text;
                  }}
                  onPartial={applyDictation}
                  onFinal={onDictationFinal}
                />
              </span>
              {showVoiceToggleInline && (
                <button
                  type="button"
                  onClick={toggleAutoSend}
                  aria-pressed={autoSend}
                  aria-label="Auto-send when I stop talking"
                  title={autoSend ? 'Voice: sends when you stop talking (click to review first)' : 'Voice: fills the box for review (click to auto-send)'}
                  className={cx(
                    // A quiet setting beside the mic, not a call to action: icon only, accent ink when on.
                    `relative ${iconBtn} ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40`,
                    autoSend ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                  )}
                >
                  <AudioLines className="h-4 w-4" aria-hidden />
                  {autoSend && <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)] ring-2 ring-[var(--ds-surface)]" aria-hidden />}
                </button>
              )}
            </>
          )}

          <div
            ref={chipsRef}
            onScroll={measureChips}
            className={cx(
              'flex min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1 items-center gap-1.5 overflow-x-auto px-0.5 py-0.5',
              chipsClipped.end && chipsClipped.start
                ? '[mask-image:linear-gradient(to_right,transparent,black_20px,black_calc(100%-28px),transparent)]'
                : chipsClipped.end
                  ? '[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]'
                  : chipsClipped.start
                    ? '[mask-image:linear-gradient(to_right,transparent,black_20px)]'
                    : ''
            )}
            role="toolbar"
            aria-label="Comic options"
          >
            {chip(
              'format',
              <>
                <AspectGlyph aspect={format?.pageAspect || '2:3'} size={13} />
                <span className="tabular-nums">
                  {/* Narrow: the glyph already shows the page shape. */}
                  {roomy && <span>{format?.pageAspect || '2:3'} · </span>}
                  {format?.pageCount ?? 6}p
                </span>
              </>,
              'Format: page shape, pages, panels, lettering',
              undefined,
              'Format'
            )}
            {chip(
              'style',
              <>
                <Palette className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className={cx('truncate', roomy ? 'max-w-[9rem]' : 'max-w-[5.5rem]')}>{styleName || 'Style'}</span>
              </>,
              'Art style',
              undefined,
              'Art style'
            )}
            {chip(
              'quality',
              <>
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {tierLabel}
              </>,
              'Quality and price per page',
              roomy || panel === 'quality' ? undefined : 'hidden',
              'Quality'
            )}
          </div>

          {stopDrawing && (
            <button
              type="button"
              onClick={() => void studio.cancel()}
              disabled={cancelling}
              aria-label={cancelling ? 'Stopping' : 'Stop drawing'}
              title={cancelling ? 'Stopping…' : 'Stop drawing (images already drawing finish and are kept)'}
              className={cx(
                `inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-[var(--ds-hairline)] text-[12px] font-medium text-[var(--ds-ink)] ${TRANSITION} hover:bg-[var(--ds-hover)] disabled:opacity-50 coarse:h-11 coarse:min-w-11`,
                roomy ? 'px-3' : 'px-0'
              )}
            >
              <Square className="h-3 w-3 shrink-0 fill-current" aria-hidden />
              {roomy && <span className="whitespace-nowrap">{cancelling ? 'Stopping…' : 'Stop drawing'}</span>}
            </button>
          )}
          {messageBusy ? (
            <button
              type="button"
              onClick={() => void studio.cancel()}
              disabled={cancelling}
              aria-label={cancelling ? 'Stopping' : 'Stop'}
              title={cancelling ? 'Stopping…' : 'Stop the director'}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ds-ink)] text-[var(--ds-canvas)] ${TRANSITION} hover:opacity-85 disabled:opacity-50 coarse:h-11 coarse:w-11`}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              title={uploadsBusy ? 'Waiting for your photos to finish uploading' : coarse ? 'Send' : 'Send (Enter)'}
              className={`press grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ds-accent)] text-white ${TRANSITION} hover:bg-[var(--ds-accent-hover)] disabled:bg-[var(--ds-well-strong)] disabled:text-[var(--ds-muted)] coarse:h-11 coarse:w-11`}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
