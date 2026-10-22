// Maps a conversation Card to its component. Each card renders LIVE doc state through the
// controller, and sits behind a small error boundary so one bad card can never take the
// whole conversation down.

import React from 'react';
import type { Card } from '../../../../shared/comic/doc';
import type { ComicStudioController } from '../../useStudio';
import { CastCard } from './CastCard';
import { GateCard } from './GateCard';
import { NoticeCard } from './NoticeCard';
import { OptionsCard } from './OptionsCard';
import { PlanCard } from './PlanCard';
import { RendersCard } from './RendersCard';
import { StyleChoiceCard } from './StyleChoiceCard';

export const CARD_TYPES: ReadonlyArray<Card['type']> = ['options', 'style_choice', 'cast', 'plan', 'gate', 'renders', 'notice'];

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

export const CardRenderer: React.FC<{ card: Card; studio: ComicStudioController }> = ({ card, studio }) => {
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
      body = <PlanCard card={card} studio={studio} />;
      break;
    case 'gate':
      body = <GateCard card={card} studio={studio} />;
      break;
    case 'renders':
      body = <RendersCard card={card} studio={studio} />;
      break;
    case 'notice':
      body = <NoticeCard card={card} />;
      break;
    default:
      return null; // a card type this client doesn't know yet
  }
  return <CardBoundary>{body}</CardBoundary>;
};
