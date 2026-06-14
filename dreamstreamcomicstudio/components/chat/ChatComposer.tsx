import React, { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, X, Brain, Square, Loader2, LayoutGrid, FileText, Wand2, Undo2, Server } from 'lucide-react';
import type { ChatReasoningLevel } from '../../apiTypes';
import type { ChatAttachment } from '../../services/chatStorage';
import { enhancePrompt } from '../../services/chatApi';
import { REASONING_LEVELS, type ChatModelFeatures } from '../../services/chatFeatures';
import type { ChatConnector } from '../../services/chatConnectors';
import type { McpServerConfig } from '../../apiTypes';
import { DictationButton } from './DictationButton';
import {
  CANVAS_BG, GLASS_STRONG, HAIRLINE, MUTED, INK, TRANSITION, SHADOW_SOFT,
  RADIUS_PANEL, PILL, CONTROL_BTN, ACCENT_BG, ACCENT_BG_HOVER, ACCENT_TEXT, ACCENT_SOFT_BG
} from './studioDesign';

interface ChatComposerProps {
  busy: boolean;
  features: ChatModelFeatures;
  reasoningLevel: ChatReasoningLevel;
  webSearch: boolean;
  dreamstreamAccess: boolean;
  enabledTools: string[];
  toolsSupported: boolean;
  mcpServers: McpServerConfig[];
  enabledMcpServers: string[];
  onReasoningChange: (level: ChatReasoningLevel) => void;
  onWebToggle: (on: boolean) => void;
  onDreamstreamToggle: (on: boolean) => void;
  onToggleConnector: (connector: ChatConnector, on: boolean) => void;
  onToggleMcpServer: (id: string, on: boolean) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  /** When set, prefill the composer with this text (e.g. a suggested follow-up). */
  seedText?: string;
  onSeedConsumed?: () => void;
  onStop: () => void;
}

const MAX_ATTACHMENTS = 6;

const fileToAttachment = (file: File): Promise<ChatAttachment> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        kind: file.type.startsWith('image/') ? 'image' : 'document',
        dataUrl: reader.result as string
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// Pasting a wall of text shouldn't bury the composer (and degrades quality). Past this
// many characters we stash it as a "Pasted text" chip instead; it's inlined back into
// the message at send time so the model still reads all of it.
const PASTE_TO_FILE_THRESHOLD = 1200;

// UTF-8-safe base64 of arbitrary text (btoa alone breaks on non-Latin1 chars).
const encodeText = (text: string): string => {
  try { return btoa(unescape(encodeURIComponent(text))); } catch { return btoa(text); }
};
const decodeTextLen = (dataUrl: string): number => {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return decodeURIComponent(escape(atob(b64))).length;
  } catch { return 0; }
};
const pastedChars = (dataUrl: string): string => {
  const n = decodeTextLen(dataUrl);
  return n >= 1000 ? `${Math.round(n / 100) / 10}k chars` : `${n} chars`;
};
const textAttachment = (text: string): ChatAttachment => ({
  id: crypto.randomUUID(),
  name: `pasted-text-${Date.now()}.txt`,
  mimeType: 'text/plain',
  kind: 'text',
  dataUrl: `data:text/plain;base64,${encodeText(text)}`
});

export const ChatComposer: React.FC<ChatComposerProps> = ({
  busy,
  features,
  reasoningLevel,
  webSearch,
  dreamstreamAccess,
  enabledTools,
  toolsSupported,
  mcpServers,
  enabledMcpServers,
  onReasoningChange,
  onWebToggle,
  onDreamstreamToggle,
  onToggleConnector,
  onToggleMcpServer,
  onSend,
  seedText,
  onSeedConsumed,
  onStop
}) => {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [enhancing, setEnhancing] = useState(false);
  // Holds the pre-enhancement draft so the user can undo a suggestion they dislike.
  const [beforeEnhance, setBeforeEnhance] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Draft snapshot taken when a dictation take starts, so streamed partials replace
  // only the dictated segment instead of clobbering typed text.
  const dictationBaseRef = useRef('');

  const applyDictation = (spoken: string) => {
    if (!spoken) return;
    const base = dictationBaseRef.current;
    const joined = base ? `${base.replace(/\s+$/, '')} ${spoken}` : spoken;
    setText(joined);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        autoGrow(el);
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  // Prefill from a suggested follow-up, then focus the box.
  useEffect(() => {
    if (!seedText) return;
    setText(seedText);
    onSeedConsumed?.();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        autoGrow(el);
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedText]);

  // Widgets deep in the artifact tree (learning steps, follow-up actions) can hand the
  // composer a ready-to-send draft without prop drilling: they dispatch
  // `dreamstream:compose` with { detail: { text } } and the box fills + focuses.
  useEffect(() => {
    const onCompose = (e: Event) => {
      const draft = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!draft) return;
      setText(draft);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          autoGrow(el);
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    };
    window.addEventListener('dreamstream:compose', onCompose);
    return () => window.removeEventListener('dreamstream:compose', onCompose);
  }, []);

  // Auto-send path: a widget (e.g. the clarifying-questions card) can dispatch
  // `dreamstream:send` with { detail: { text } } to post a message immediately, without
  // routing through the textarea — used when the user has already "answered" by clicking.
  useEffect(() => {
    const onSendEvent = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!text || !text.trim() || busy) return;
      onSend(text.trim(), []);
    };
    window.addEventListener('dreamstream:send', onSendEvent);
    return () => window.removeEventListener('dreamstream:send', onSendEvent);
  }, [busy, onSend]);

  // Attach a file handed in from elsewhere (e.g. the Library's "Use in chat"): drop it
  // into the draft as an attachment and focus the box so the user can ask about it.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const d = (e as CustomEvent<{ name?: string; mimeType?: string; dataUrl?: string; kind?: 'image' | 'document' }>).detail;
      if (!d?.dataUrl) return;
      setAttachments((prev) => {
        if (prev.length >= MAX_ATTACHMENTS) return prev;
        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            name: d.name || 'attachment',
            mimeType: d.mimeType || 'application/octet-stream',
            kind: d.kind || (d.mimeType?.startsWith('image/') ? 'image' : 'document'),
            dataUrl: d.dataUrl as string
          }
        ];
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('dreamstream:attach', onAttach);
    return () => window.removeEventListener('dreamstream:attach', onAttach);
  }, []);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy;
  const canEnhance = text.trim().length > 2 && !busy && !enhancing;

  // Improve the draft prompt in place (intent preserved); keeps the original for undo.
  const handleEnhance = async () => {
    if (!canEnhance) return;
    const prev = text;
    setEnhancing(true);
    try {
      const { enhanced } = await enhancePrompt(prev);
      if (enhanced && enhanced.trim() && enhanced.trim() !== prev.trim()) {
        setText(enhanced.trim());
        setBeforeEnhance(prev);
        requestAnimationFrame(() => textareaRef.current && autoGrow(textareaRef.current));
      }
    } catch {
      /* leave the draft untouched on failure */
    } finally {
      setEnhancing(false);
    }
  };

  const undoEnhance = () => {
    if (beforeEnhance === null) return;
    setText(beforeEnhance);
    setBeforeEnhance(null);
    requestAnimationFrame(() => textareaRef.current && autoGrow(textareaRef.current));
  };

  const resetInput = () => {
    setText('');
    setAttachments([]);
    setBeforeEnhance(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const submit = () => {
    if (busy) return;
    if (!canSend) return;
    onSend(text.trim(), attachments);
    resetInput();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    // Images need a vision model; PDFs are always accepted (viewer-only); CSV/JSON/text
    // data files are accepted so tools like run_python can read/convert/process them.
    const DATA_TYPES = ['text/csv', 'application/json', 'text/plain'];
    const DATA_EXTS = /\.(csv|tsv|json|txt)$/i;
    const isDataFile = (f: File) => DATA_TYPES.includes(f.type) || DATA_EXTS.test(f.name);
    const accepted = Array.from(files).filter(
      (f) => (features.vision && f.type.startsWith('image/')) || f.type === 'application/pdf' || isDataFile(f)
    );
    const next: ChatAttachment[] = [];
    for (const file of accepted.slice(0, MAX_ATTACHMENTS - attachments.length)) {
      try {
        next.push(await fileToAttachment(file));
      } catch {
        /* skip unreadable file */
      }
    }
    setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // Smart paste: dropped/pasted images become attachments, and a very long text paste
  // is stashed as a compact "Pasted text" chip instead of flooding the box.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    if (dt.files && dt.files.length > 0) {
      e.preventDefault();
      void handleFiles(dt.files);
      return;
    }
    const pasted = dt.getData('text/plain');
    if (pasted && pasted.length >= PASTE_TO_FILE_THRESHOLD && attachments.length < MAX_ATTACHMENTS) {
      e.preventDefault();
      setAttachments((prev) => [...prev, textAttachment(pasted)].slice(0, MAX_ATTACHMENTS));
    }
    // Otherwise let the textarea insert the text normally.
  };

  return (
    <div className={`${CANVAS_BG} px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]`}>
      <div className={`${GLASS_STRONG} ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_PANEL} p-3 transition-shadow duration-300 focus-within:border-[#D97757]/40 focus-within:shadow-[0_0_0_1px_rgba(217,119,87,0.35),0_2px_10px_rgba(217,119,87,0.14),0_18px_46px_rgba(217,119,87,0.10)]`}>
      {/* Feature toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {features.reasoning && (
          <label className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${MUTED}`}>
            <Brain className="w-3.5 h-3.5" /> Reasoning
            <select
              value={reasoningLevel}
              onChange={(e) => onReasoningChange(e.target.value as ChatReasoningLevel)}
              className="bg-transparent outline-none font-medium cursor-pointer"
            >
              {REASONING_LEVELS.map((lvl) => (
                <option key={lvl.value} value={lvl.value}>{lvl.label}</option>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={() => onDreamstreamToggle(!dreamstreamAccess)}
          className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${dreamstreamAccess ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} border-[#D97757]/30` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
          title="DreamStream connector: let this chat see your own projects, account and usage (read-only, sanitized). Off by default."
        >
          <LayoutGrid className="w-3.5 h-3.5" /> DreamStream {dreamstreamAccess ? 'on' : 'off'}
        </button>

        {toolsSupported &&
          mcpServers.map((server) => {
            const on = enabledMcpServers.includes(server.id);
            return (
              <button
                key={server.id}
                onClick={() => onToggleMcpServer(server.id, !on)}
                className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${on ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} border-[#D97757]/30` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
                title={`Custom MCP server: ${server.url}`}
              >
                <Server className="w-3.5 h-3.5" /> {server.name} {on ? 'on' : 'off'}
              </button>
            );
          })}
      </div>

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <div key={att.id} className="relative">
              {att.kind === 'text' ? (
                <div className={`h-14 max-w-[180px] rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] flex items-center gap-2 pl-2.5 pr-3`}>
                  <FileText className={`w-5 h-5 shrink-0 ${ACCENT_TEXT}`} />
                  <span className="min-w-0">
                    <span className={`block text-[11px] font-medium ${INK} truncate`}>Pasted text</span>
                    <span className={`block text-[10px] ${MUTED}`}>{pastedChars(att.dataUrl)}</span>
                  </span>
                </div>
              ) : att.kind === 'document' ? (
                <div className={`w-14 h-14 rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] flex flex-col items-center justify-center p-1`}>
                  <FileText className={`w-5 h-5 ${ACCENT_TEXT}`} />
                  <span className={`text-[8px] font-medium ${MUTED} truncate w-full text-center mt-0.5`}>{att.name}</span>
                </div>
              ) : (
                <img src={att.dataUrl} alt={att.name} className={`w-14 h-14 object-cover rounded-xl ${HAIRLINE}`} />
              )}
              <button
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                className={`absolute -top-1.5 -right-1.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white rounded-full ${SHADOW_SOFT} w-5 h-5 flex items-center justify-center ${TRANSITION}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {beforeEnhance !== null && (
        <div className={`flex items-center gap-1.5 mb-1.5 text-[11px] ${ACCENT_TEXT}`}>
          <Wand2 className="w-3.5 h-3.5" />
          <span className="font-semibold">Prompt enhanced.</span>
          <span className={MUTED}>Review it, then send — or</span>
          <button onClick={undoEnhance} className="flex items-center gap-0.5 font-semibold hover:text-[var(--ds-ink)] underline">
            <Undo2 className="w-3 h-3" /> undo
          </button>
        </div>
      )}

      <div className="relative flex items-end gap-2">
        {(
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={`${features.vision ? 'image/*,' : ''}application/pdf,text/csv,application/json,text/plain,.csv,.tsv,.json,.txt`}
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              className={`shrink-0 ${CONTROL_BTN} p-2.5 ${MUTED} hover:text-[var(--ds-ink)] disabled:opacity-40`}
              title={features.vision ? 'Attach images or PDFs' : 'Attach a PDF'}
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              onClick={handleEnhance}
              disabled={!canEnhance}
              className={`hidden sm:block shrink-0 ${CONTROL_BTN} p-2.5 ${MUTED} hover:text-[var(--ds-ink)] disabled:opacity-40`}
              title="Improve my prompt (keeps your intent — review before sending)"
            >
              {enhancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            </button>
            <DictationButton
              disabled={busy}
              onStart={() => {
                dictationBaseRef.current = text;
              }}
              onPartial={applyDictation}
              onFinal={(spoken) => {
                applyDictation(spoken);
                textareaRef.current?.focus();
              }}
            />
          </>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (beforeEnhance !== null) setBeforeEnhance(null);
            autoGrow(e.target);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          placeholder="Message the model…  (Enter to send)"
          className="flex-1 resize-none bg-transparent rounded-xl px-3 py-2.5 text-base sm:text-sm text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] outline-none max-h-[200px]"
        />

        {busy ? (
          <button onClick={onStop} className={`shrink-0 rounded-full p-2.5 bg-red-500 hover:bg-red-600 text-white ${TRANSITION}`} title="Stop">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className={`shrink-0 rounded-full p-2.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white disabled:opacity-40 ${TRANSITION} hover:-translate-y-px`}
            title="Send"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        )}
      </div>
      </div>
    </div>
  );
};
