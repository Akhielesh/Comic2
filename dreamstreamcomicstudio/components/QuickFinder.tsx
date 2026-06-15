import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, BookOpen, HelpCircle, FileText, Languages, CalendarPlus, MessageSquare,
  Copy, Check, Loader2, ChevronDown, ArrowUpRight
} from 'lucide-react';
import { sendChatMessageStream } from '../services/chatApi';
import type { ChatClientContext } from '../apiTypes';
import { DetailPopover, type PopoverAnchor } from './chat/artifacts/kit';

// ============================================================================
// QuickFinder — the global "Ask the AI about this" quick-finder
// ============================================================================
// Highlight text anywhere → a slim toolbar floats by the selection. Right-click
// anywhere (on selected text or page content) → a smart menu. Pick an action and
// the answer streams INLINE in a small, easily-closed popover (Escape / click-out /
// ✕), so it works on every view without leaving what you're doing — with a one-tap
// "Open in full chat" escalation. "Add to calendar" routes into chat so the calendar
// tools (with confirmation) take over. Smooth, fast, and non-intrusive: the auto pill
// stays out of the way while you're typing in a field; right-click still offers it.
// ============================================================================

interface QFAction {
  id: string;
  label: string;
  Icon: React.FC<{ className?: string }>;
  build: (text: string) => string;
  /** Show in the slim inline pill (the highest-value few). */
  quick?: boolean;
  /** Route into the full chat instead of answering inline. */
  chat?: boolean;
}

const Q = (t: string) => `"""\n${t.trim().slice(0, 4000)}\n"""`;

const ACTIONS: QFAction[] = [
  { id: 'explain', label: 'Explain', Icon: Sparkles, quick: true, build: (t) => `Explain this clearly and simply, in a few sentences:\n\n${Q(t)}` },
  { id: 'define', label: 'Define / meaning', Icon: BookOpen, quick: true, build: (t) => `Define this and give its meaning in plain language (the sense that fits this context):\n\n${Q(t)}` },
  { id: 'what', label: 'What is this?', Icon: HelpCircle, build: (t) => `What is this? Briefly say what it refers to and why it matters:\n\n${Q(t)}` },
  { id: 'summarize', label: 'Summarize', Icon: FileText, build: (t) => `Summarize this concisely — the key points only:\n\n${Q(t)}` },
  { id: 'translate', label: 'Translate', Icon: Languages, build: (t) => `Detect the language and translate this to English (if it is already English, translate to Spanish). Give just the translation:\n\n${Q(t)}` },
  { id: 'calendar', label: 'Add to calendar', Icon: CalendarPlus, chat: true, build: (t) => `Add this to my calendar — create the event (I'll confirm before it saves): ${t.trim().slice(0, 500)}` },
  { id: 'ask', label: 'Ask the chat', Icon: MessageSquare, chat: true, build: (t) => `About this:\n\n${Q(t)}\n\n` }
];

const isEditable = (node: EventTarget | null): boolean => {
  let el = node as HTMLElement | null;
  while (el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
};

// Don't intercept inside our own UI, nor inside any open popover/modal (DetailPopover —
// incl. our menu/panel — and app modals set role="dialog"). DetailPopover portals to
// <body>, so a wrapping element can't contain it; the role check is what actually works.
const inQuickFinder = (node: EventTarget | null): boolean =>
  Boolean((node as HTMLElement | null)?.closest?.('[data-quickfinder], [role="dialog"]'));

const selectionText = (): string => {
  try {
    return (window.getSelection()?.toString() || '').trim();
  } catch {
    return '';
  }
};

const pointAnchor = (x: number, y: number): PopoverAnchor => ({ top: y, left: x, bottom: y, right: x, width: 0 });

// ---------------------------------------------------------------- result pane --
const ResultPanel: React.FC<{ prompt: string; onAskInChat: () => void }> = ({ prompt, onAskInChat }) => {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let acc = '';
    (async () => {
      try {
        let clientContext: ChatClientContext | undefined;
        try {
          const mod = await import('../services/clientContext');
          clientContext = await mod.gatherClientContext().catch(() => undefined);
        } catch { /* context is best-effort */ }
        await sendChatMessageStream(
          { messages: [{ role: 'user', content: prompt }], ...(clientContext ? { clientContext } : {}) },
          {
            signal: ctrl.signal,
            onReset: () => { acc = ''; setText(''); },
            onDelta: (d) => { acc += d; setText(acc); }
          }
        );
        setStatus('done');
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setText(acc || (e as Error)?.message || 'Couldn’t get an answer — try opening the full chat.');
          setStatus('error');
        }
      }
    })();
    return () => ctrl.abort();
  }, [prompt]);

  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className="w-[22rem] max-w-full">
      {status === 'loading' && !text ? (
        <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-muted)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-accent)]" /> Thinking…
        </div>
      ) : (
        <div className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed ${status === 'error' ? 'text-rose-600' : 'text-[var(--ds-ink)]'}`}>
          {text}
          {status === 'loading' && <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-[var(--ds-accent)] align-middle" />}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--ds-hairline-soft)] pt-2.5">
        <button onClick={copy} disabled={!text} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-40">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={onAskInChat} className="inline-flex items-center gap-1.5 rounded-lg bg-[#D97757]/10 px-2.5 py-1 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:bg-[#D97757]/20">
          Open in full chat <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------- menu list --
const MenuList: React.FC<{ onPick: (a: QFAction) => void }> = ({ onPick }) => (
  <div className="w-52">
    {ACTIONS.map((a) => (
      <button
        key={a.id}
        onClick={() => onPick(a)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
      >
        <a.Icon className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
        <span className="flex-1">{a.label}</span>
        {a.chat && <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--ds-faint)]" />}
      </button>
    ))}
  </div>
);

// --------------------------------------------------------------------- widget ---
export const QuickFinder: React.FC<{ onAskInChat: (prompt: string) => void }> = ({ onAskInChat }) => {
  const [pill, setPill] = useState<{ anchor: PopoverAnchor; text: string } | null>(null);
  const [menu, setMenu] = useState<{ anchor: PopoverAnchor; text: string } | null>(null);
  const [panel, setPanel] = useState<{ anchor: PopoverAnchor; title: string; prompt: string } | null>(null);
  const lastText = useRef('');

  const closeAll = useCallback(() => { setPill(null); setMenu(null); setPanel(null); }, []);

  const run = useCallback((a: QFAction, text: string, anchor: PopoverAnchor) => {
    setPill(null);
    setMenu(null);
    if (a.chat) {
      onAskInChat(a.build(text));
      setPanel(null);
      return;
    }
    setPanel({ anchor, title: a.label, prompt: a.build(text) });
  }, [onAskInChat]);

  useEffect(() => {
    // Show the slim pill after a text selection (but not while editing a field, and not
    // when the selection is inside our own UI).
    const onMouseUp = (e: MouseEvent) => {
      if (inQuickFinder(e.target)) return;
      window.setTimeout(() => {
        const text = selectionText();
        if (text.length < 3 || text.length > 6000 || isEditable(e.target)) {
          setPill(null);
          return;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;
        lastText.current = text;
        setMenu(null);
        setPanel(null);
        setPill({ text, anchor: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width } });
      }, 0);
    };

    // Right-click → our smart menu (preserve the native menu inside empty editable fields).
    const onContextMenu = (e: MouseEvent) => {
      if (inQuickFinder(e.target)) return;
      const text = selectionText();
      if (isEditable(e.target) && !text) return; // let paste/spellcheck work in inputs
      e.preventDefault();
      setPill(null);
      setPanel(null);
      lastText.current = text;
      setMenu({ text, anchor: pointAnchor(e.clientX, e.clientY) });
    };

    // A new mousedown that isn't on our UI dismisses the pill (a fresh selection follows).
    const onMouseDown = (e: MouseEvent) => {
      if (!inQuickFinder(e.target)) setPill(null);
    };
    const onScroll = () => setPill(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPill(null); };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const quickActions = ACTIONS.filter((a) => a.quick);

  return (
    <>
      {/* Slim selection toolbar */}
      {pill && createPortal(
        <div
          data-quickfinder
          className="fixed z-[115] flex items-center gap-0.5 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-1 shadow-[0_6px_24px_rgba(0,0,0,0.16)] backdrop-blur-xl"
          style={{
            top: Math.max(8, pill.anchor.top - 44),
            left: Math.min(Math.max(8, (pill.anchor.left + pill.anchor.right) / 2 - 90), (typeof window !== 'undefined' ? window.innerWidth : 360) - 196)
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {quickActions.map((a) => (
            <button
              key={a.id}
              onClick={() => run(a, pill.text, pill.anchor)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
            >
              <a.Icon className="h-3.5 w-3.5 text-[var(--ds-accent)]" /> {a.label}
            </button>
          ))}
          <button
            onClick={() => { setMenu({ text: pill.text, anchor: pill.anchor }); setPill(null); }}
            aria-label="More actions"
            className="inline-flex items-center rounded-lg px-1.5 py-1 text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)]"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>,
        document.body
      )}

      {/* Right-click / "more" menu (DetailPopover sets role="dialog" → self-exempt) */}
      {menu && (
        <DetailPopover anchor={menu.anchor} onClose={() => setMenu(null)} width={224}>
          <MenuList onPick={(a) => run(a, menu.text, menu.anchor)} />
        </DetailPopover>
      )}

      {/* Inline streamed answer */}
      {panel && (
        <DetailPopover anchor={panel.anchor} onClose={() => setPanel(null)} title={panel.title} width={360}>
          <ResultPanel prompt={panel.prompt} onAskInChat={() => { onAskInChat(panel.prompt); setPanel(null); }} />
        </DetailPopover>
      )}
    </>
  );
};
