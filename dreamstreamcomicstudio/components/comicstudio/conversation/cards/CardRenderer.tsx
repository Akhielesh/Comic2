// Maps a conversation Card to its component. Each card renders LIVE doc state through the
// controller, and sits behind a small error boundary so one bad card can never take the
// whole conversation down.
//
// Built-in types render first; any other type is looked up in the feature card registry
// (features.ts, contract §13.2) — that is how wave-1 features add cards without editing
// this file. A type nobody handles renders nothing (a newer server never breaks the chat).
//
// Settled cards (PROGRAM3 SETTLE-UI; lead decision D3, CHANGED): with a `settle` from shared/comic/settle.ts (the
// conversation passes one per card while SETTLED_CARDS is on for this viewer), a card the chat has moved past renders
// as its one-line SettledCard and its live component is NEVER mounted — no option chips, no Approve, no paid "More
// options", no images, no History fetch, no model-status request. An open gate, a running render, a running publish
// and a waiting "wait and retry" are never settled (settle.ts), so they stay live however old. When a card settles
// while focus is inside it (the creator just tapped an option), focus moves to its summary. Without a `settle`
// (older hosts, tests, SETTLED_CARDS off) every card renders live, exactly as before.

import React, { useRef } from 'react';
import type { Card, ComicDoc, Msg } from '../../../../shared/comic/doc';
import type { CardSettle } from '../../../../shared/comic/settle';
import type { ComicStudioController } from '../../useStudio';
import { registeredCard } from '../../features';
import { CastCard } from './CastCard';
import { ConflictCard } from './ConflictCard';
import { GateCard } from './GateCard';
import { NoticeCard } from './NoticeCard';
import { OptionsCard } from './OptionsCard';
import { PlanCard } from './PlanCard';
import { RecapCard } from './RecapCard';
import { ResearchCard } from './ResearchCard';
import { RendersCard } from './RendersCard';
import { SettledCardView } from './SettledCard';
import { StyleChoiceCard } from './StyleChoiceCard';

/** Card types this renderer handles itself (the original seven plus `recap` and the live agent's `conflict`); the rest come
 *  from the registry. */
export const CARD_TYPES: ReadonlyArray<Card['type']> = ['options', 'style_choice', 'cast', 'plan', 'gate', 'renders', 'notice', 'recap', 'conflict', 'research'];

class CardBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[comicstudio] card failed to render', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="status" className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--ds-muted)]">
          This card couldn’t be shown. The board has the latest state.
        </div>
      );
    }
    return this.props.children;
  }
}

/** The message that carries a card (registry cards receive it; callers may pass it directly). */
const messageOf = (doc: ComicDoc | null, cardId: string): Msg | undefined => {
  const list = doc?.conversation;
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].cards?.some((c) => c.id === cardId)) return list[i];
  return undefined;
};

export const CardRenderer: React.FC<{ card: Card; studio: ComicStudioController; message?: Msg; settle?: CardSettle | null }> = ({ card, studio, message, settle }) => {
  const settled = settle?.state === 'settled';
  // Focus inside the live card when it settles: read in the render that swaps it (the live DOM is still there), handed
  // to the summary once it mounts. A card that mounts already settled never takes focus.
  const wrapRef = useRef<HTMLDivElement>(null);
  const wasSettled = useRef<boolean | null>(null);
  const focusOnSettle = useRef(false);
  if (settled && wasSettled.current === false) {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    focusOnSettle.current = !!active && !!wrapRef.current && wrapRef.current.contains(active);
  } else if (!settled) focusOnSettle.current = false;
  wasSettled.current = settled;
  if (!card || typeof card !== 'object' || typeof (card as { type?: unknown }).type !== 'string') return null;
  let body: React.ReactNode = null;
  if (settled) {
    const own = CARD_TYPES.includes(card.type) ? undefined : registeredCard((card as { type: string }).type)?.settledSummary;
    // A type this client does not know still reads one quiet line ("Earlier card"), never silent, never interactive.
    body = <SettledCardView card={card} settle={settle!} studio={studio} own={own} takeFocus={focusOnSettle.current} />;
  } else {
    switch (card.type) {
      case 'options':
        body = <OptionsCard card={card} studio={studio} />;
        break;
      case 'style_choice':
        body = <StyleChoiceCard card={card} studio={studio} />;
        break;
      case 'cast':
        body = <CastCard card={card} studio={studio} />;
        break;
      case 'plan':
        body = <PlanCard card={card} studio={studio} message={message || messageOf(studio.doc, card.id)} />;
        break;
      case 'gate':
        body = <GateCard card={card} studio={studio} message={message || messageOf(studio.doc, card.id)} />;
        break;
      case 'renders':
        body = <RendersCard card={card} studio={studio} />;
        break;
      case 'notice':
        // The message's time lets the card retire paid chips its page has been re-checked past.
        body = <NoticeCard card={card} studio={studio} postedAt={(message || messageOf(studio.doc, card.id))?.at} />;
        break;
      case 'recap':
        body = <RecapCard card={card} studio={studio} />;
        break;
      case 'research':
        body = <ResearchCard card={card} studio={studio} />;
        break;
      case 'conflict':
        // The creator's edit and the director's collided mid-turn (agent-editor plan §3 A3.1): Keep mine / Use the director's.
        body = <ConflictCard card={card} studio={studio} />;
        break;
      default: {
        const reg = registeredCard((card as { type: string }).type);
        if (!reg) return null; // a card type this client doesn't know yet
        const msg = message || messageOf(studio.doc, card.id) || { id: `card_${card.id}`, role: 'assistant', text: '', at: 0, cards: [card] };
        body = <reg.Component card={card} message={msg} studio={studio} />;
      }
    }
  }
  // The boundary starts over when the card settles: a live card that failed still gets its one line.
  const bounded = <CardBoundary key={settled ? 'settled' : 'live'}>{body}</CardBoundary>;
  if (settle === undefined) return bounded;
  return (
    <div ref={wrapRef} className="contents" data-card-state={settle?.state ?? 'live'}>
      {bounded}
    </div>
  );
};
