// The studio composer: a calm glass box where the user talks to the Comic Director.
//
//  - Auto-growing textarea (capped at 240 px, or 30 % of the visible height on phones so the
//    keyboard never pushes the conversation away). Cmd/Ctrl+K focuses it.
//  - Enter rule (contract §13.4): on touch devices (coarse pointer — phones AND tablets) Enter is
//    a newline and the Send button sends, like mainstream mobile chat apps, so half-typed scripts
//    never go out by accident. On fine pointers Enter sends and Shift+Enter is a newline.
//    ⌘/Ctrl+Enter always sends. 16 px text on every coarse pointer (no iOS focus zoom).
//  - Attach (+), paste or drop: PNG/JPG/WebP images ≤ 10 MB become attachments (character
//    photos, style refs; big photos are downscaled first). On touch, + opens an action sheet:
//    Photo library · Take a photo (camera) · Script or document. Images upload to the comic's
//    inbox right away (`uploadRef(…, {kind:'inbox'})`, with progress) and go with the message as
//    `inboxPaths`; if that upload is unavailable or still running at send time, the image goes
//    inline as before — never lost, never blocking. Script files are read IN THE
//    BROWSER to plain text before upload — .txt/.md as-is, and .docx (mammoth), .pdf
//    (pdf.js) and .fdx (Final Draft XML) via scriptImport, whose parsers load only when
//    such a file is attached. The server appends short scripts to the message and saves
//    long ones as the comic's source script. Long pasted text stays in the box (a script
//    is the message); past the server's message cap it is sent as a script file instead.
//  - Voice via DictationButton with the base-snapshot pattern (partials replace only the
//    dictated segment). "Auto-send when I stop talking" sends the transcript on stop.
//  - Gemini-style option chips (format · style · quality) open anchored panels above the
//    composer; changes there are instant doc patches.
//  - While a director turn streams the send button becomes Stop.
//  - A selection in the page editor shows as a focus chip ("Page 3 · 2 balloons ×"); the next
//    message is about it (`focus: 'selection'`) unless the chip is dismissed.

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, AudioLines, Camera, Crosshair, FileText, Image as ImageIcon, Palette, Plus, Sparkles, Square, X } from 'lucide-react';
import { TIER_PRESETS } from '../../../shared/comic/models';
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
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Files per message (server cap, images and scripts together). */
export const MAX_ATTACHMENTS = 6;
/** Characters the server keeps from one text file. */
export const MAX_TEXT_CHARS = 200_000;
/** Longest message text the server accepts; longer text is sent as a script file. */
export const MAX_MESSAGE_CHARS = 60_000;
/** The request body is capped at 10 MB of JSON; keep attachments safely under it. */
export const MAX_PAYLOAD_CHARS = 9_000_000;
const MAX_TEXTAREA_PX = 240;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
const TEXT_EXT = /\.(txt|md|markdown|text|fountain)$/i;
// .docx/.pdf/.fdx need in-browser extraction (mammoth/pdf.js/XML); the rest are plain text.
const RICH_SCRIPT_KINDS = new Set(['docx', 'pdf', 'fdx']);
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
const ACCEPT = `${IMAGE_ACCEPT},${SCRIPT_ACCEPT}`;
/** Below this composer width the quality chip and the voice auto-send toggle step aside. */
const ROOMY_PX = 400;

export type ComposerPanel = 'format' | 'style' | 'quality';

interface ComposerAttachment extends PendingAttachment {
  id: string;
  kind: 'image' | 'text';
  /** Characters in a text attachment (for the chip). */
  chars?: number;
  truncated?: boolean;
  /** Images: inbox upload state. 'done' carries `inboxPath`; anything else falls back to the data URL. */
  upload?: 'pending' | 'done' | 'failed';
  inboxPath?: string;
  /** 0..1 while pending. */
  progress?: number;
}

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

/** Longest edge sent to the server (it stores uploads at ≤ 2048 px anyway). */
const MAX_IMAGE_EDGE = 2048;
/** Images under this size and edge go up untouched. */
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;

/**
 * Downscale big photos before they travel in the message body (a 12 MB phone photo
 * becomes a ~1 MB WebP at 2048 px). Falls back to the original when the browser can't
 * decode/encode here, or when the result isn't smaller.
 */
export const shrinkImage = async (file: File, original: string): Promise<{ dataUrl: string; mimeType: string } | null> => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size <= SHRINK_ABOVE_BYTES) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL('image/webp', 0.9);
    let mimeType = 'image/webp';
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      mimeType = 'image/jpeg';
    }
    return dataUrl.length < original.length ? { dataUrl, mimeType } : null;
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
};

const isImageFile = (f: File) => IMAGE_TYPES.has(f.type.toLowerCase());
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

/** What goes to `studio.send`: the legacy array form unless inbox uploads or a focus ride along. */
export const sendArgs = (
  outgoing: { text: string; attachments: PendingAttachment[] },
  inboxPaths: string[],
  focusSelection: boolean
): [string, SendOptions | PendingAttachment[]] => {
  if (!inboxPaths.length && !focusSelection) return [outgoing.text, outgoing.attachments];
  return [
    outgoing.text,
    {
      attachments: outgoing.attachments,
      ...(inboxPaths.length ? { inboxPaths } : {}),
      ...(focusSelection ? { focus: 'selection' as const } : {})
    }
  ];
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
  const uploads = useRef(new Map<string, AbortController>());
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
  const canSend = ready && hasContent && !messageBusy;

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

  // Abort in-flight inbox uploads when the composer goes away.
  useEffect(() => {
    const map = uploads.current;
    return () => {
      map.forEach((c) => c.abort());
      map.clear();
    };
  }, []);

  /** Start the inbox upload for an image attachment; any failure keeps the inline data-URL path. */
  const startInboxUpload = useCallback(
    (att: ComposerAttachment, original: File) => {
      if (typeof studio.uploadRef !== 'function') return;
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ctrl) uploads.current.set(att.id, ctrl);
      const patchAtt = (p: Partial<ComposerAttachment>) => setAttachments((prev) => prev.map((a) => (a.id === att.id ? { ...a, ...p } : a)));
      const body = (att.dataUrl !== '' && att.mimeType !== original.type ? dataUrlToBlob(att.dataUrl) : null) || original;
      let result: Promise<{ ref?: { path?: string } }>;
      try {
        result = studio.uploadRef(body, { kind: 'inbox' }, {
          name: att.name,
          ...(ctrl ? { signal: ctrl.signal } : {}),
          onProgress: (f) => patchAtt({ progress: Math.max(0, Math.min(1, f)) })
        });
      } catch {
        uploads.current.delete(att.id);
        patchAtt({ upload: 'failed' });
        return;
      }
      Promise.resolve(result)
        .then((res) => {
          const path = res?.ref?.path;
          patchAtt(path ? { upload: 'done', inboxPath: path, progress: 1 } : { upload: 'failed' });
        })
        .catch((err: unknown) => {
          const e = (err && typeof err === 'object' ? err : {}) as { kind?: string; code?: string; message?: string };
          // A photo the content rules refuse would be refused inline too (and fail the whole message):
          // say so now, on this photo, and take it out — never a silent fallback that fails later.
          if (e.kind === 'content_policy' || e.code === 'CONTENT_POLICY') {
            setAttachments((prev) => prev.filter((a) => a.id !== att.id));
            showNotice(`${att.name}: ${e.message || 'this image doesn’t fit the content rules, so it wasn’t added.'}`);
            return;
          }
          // Anything else (offline, inbox full, a server hiccup): the photo goes inline with the message.
          patchAtt({ upload: 'failed' });
        })
        .finally(() => uploads.current.delete(att.id));
    },
    [studio, showNotice]
  );

  const addFiles = useCallback(
    async (input: FileList | File[]) => {
      const files = Array.from(input || []);
      if (!files.length) return;
      const problems: string[] = [];
      const added: ComposerAttachment[] = [];
      const imageFiles = new Map<string, File>();
      let count = attachmentsRef.current.length;
      let payload = attachmentsRef.current.reduce((n, a) => n + a.dataUrl.length, 0);
      const fits = (dataUrl: string, name: string) => {
        if (payload + dataUrl.length > MAX_PAYLOAD_CHARS) {
          problems.push(`${name} doesn't fit — one message can carry about 9 MB of files. Send it in the next message`);
          return false;
        }
        return true;
      };
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          problems.push(`Up to ${MAX_ATTACHMENTS} files per message`);
          break;
        }
        if (isImageFile(file)) {
          if (file.size > MAX_IMAGE_BYTES) {
            problems.push(`${file.name} is over 10 MB`);
            continue;
          }
          try {
            const original = await readAs(file, 'dataUrl');
            const shrunk = await shrinkImage(file, original);
            const dataUrl = shrunk?.dataUrl || original;
            if (!fits(dataUrl, file.name || 'That image')) continue;
            const att: ComposerAttachment = {
              id: attachId(),
              kind: 'image',
              name: file.name || 'photo.jpg',
              mimeType: shrunk?.mimeType || file.type || 'image/png',
              dataUrl,
              upload: typeof studio.uploadRef === 'function' ? 'pending' : undefined,
              progress: 0
            };
            added.push(att);
            imageFiles.set(att.id, file);
            payload += dataUrl.length;
            count += 1;
          } catch {
            problems.push(`Couldn't read ${file.name}`);
          }
        } else if (isTextFile(file)) {
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
            count += 1;
            if (truncated) problems.push(`${file.name} was trimmed to the first ${charCount(MAX_TEXT_CHARS)}`);
          } catch {
            problems.push(`Couldn't read ${file.name}`);
          }
        } else if (RICH_SCRIPT_KINDS.has(scriptKindOf(file.name, file.type) || '')) {
          // .docx / .pdf / .fdx — extract to plain text in the browser, then upload the text.
          try {
            const imported = await importScriptFile(file);
            const dataUrl = textToDataUrl(imported.text, 'text/plain');
            if (!fits(dataUrl, file.name || 'That script')) continue;
            added.push({ id: attachId(), kind: 'text', name: `${imported.name}.txt`, mimeType: 'text/plain', dataUrl, chars: imported.text.length, truncated: imported.truncated });
            payload += dataUrl.length;
            count += 1;
            if (imported.truncated) problems.push(`${file.name} was trimmed to the first ${charCount(MAX_TEXT_CHARS)}`);
          } catch (err) {
            problems.push(err instanceof ScriptImportError ? err.message : `Couldn't read ${file.name}`);
          }
        } else {
          problems.push(`${file.name || 'That file'} isn't supported — use PNG, JPG or WebP images, or .txt/.md/.docx/.pdf/.fdx/.fountain scripts`);
        }
      }
      if (added.length) {
        setAttachments((prev) => [...prev, ...added]);
        for (const a of added) {
          const f = imageFiles.get(a.id);
          if (f && a.upload === 'pending') startInboxUpload(a, f);
        }
      }
      if (problems.length) {
        showNotice(`${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}.`);
      }
      for (const input of [fileInputRef, photoInputRef, cameraInputRef, scriptInputRef]) if (input.current) input.current.value = '';
      // Phones: don't pop the keyboard over the photo the user just picked.
      if (added.length && !coarse) focusEnd();
    },
    [focusEnd, showNotice, startInboxUpload, coarse, studio.uploadRef]
  );

  const removeAttachment = (id: string) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // ── Send ───────────────────────────────────────────────────────────────────

  const sendNow = useCallback(
    (rawText: string, list: ComposerAttachment[]) => {
      if (!ready || messageBusy) return false;
      // Images already in the comic's inbox travel by path; anything else (no uploader, still
      // uploading, failed) goes inline as before — never lost, never blocking the send.
      const uploaded = list.filter((a) => a.kind === 'image' && a.upload === 'done' && a.inboxPath);
      const inline = list.filter((a) => !uploaded.includes(a));
      const inboxPaths = uploaded.map((a) => a.inboxPath as string);
      const outgoing = buildOutgoing(rawText, inline);
      if (!outgoing.text && !outgoing.attachments.length && !inboxPaths.length) return false;
      // An upload still running is superseded by its inline copy: stop it (no orphan in the inbox).
      for (const a of inline) {
        uploads.current.get(a.id)?.abort();
        uploads.current.delete(a.id);
      }
      const [sendText, opts] = sendArgs(outgoing, inboxPaths, focusActive);
      void studio.send(sendText, opts);
      setText('');
      setAttachments([]);
      setHint(null);
      setPanel(null);
      setAttachOpen(false);
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      });
      onSent?.();
      return true;
    },
    [messageBusy, ready, studio, focusActive, onSent]
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
    if (autoSend && ready && !messageBusy) {
      sendNow(joined, attachmentsRef.current);
      return;
    }
    setText(joined);
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

  const chip = (id: ComposerPanel, label: React.ReactNode, title: string, extra?: string) => (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={panel === id}
      aria-label={title}
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
          {panel === 'format' && <FormatPanel doc={doc} patch={studio.patch} byok={studio.byok} />}
          {panel === 'style' && (
            <StylePanel
              doc={doc}
              patch={studio.patch}
              act={studio.act}
              byok={studio.byok}
              onDone={() => setPanel(null)}
              onDescribeOwn={() => {
                setText((prev) => (prev.trim() ? prev : 'Art style: '));
                setHint('Describe the look — medium, line, color, mood, artists you love…');
                focusEnd();
              }}
            />
          )}
          {panel === 'quality' && <QualityPanel doc={doc} patch={studio.patch} byok={studio.byok} onDone={() => setPanel(null)} />}
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

        {attachments.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2 pt-1" aria-label="Attachments">
            {attachments.map((a) => {
              const uploading = a.kind === 'image' && a.upload === 'pending';
              const pct = Math.round((a.progress || 0) * 100);
              return (
                <li key={a.id} className="relative">
                  {a.kind === 'image' ? (
                    <span className="relative block">
                      <img src={a.dataUrl} alt={a.name} className={cx(`h-14 w-14 rounded-xl object-cover ${HAIRLINE}`, uploading && 'opacity-80')} />
                      {uploading && (
                        <span
                          role="progressbar"
                          aria-label={`Uploading ${a.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={pct}
                          className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-black/30"
                        >
                          <span className="block h-full rounded-full bg-white transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${Math.max(8, pct)}%` }} />
                        </span>
                      )}
                    </span>
                  ) : (
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
                  )}
                  {/* The corner position lives on a wrapper: on touch, index.css's `.tap-target { position: relative }`
                      (unlayered, after the utilities) would override `absolute` on the button itself and drop the ✕
                      into the flow under the thumbnail. */}
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
                </li>
              );
            })}
          </ul>
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
              {/* The shared dictation control keeps its desktop look; on touch its buttons get a 44 px height. */}
              <span className="contents coarse:[&_button]:min-h-[44px]">
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
              'Format: page shape, pages, panels, lettering'
            )}
            {chip(
              'style',
              <>
                <Palette className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className={cx('truncate', roomy ? 'max-w-[9rem]' : 'max-w-[5.5rem]')}>{styleName || 'Style'}</span>
              </>,
              'Art style'
            )}
            {chip(
              'quality',
              <>
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {tierLabel}
              </>,
              'Quality and price per page',
              roomy || panel === 'quality' ? undefined : 'hidden'
            )}
          </div>

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
              title={coarse ? 'Send' : 'Send (Enter)'}
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
