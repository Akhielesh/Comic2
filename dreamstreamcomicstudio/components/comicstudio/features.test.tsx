// Feature registries (contract §13.2): registered cards, tabs and header slots render through
// the hotspot files, in order, and built-ins can never be displaced.
//
// Six feature modules are mocked to exercise the folding rules; the others (lettering, refs, safety,
// immersive, usage) are the REAL wave-1 modules, so their registrations appear in the merged lists.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Card } from '../../shared/comic/doc';

vi.mock('./breakdown/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      cards: [
        {
          type: 'breakdown',
          Component: ({ card, message }: { card: Card; message: { id: string } }) =>
            createElement('div', { 'data-testid': 'breakdown-card' }, `breakdown ${card.id} in ${message.id}`)
        },
        // A feature may never replace a built-in card.
        { type: 'notice', Component: () => createElement('div', null, 'HIJACKED notice') }
      ]
    }
  };
});

vi.mock('./timeline/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      cards: [{ type: 'breakdown', Component: () => createElement('div', null, 'second breakdown (ignored)') }],
      tabs: [
        {
          id: 'media',
          label: 'Media',
          icon: null,
          order: 500,
          Component: () => createElement('div', { 'data-testid': 'media-tab' }, 'Media bin'),
          visible: () => true
        },
        // Built-in tab ids are reserved.
        { id: 'pages', label: 'Pages (fake)', icon: null, order: 1, Component: () => null }
      ]
    }
  };
});

vi.mock('./i18n/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      tabs: [
        {
          id: 'languages',
          label: 'Languages',
          icon: null,
          order: 450,
          Component: () => createElement('div', null, 'Languages'),
          visible: (doc: { i18n?: { editions?: Record<string, unknown> } }) => Object.keys(doc.i18n?.editions || {}).length > 0
        }
      ]
    }
  };
});

vi.mock('./share/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      headerSlots: [
        { id: 'share', order: 250, Component: ({ compact }: { compact: boolean }) => createElement('button', { type: 'button' }, compact ? 'Share·c' : 'Share') }
      ]
    }
  };
});

vi.mock('./mobile/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      headerSlots: [
        { id: 'mode', order: 50, Component: () => createElement('button', { type: 'button' }, 'Easy') },
        {
          id: 'broken',
          order: 60,
          Component: () => {
            throw new Error('boom');
          }
        }
      ]
    }
  };
});

vi.mock('./library/index', async () => {
  const { createElement } = await import('react');
  return { feature: { adminSections: [{ id: 'library', label: 'Library', icon: null, Component: () => createElement('div', null, 'Library console') }] } };
});

import {
  BUILTIN_CARD_TYPES,
  registeredAdminSections,
  registeredCard,
  registeredCardTypes,
  registeredHeaderSlots,
  registeredTabs
} from './features';
import { CardRenderer } from './conversation/cards/CardRenderer';
import { BoardPane } from './board/BoardPane';
import { makeFakeStudio, makeSampleDoc } from './conversation/testing/fixtures';

describe('features registry', () => {
  it('folds feature modules: built-ins win, first registration wins, sorted by order', () => {
    // breakdown (mock) wins over timeline's duplicate; refs is the real P1-REFS card.
    expect(registeredCardTypes()).toEqual(['breakdown', 'refs']);
    expect(registeredCard('notice')).toBeUndefined();
    expect(BUILTIN_CARD_TYPES.has('recap')).toBe(true);
    expect(registeredTabs().map((t) => t.id)).toEqual(['languages', 'media']);
    // usage (real, P1-LIMITS) sits at 220: after the mocked mode/broken slots, before the mocked share (250).
    expect(registeredHeaderSlots().map((s) => s.id)).toEqual(['mode', 'broken', 'usage', 'share']);
    expect(registeredHeaderSlots().find((s) => s.id === 'usage')?.order).toBe(220);
    // Admin sections keep feature order: safety (real) before library (mock).
    expect(registeredAdminSections().map((s) => s.id)).toEqual(['comic-safety', 'library']);
  });
});

describe('CardRenderer + card registry', () => {
  it('renders a registered card with its message; built-ins are never replaced; unknown types render nothing', () => {
    const card = { type: 'breakdown', id: 'card_bd' } as Card;
    const doc = makeSampleDoc({
      conversation: [{ id: 'msg_7', role: 'assistant', text: 'Here is the plan', at: 1, cards: [card] }]
    });
    const studio = makeFakeStudio({ doc });
    render(<CardRenderer card={card} studio={studio} />);
    expect(screen.getByTestId('breakdown-card')).toHaveTextContent('breakdown card_bd in msg_7');

    render(<CardRenderer card={{ type: 'notice', id: 'n1', tone: 'info', text: 'Saved.' }} studio={studio} />);
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    expect(screen.queryByText('HIJACKED notice')).not.toBeInTheDocument();

    const { container } = render(<CardRenderer card={{ type: 'translation', id: 't1', languages: ['te'] }} studio={studio} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('prefers the message passed by the caller', () => {
    const card = { type: 'breakdown', id: 'card_x' } as Card;
    render(<CardRenderer card={card} studio={makeFakeStudio()} message={{ id: 'given', role: 'assistant', text: '', at: 1 }} />);
    expect(screen.getByTestId('breakdown-card')).toHaveTextContent('in given');
  });
});

describe('BoardPane + tab registry', () => {
  it('merges visible registered tabs with the built-ins by order and renders the active one', () => {
    const studio = makeFakeStudio({ tab: 'story' });
    const { rerender } = render(<BoardPane studio={studio} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Board' }))
      .getAllByRole('tab')
      .map((t) => t.textContent?.replace(/\d.*$/, '').trim());
    // languages is hidden (no edition); media sits between Pages (400) and Read (900).
    expect(tabs).toEqual(['Story', 'Cast', 'Style', 'Pages', 'Media', 'Read']);

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    expect(studio.setTab).toHaveBeenCalledWith('media');

    rerender(<BoardPane studio={{ ...studio, tab: 'media' }} />);
    expect(screen.getByTestId('media-tab')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Media' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a tab once its visibility check passes', () => {
    const doc = makeSampleDoc();
    doc.i18n = { editions: { te: {} as never }, glossary: [] };
    render(<BoardPane studio={makeFakeStudio({ doc, tab: 'story' })} />);
    const names = within(screen.getByRole('tablist', { name: 'Board' }))
      .getAllByRole('tab')
      .map((t) => t.textContent?.replace(/\d.*$/, '').trim());
    expect(names).toEqual(['Story', 'Cast', 'Style', 'Pages', 'Languages', 'Media', 'Read']);
  });
});
