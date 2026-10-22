// Maps a conversation Card to its component. Each card renders LIVE doc state through the
// controller, and sits behind a small error boundary so one bad card can never take the
// whole conversation down.
//
// Built-in types render first; any other type is looked up in the feature card registry
// (features.ts, contract §13.2) — that is how wave-1 features add cards without editing
// this file. A type nobody handles renders nothing (a newer server never breaks the chat).

import React from 'react';
import type { Card, ComicDoc, Msg } from '../../../../shared/comic/doc';
import type { ComicStudioController } from '../../useStudio';
import { registeredCard } from '../../features';
import { CastCard } from './CastCard';
import { GateCard } from './GateCard';
import { NoticeCard } from './NoticeCard';
import { OptionsCard } from './OptionsCard';
import { PlanCard } from './PlanCard';
import { RecapCard } from './RecapCard';
import { RendersCard } from './RendersCard';
import { StyleChoiceCard } from './StyleChoiceCard';

/** Card types this renderer handles itself (the original seven plus `recap`); the rest come from the registry. */
export const CARD_TYPES: ReadonlyArray<Card['type']> = ['options', 'style_choice', 'cast', 'plan', 'gate', 'renders', 'notice', 'recap'];

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

export const CardRenderer: React.FC<{ card: Card; studio: ComicStudioController; message?: Msg }> = ({ card, studio, message }) => {
  if (!card || typeof card !== 'object' || typeof (card as { type?: unknown }).type !== 'string') return null;
  let body: React.ReactNode = null;
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
      body = <NoticeCard card={card} />;
      break;
    case 'recap':
      body = <RecapCard card={card} studio={studio} />;
      break;
    default: {
      const reg = registeredCard((card as { type: string }).type);
      if (!reg) return null; // a card type this client doesn't know yet
      const msg = message || messageOf(studio.doc, card.id) || { id: `card_${card.id}`, role: 'assistant', text: '', at: 0, cards: [card] };
      body = <reg.Component card={card} message={msg} studio={studio} />;
    }
  }
  return <CardBoundary>{body}</CardBoundary>;
};
