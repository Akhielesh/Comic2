// The conversation column: messages + live cards, the activity line and the docked
// composer. Auto-scrolls while the user is at the bottom; if they scrolled up to read,
// new content waits behind a "Jump to latest" button instead of yanking them down.
//
// On narrow screens the shell can swap the message list for the board (`replaceList`)
// while the composer stays docked — the user can keep talking while they look.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, RefreshCw, X } from 'lucide-react';
import type { ComicStudioController } from '../useStudio';
import { conversationEntries } from '../studioReducer';
import { ActivityLine } from './ActivityLine';
import { composeInStudio } from './composerBus';
import { EmptyConversation } from './EmptyConversation';
import { AssistantMessage, DirectorMark, UserBubble } from './MessageItem';
import { StudioComposer, type StudioComposerHandle } from './StudioComposer';
import { AgentThinking } from '../../studio/kit/streamMotion';
import { cx } from './ui';

const NEAR_BOTTOM_PX = 96;

export interface ConversationPaneProps {
  studio: ComicStudioController;
  /** Shown in place of the message list (mobile Board view); the composer stays docked. */
  replaceList?: React.ReactNode;
  /** Extra content just above the composer (e.g. the mobile "3 pages rendering · View" pill). */
  aboveComposer?: React.ReactNode;
  className?: string;
}

export const ConversationPane: React.FC<ConversationPaneProps> = ({ studio, replaceList, aboveComposer, className }) => {
  const { doc, drafts, pendingMessage, messageBusy } = studio;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<StudioComposerHandle>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const entries = useMemo(() => conversationEntries(doc, drafts), [doc, drafts]);
  // Drafts for replies the server hasn't committed yet render after the pending bubble.
  const committed = useMemo(() => new Set((doc?.conversation || []).map((m) => m.id)), [doc?.conversation]);
  const docEntries = entries.filter((e) => committed.has(e.msg.id));
  const orphanDrafts = entries.filter((e) => !committed.has(e.msg.id));
  const isEmpty = !!doc && !doc.conversation.length && !pendingMessage && !orphanDrafts.length;

  const lastEntry = entries[entries.length - 1];
  const lastAssistantId = [...entries].reverse().find((e) => e.msg.role === 'assistant')?.msg.id;
  const streamingSomething = Object.keys(drafts).length > 0;
  const showThinking = messageBusy && !streamingSomething && (!lastEntry || lastEntry.msg.role === 'user' || !!pendingMessage);

  // ── Scrolling ──────────────────────────────────────────────────────────────

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    pinnedRef.current = near;
    setPinned(near);
  };

  const draftLength = Object.values(drafts).reduce((n, t) => n + t.length, 0);
  const lastCards = lastEntry?.msg.cards?.length || 0;
  const signature = `${entries.length}|${draftLength}|${lastCards}|${pendingMessage?.id || ''}|${showThinking}`;

  // Stick to the bottom while pinned.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [signature, scrollToBottom]);

  // Sending always brings the conversation back to the latest.
  useEffect(() => {
    if (pendingMessage?.status === 'sending') scrollToBottom(true);
  }, [pendingMessage?.id, pendingMessage?.status, scrollToBottom]);

  // Images and cards change height after mount — keep pinned content pinned.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [replaceList]);

  // Back from the board view (mobile): land at the latest message.
  useEffect(() => {
    if (!replaceList) scrollToBottom();
  }, [replaceList, scrollToBottom]);

  // ── Drop anywhere on the conversation ──────────────────────────────────────

  const onDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    composerRef.current?.addFiles(e.dataTransfer.files);
  };

  return (
    <section aria-label="Conversation" className={cx('relative flex h-full min-h-0 w-full flex-col', className)} onDragOver={onDragOver} onDrop={onDrop}>
      {replaceList ? (
        <div className="min-h-0 flex-1 overflow-hidden">{replaceList}</div>
      ) : (
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div ref={contentRef} role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 pb-6 pt-6 sm:px-6">
            {isEmpty ? (
              <EmptyConversation onSend={(t) => void studio.send(t)} disabled={!doc || messageBusy} />
            ) : (
              <>
                {docEntries.map(({ msg, draft }) =>
                  msg.role === 'user' ? (
                    <UserBubble key={msg.id} text={msg.text} attachments={msg.attachments} urlFor={studio.urlFor} />
                  ) : (
                    <AssistantMessage
                      key={msg.id}
                      msg={msg}
                      draft={draft}
                      streaming={!!draft && messageBusy}
                      showSuggestions={msg.id === lastAssistantId && lastEntry?.msg.id === msg.id && !messageBusy && !pendingMessage}
                      studio={studio}
                    />
                  )
                )}
                {pendingMessage && (
                  <UserBubble
                    text={pendingMessage.text}
                    attachments={pendingMessage.attachments}
                    urlFor={studio.urlFor}
                    status={pendingMessage.status}
                    error={pendingMessage.error}
                    onRetry={pendingMessage.status === 'failed' ? studio.retryPendingMessage : undefined}
                    onEdit={
                      pendingMessage.status === 'failed'
                        ? () => {
                            composeInStudio({ text: pendingMessage.text });
                            studio.dismissPendingMessage();
                          }
                        : undefined
                    }
                    onDismiss={pendingMessage.status === 'failed' ? studio.dismissPendingMessage : undefined}
                  />
                )}
                {orphanDrafts.map(({ msg, draft }) => (
                  <AssistantMessage key={msg.id} msg={msg} draft={draft} streaming={messageBusy} studio={studio} />
                ))}
                {showThinking && (
                  <div className="flex items-center gap-3">
                    <DirectorMark />
                    <AgentThinking label="Thinking…" />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="relative shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 sm:px-4">
        {!replaceList && !pinned && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] shadow-[0_4px_16px_rgba(0,0,0,0.12)] backdrop-blur-md animate-scale-in hover:bg-[var(--ds-raised)]"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Jump to latest
            </button>
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl">
          {studio.error && (
            <div role="alert" className="mb-2 flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-[12.5px] text-[var(--ds-ink)]">
              <span className="min-w-0 flex-1">{studio.error}</span>
              <button
                type="button"
                onClick={() => {
                  studio.clearError();
                  void studio.refresh();
                }}
                className="inline-flex shrink-0 items-center gap-1 font-semibold hover:underline"
                title="Reload the latest state of this comic"
              >
                <RefreshCw className="h-3 w-3" aria-hidden /> Resync
              </button>
              <button type="button" onClick={studio.clearError} aria-label="Dismiss error" className="shrink-0 text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <ActivityLine studio={studio} className="mb-1" />
          {aboveComposer}
          <StudioComposer studio={studio} apiRef={composerRef} />
        </div>
      </div>
    </section>
  );
};
