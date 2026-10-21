// The studio composer: a calm glass box where the user talks to the Comic Director.
//
//  - Auto-growing textarea. Enter sends, Shift+Enter is a newline, Cmd/Ctrl+K focuses it.
//  - Attach (+), paste or drop: PNG/JPG/WebP images ≤ 10 MB become attachments (character
//    photos, style refs; big photos are downscaled first); .txt/.md files go up as text
//    attachments — the server appends short ones to the message and saves long ones as
//    the comic's source script. Long pasted text stays in the box (a script is the
//    message); past the server's message cap it is sent as a script file instead.
//  - Voice via DictationButton with the base-snapshot pattern (partials replace only the
//    dictated segment). "Auto-send when I stop talking" sends the transcript on stop.
//  - Gemini-style option chips (format · style · quality) open anchored panels above the
//    composer; changes there are instant doc patches.
//  - While a director turn streams the send button becomes Stop.

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, AudioLines, FileText, Palette, Plus, Sparkles, Square, X } from 'lucide-react';
import { TIER_PRESETS } from '../../../shared/comic/models';
import { DictationButton } from '../../chat/DictationButton';
import { voiceInputSupported } from '../../../hooks/useDictation';
import { CONTROL_BTN, GLASS_STRONG, HAIRLINE, MUTED, RADIUS_PANEL, SHADOW_SOFT, TRANSITION } from '../../chat/studioDesign';
import type { PendingAttachment } from '../types';
import type { ComicStudioController } from '../useStudio';
import { COMPOSE_EVENT, type ComposeRequest } from './composerBus';
import { PopSheet } from './PopSheet';
import { FormatPanel } from './panels/FormatPanel';
import { StylePanel } from './panels/StylePanel';
import { QualityPanel } from './panels/QualityPanel';
import { AspectGlyph, cx } from './ui';
import { useMediaQuery } from '../../studio/kit/useMediaQuery';

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
const ACCEPT = 'image/png,image/jpeg,image/webp,.txt,.md,.markdown,text/plain,text/markdown';

export type ComposerPanel = 'format' | 'style' | 'quality';

interface ComposerAttachment extends PendingAttachment {
  id: string;
  kind: 'image' | 'text';
  /** Characters in a text attachment (for the chip). */
  chars?: number;
  truncated?: boolean;
}

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

export interface StudioComposerProps {
  studio: ComicStudioController;
  apiRef?: React.Ref<StudioComposerHandle>;
  className?: string;
}

export const StudioComposer: React.FC<StudioComposerProps> = ({ studio, apiRef, className }) => {
  const { doc, messageBusy, cancelling } = studio;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [panel, setPanel] = useState<ComposerPanel | null>(null);
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
  const chipsRef = useRef<HTMLDivElement>(null);
  const dictationBaseRef = useRef('');
  const dragDepth = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phones: shorter placeholder; the quality chip lives in the header there.
  const roomy = useMediaQuery('(min-width: 640px)');
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

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, []);

  const focusEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      autoGrow();
      const end = el.value.length;
      try {
        el.setSelectionRange(end, end);
      } catch {
        /* some input types don't support selection */
      }
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

  const addFiles = useCallback(
    async (input: FileList | File[]) => {
      const files = Array.from(input || []);
      if (!files.length) return;
      const problems: string[] = [];
      const added: ComposerAttachment[] = [];
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
            added.push({ id: attachId(), kind: 'image', name: file.name || 'image', mimeType: shrunk?.mimeType || file.type || 'image/png', dataUrl });
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
        } else {
          problems.push(`${file.name || 'That file'} isn't supported — use PNG, JPG or WebP images, or .txt/.md scripts`);
        }
      }
      if (added.length) setAttachments((prev) => [...prev, ...added]);
      if (problems.length) {
        showNotice(`${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}.`);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (added.length) focusEnd();
    },
    [focusEnd, showNotice]
  );

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // ── Send ───────────────────────────────────────────────────────────────────

  const sendNow = useCallback(
    (rawText: string, list: ComposerAttachment[]) => {
      if (!ready || messageBusy) return false;
      const outgoing = buildOutgoing(rawText, list);
      if (!outgoing.text && !outgoing.attachments.length) return false;
      void studio.send(outgoing.text, outgoing.attachments);
      setText('');
      setAttachments([]);
      setHint(null);
      setPanel(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      });
      return true;
    },
    [messageBusy, ready, studio]
  );

  const submit = () => {
    if (!canSend) return;
    sendNow(text, attachments);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
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
    const onCompose = (e: Event) => {
      const req = ((e as CustomEvent<ComposeRequest>).detail || {}) as ComposeRequest;
      if (typeof req.text === 'string') setText((prev) => (req.append && prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${req.text}` : req.text!));
      if (req.hint !== undefined) setHint(req.hint || null);
      if (req.pickFiles) fileInputRef.current?.click();
      else if (req.focus !== false) focusEnd();
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [focusEnd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusEnd();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusEnd]);

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
    (doc?.conversation.length
      ? 'Reply, or describe a change…'
      : roomy
        ? 'Describe your comic, paste a script, or drop in character photos…'
        : 'Describe your comic or paste a script…');

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
        `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium ${TRANSITION} disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40`,
        panel === id
          ? 'border-[#D97757]/45 bg-[#D97757]/10 text-[var(--ds-ink)]'
          : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]',
        extra
      )}
    >
      {label}
    </button>
  );

  return (
    <div className={cx('relative', className)} {...dropHandlers}>
      {doc && (
        <PopSheet
          open={panel !== null}
          onClose={() => setPanel(null)}
          label={panel === 'format' ? 'Format' : panel === 'style' ? 'Style' : 'Quality'}
          anchorRef={chipsRef}
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
        </PopSheet>
      )}

      <div
        className={cx(
          `${GLASS_STRONG} ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_PANEL} px-3 pb-2.5 pt-2 transition-shadow duration-300 focus-within:border-[#D97757]/40 focus-within:shadow-[0_0_0_1px_rgba(217,119,87,0.35),0_2px_10px_rgba(217,119,87,0.14),0_18px_46px_rgba(217,119,87,0.10)]`,
          dragOver && 'border-[#D97757]/60 ring-2 ring-[#D97757]/30'
        )}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-[var(--ds-surface-strong)] text-[13px] font-medium text-[var(--ds-ink)]">
            Drop images or a script to attach
          </div>
        )}

        {attachments.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2 pt-1" aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.id} className="relative">
                {a.kind === 'image' ? (
                  <img src={a.dataUrl} alt={a.name} className={`h-14 w-14 rounded-xl object-cover ${HAIRLINE}`} />
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
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className={`absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--ds-ink)] text-[var(--ds-canvas)] ${SHADOW_SOFT} ${TRANSITION} hover:scale-105`}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={!ready}
          aria-label="Message the Comic Director"
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-[240px] min-h-[44px] w-full resize-none bg-transparent px-1.5 py-2 text-base leading-relaxed text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] disabled:opacity-60 sm:text-[14px]"
        />

        {text.trim().length > MAX_MESSAGE_CHARS && (
          <p className="mb-1.5 px-1.5 text-[11.5px] text-[var(--ds-muted)]">
            That's a long one ({charCount(text.trim().length)}) — it will be sent as your script file and saved as the comic's source.
          </p>
        )}

        {notice && (
          <div role="status" className="mb-1.5 flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <input ref={fileInputRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} data-testid="composer-file-input" />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!ready}
            aria-label="Add images or a script"
            title="Add character photos, style references or a script (.txt, .md)"
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${CONTROL_BTN} rounded-full ${MUTED} hover:text-[var(--ds-ink)] disabled:opacity-40`}
          >
            <Plus className="h-4 w-4" />
          </button>
          {voiceOk && (
            <>
              <DictationButton
                disabled={!ready || messageBusy}
                onStart={() => {
                  dictationBaseRef.current = text;
                }}
                onPartial={applyDictation}
                onFinal={onDictationFinal}
              />
              <button
                type="button"
                onClick={toggleAutoSend}
                aria-pressed={autoSend}
                aria-label="Auto-send when I stop talking"
                title={autoSend ? 'Voice: sends when you stop talking (click to review first)' : 'Voice: fills the box for review (click to auto-send)'}
                className={cx(
                  // A quiet setting beside the mic, not a call to action: icon only, accent ink when on.
                  `relative grid h-8 w-8 shrink-0 place-items-center rounded-full ${TRANSITION} hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40`,
                  autoSend ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                )}
              >
                <AudioLines className="h-4 w-4" aria-hidden />
                {autoSend && <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)] ring-2 ring-[var(--ds-surface)]" aria-hidden />}
              </button>
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
                  {/* Phones: the glyph already shows the page shape. */}
                  <span className="hidden sm:inline">{format?.pageAspect || '2:3'} · </span>
                  {format?.pageCount ?? 6}p
                </span>
              </>,
              'Format: page shape, pages, panels, lettering'
            )}
            {chip(
              'style',
              <>
                <Palette className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="max-w-[5.5rem] truncate sm:max-w-[9rem]">{styleName || 'Style'}</span>
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
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ds-ink)] text-[var(--ds-canvas)] ${TRANSITION} hover:opacity-85 disabled:opacity-50`}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter)"
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ds-accent)] text-white ${TRANSITION} hover:bg-[var(--ds-accent-hover)] disabled:bg-[var(--ds-well-strong)] disabled:text-[var(--ds-muted)]`}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
