// The conversation column: messages + live cards, the activity line and the docked
// composer. Auto-scrolls while the user is at the bottom; if they scrolled up to read,
// new content waits behind a "Jump to latest" button instead of yanking them down.
//
// The v5 shell keeps this pane mounted (hidden + inert) when phones show the board, so scroll
// position and the composer draft survive; `replaceList` stays for compatibility only.
// Keyboard-safe: the bottom inset follows --sa-bottom-eff (0 while the keyboard is up), and a
// pinned conversation stays pinned when the keyboard opens or closes.
//
// Live queue (agent-editor plan §3 A1; only while the controller carries `queue`): "Up next" sits under the activity
// line. Q-SETTLE: the latest reply's chips are live only while it is the newest ask and unanswered, so they go the
// moment the creator sends anything (a typed message, a tapped text chip, a question's answer) — with or without the
// queue. While a run holds the turn with nothing sent (plan_pages), a text chip queues into Up next (NextStepChips).
//
// Settled cards (PROGRAM3 SETTLE-UI; this file is granted for the settle index and prop wiring only): while
// SETTLED_CARDS is on for this viewer (shared/comic/settle.ts settledCardsOn: admins first), the pane builds one settle
// index per doc revision — with this tab's sending message, the outage cards whose "wait and retry" is waiting, and
// whether the director is working — and hands it to every reply, so a card the chat has moved past renders as one
// line with no controls. The rows are memoised (PF-7a) over a controller kept while only the drafts change, and the
// entrance baseline is seeded on the first render of each doc (MO-2: stored messages never rise in again).

import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown } from 'lucide-react';
import { WRAP_TEXT } from '../../chat/studioDesign';
import { buildSettleIndex, settledCardsOn } from '../../../shared/comic/settle';
import { retriesVersion, subscribeRetries, waitingRetries } from '../reliability/retryIntents';
import type { ComicStudioController } from '../useStudio';
import { conversationEntries } from '../studioReducer';
import { ActivityLine } from './ActivityLine';
import { DirectorDraftControl } from './DirectorDraftControl';
import { QueuedMessages } from './QueuedMessages';
import { composeInStudio } from './composerBus';
import { EmptyConversation } from './EmptyConversation';
import { AssistantMessageRow, DirectorMark, assistantRowEmpty, PendingMessageRow, UserMessageRow, seedEntrances, useRowStudio } from './MessageItem';
import { StudioComposer, type StudioComposerHandle } from './StudioComposer';
import { SavedByEditorNote, StudioErrorBanner, StudioNoticeToast } from './StudioNotices';
import { AgentThinking } from '../../studio/kit/streamMotion';
import { subscribeKeyboardInset } from '../mobile/useKeyboardInset';
import type { ActivityItem } from '../types';
import { cx } from './ui';
import { prefersReducedMotion } from '../../ds/useReducedMotion';

const NEAR_BOTTOM_PX = 96;
const MAX_VISIBLE_STEPS = 5;

function DirectorProgress({ activity }: { activity: ActivityItem[] }) {
  const steps = activity.filter((step) => step.label.trim()).slice(-MAX_VISIBLE_STEPS);
  return (
    <div className="flex min-w-0 items-start gap-3">
      <DirectorMark />
      <div className="min-w-0">
        <AgentThinking label="Thinking…" />
        {steps.length > 0 && (
          <details className="text-[12px] text-[var(--ds-muted)]">
            <summary className="w-fit cursor-pointer rounded-md py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-focus)] coarse:min-h-[44px] coarse:py-3">
              Director activity
            </summary>
            <ul aria-label="Recent Director steps" className="mb-1 space-y-1 border-s border-[var(--ds-hairline)] ps-3">
              {steps.map((step) => (
                <li key={step.id} className="[overflow-wrap:anywhere]">
                  <span className="text-[var(--ds-ink)]">{step.label}</span>{' '}
                  <span>· {step.phase === 'start' ? 'In progress' : step.ok === false ? 'Couldn’t finish' : 'Done'}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

export interface ConversationPaneProps {
  studio: ComicStudioController;
  /** Shown in place of the message list (mobile Board view); the composer stays docked. */
  replaceList?: React.ReactNode;
  /** Extra content just above the composer (e.g. the mobile "3 pages rendering · View" pill). */
  aboveComposer?: React.ReactNode;
  className?: string;
  /**
   * Pad the composer dock by the bottom safe area (default true). The phone shell turns it off
   * because its tab bar owns that inset.
   */
  insetBottom?: boolean;
  /** The composer's imperative handle, for the shell ("Ask the Director…" focuses it in-gesture). */
  composerApiRef?: React.Ref<StudioComposerHandle>;
  /**
   * Phones with the board hidden: the activity line's status opens the board (one status row instead
   * of the line plus a "N pages rendering · View" pill).
   */
  onViewActivity?: () => void;
  initialIdea?: { id: string; text: string };
  onInitialIdeaConsumed?: (id: string) => void;
  /** Brings a waiting step into view for the shell (the stage strip's "Next: review the estimate / follow the Director"). */
  revealApiRef?: React.Ref<ConversationRevealHandle>;
}

/** What the conversation can bring into view: the open approval card, or the Director's draft control. */
export type ConversationRevealTarget = 'approval' | 'draft';
export interface ConversationRevealHandle {
  /**
   * Scrolls the target into view and moves focus to it, so a keyboard or screen-reader user lands on it: the newest open
   * approval card (focus on the card, never on its Approve), or the latest message with focus on the draft control.
   */
  reveal: (target: ConversationRevealTarget) => void;
}

/** Messages before the last few skip offscreen rendering (`content-visibility: auto`). */
const CV_KEEP_LIVE = 6;

const assignRef = <T,>(ref: React.Ref<T> | undefined, value: T | null) => {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as React.MutableRefObject<T | null>).current = value;
};

export const ConversationPane: React.FC<ConversationPaneProps> = ({ studio, replaceList, aboveComposer, className, insetBottom = true, composerApiRef, onViewActivity, initialIdea, onInitialIdeaConsumed, revealApiRef }) => {
  const { doc, drafts, pendingMessage, messageBusy } = studio;
  const sectionRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<StudioComposerHandle | null>(null);
  const setComposer = useCallback(
    (handle: StudioComposerHandle | null) => {
      composerRef.current = handle;
      assignRef(composerApiRef, handle);
    },
    [composerApiRef]
  );
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const entries = useMemo(() => conversationEntries(doc, drafts), [doc, drafts]);
  // MO-2: the newest message present on this doc's first render is history; only newer ones rise in.
  seedEntrances(doc?.id, doc?.conversation);
  const docKey = doc?.id;
  // PF-7a: the rows see a controller that keeps its identity while only the streaming drafts change.
  const rowStudio = useRowStudio(studio);
  // Settled cards: one index per doc revision, this tab's sending message and the waiting retries (local memory only).
  const settleOn = settledCardsOn(studio.caps?.admin);
  const retries = useSyncExternalStore(subscribeRetries, retriesVersion, retriesVersion);
  const working = !!studio.busy || messageBusy;
  const settles = useMemo(
    () => (settleOn && doc ? buildSettleIndex(doc, { pending: pendingMessage, retrying: waitingRetries().map((r) => r.cardId), working }) : undefined),
    // `retries` is the retry store's version: a waiting intent added or settled rebuilds the index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settleOn, doc, pendingMessage, working, retries]
  );
  const latestUserId = useMemo(() => {
    if (!settleOn || pendingMessage?.status === 'sending') return undefined;
    const list = doc?.conversation || [];
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.role === 'user') return list[i].id;
    return undefined;
  }, [settleOn, doc?.conversation, pendingMessage?.status]);
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

  // Stick to the bottom while pinned. The empty state is a welcome, not a log: it starts at the top
  // (scrolling it "to the bottom" hid the heading on short phones — visualqa P2-1).
  useLayoutEffect(() => {
    if (pinnedRef.current && !isEmpty) scrollToBottom();
  }, [signature, scrollToBottom, isEmpty]);

  // The keyboard opening/closing resizes the log: keep a pinned conversation on the latest message.
  // Subscribed directly (it also keeps --app-h/--kb written while the pane is mounted): re-rendering
  // every message on each frame of the keyboard animation would make typing janky on a phone.
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  useEffect(
    () =>
      subscribeKeyboardInset(() => {
        if (pinnedRef.current && !isEmptyRef.current) scrollToBottom();
      }),
    [scrollToBottom]
  );

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
    if (!replaceList && !isEmpty) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceList, scrollToBottom]);

  useImperativeHandle(
    revealApiRef,
    () => ({
      reveal: (target) => {
        const root = sectionRef.current;
        if (!root) return;
        if (target === 'approval') {
          const cards = root.querySelectorAll<HTMLElement>('[data-approval-open]');
          const card = cards[cards.length - 1];
          if (card) {
            if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
            card.focus({ preventScroll: true });
            return;
          }
        }
        scrollToBottom(!prefersReducedMotion());
        root.querySelector<HTMLElement>('[data-draft-control]')?.focus({ preventScroll: true });
      }
    }),
    [scrollToBottom]
  );

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
    <section ref={sectionRef} aria-label="Conversation" className={cx('relative flex h-full min-h-0 w-full flex-col', className)} onDragOver={onDragOver} onDrop={onDrop}>
      {doc && !replaceList && <DirectorDraftControl key={doc.id} studio={studio} readComposerDraft={() => composerRef.current?.readDraft?.() ?? ''} />}
      {replaceList ? (
        <div className="min-h-0 flex-1 overflow-hidden">{replaceList}</div>
      ) : (
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div
            ref={contentRef}
            role="log"
            aria-label="Messages"
            aria-live="polite"
            aria-relevant="additions"
            className={cx('mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col gap-6 px-4 pt-6 sm:px-6', pinned ? 'pb-6' : 'pb-14')}
          >
            {isEmpty ? (
              doc?.directorDraft && doc.directorDraft.status !== 'hands_on' ? (
                <div className="mx-auto my-auto w-full max-w-xl space-y-3 py-5">
                  <DirectorMark className="h-8 w-8" />
                  <h2 className="text-xl font-semibold tracking-tight text-[var(--ds-ink)]">Your story brief</h2>
                  <p className={`line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ds-muted)] ${WRAP_TEXT}`}>{doc.directorDraft.idea}</p>
                </div>
              ) : <EmptyConversation onSend={(t) => void studio.send(t)} disabled={!doc || messageBusy} />
            ) : (
              <>
                {docEntries.map(({ msg, draft }, i) => {
                  const streaming = !!draft && messageBusy;
                  const showSuggestions = msg.id === lastAssistantId && lastEntry?.msg.id === msg.id && !messageBusy && !pendingMessage;
                  // Q-SETTLE: a reply that renders nothing (only a question the chat moved past) takes no slot at all — no
                  // gap, and no offscreen wrapper holding room for it.
                  if (msg.role === 'assistant' && assistantRowEmpty(msg, { draft, streaming, settles, showSuggestions, doc })) return null;
                  const item =
                    msg.role === 'user' ? (
                      <UserMessageRow msg={msg} studio={rowStudio} docKey={docKey} latest={settleOn ? msg.id === latestUserId : undefined} />
                    ) : (
                      <AssistantMessageRow
                        msg={msg}
                        draft={draft}
                        streaming={streaming}
                        showSuggestions={showSuggestions}
                        studio={rowStudio}
                        settles={settles}
                        docKey={docKey}
                      />
                    );
                  // Older messages skip rendering while offscreen (cheap on long conversations).
                  return i < docEntries.length - CV_KEEP_LIVE ? (
                    <div key={msg.id} className="cv-auto min-w-0">
                      {item}
                    </div>
                  ) : (
                    <React.Fragment key={msg.id}>{item}</React.Fragment>
                  );
                })}
                {pendingMessage && (
                  <PendingMessageRow
                    key={pendingMessage.id}
                    id={pendingMessage.id}
                    at={pendingMessage.at}
                    docKey={docKey}
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
                  <AssistantMessageRow key={msg.id} msg={msg} draft={draft} streaming={messageBusy} studio={rowStudio} docKey={docKey} uncommitted />
                ))}
                {showThinking && <DirectorProgress activity={studio.activity} />}
              </>
            )}
          </div>
        </div>
      )}

      <div className={cx('relative shrink-0 px-3 pt-0.5 sm:px-4', insetBottom ? 'pb-[max(0.75rem,var(--sa-bottom-eff,0px))]' : 'pb-2')} data-composer-dock>
        {!replaceList && !pinned && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] shadow-[0_4px_16px_rgba(0,0,0,0.12)] backdrop-blur-md animate-scale-in hover:bg-[var(--ds-raised)] coarse:min-h-[44px] coarse:px-4"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Jump to latest
            </button>
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl">
          {/* Calm, docked messages: the last error (tailored by its code), the undo/redo notice and
              the "done by the editor" savings line — never a silent studio. */}
          <StudioErrorBanner studio={studio} className="mb-2" />
          <StudioNoticeToast studio={studio} className="mb-2" />
          <SavedByEditorNote studio={studio} className="mb-1" />
          <ActivityLine studio={studio} className="mb-0.5" onView={onViewActivity} />
          <QueuedMessages studio={studio} className="mb-1.5" />
          {aboveComposer}
          <StudioComposer studio={studio} apiRef={setComposer} initialIdea={initialIdea} onInitialIdeaConsumed={onInitialIdeaConsumed} />
        </div>
      </div>
    </section>
  );
};
