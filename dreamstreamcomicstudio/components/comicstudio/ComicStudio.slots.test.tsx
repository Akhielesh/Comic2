// Header slot registry (contract §13.2): feature controls interleave with the built-in header
// controls by `order`, get `compact` on narrow screens, and a crashing slot hides itself only.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio } from './conversation/testing/fixtures';

const state = vi.hoisted(() => ({ studio: null as unknown as ComicStudioController, wide: true }));

vi.mock('./useStudio', () => ({ useStudio: () => state.studio }));
vi.mock('./board/BoardPane', () => ({ BoardPane: () => <div data-testid="board" /> }));
vi.mock('../studio/kit/useMediaQuery', () => ({ useIsWide: () => state.wide, useMediaQuery: () => state.wide }));

vi.mock('./share/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      headerSlots: [{ id: 'share', order: 250, Component: ({ compact }: { compact: boolean }) => createElement('button', { type: 'button' }, compact ? 'Share (compact)' : 'Share') }]
    }
  };
});

vi.mock('./mobile/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      headerSlots: [
        { id: 'mode', order: 10, Component: () => createElement('button', { type: 'button' }, 'Easy') },
        {
          id: 'broken',
          order: 20,
          Component: () => {
            throw new Error('slot exploded');
          }
        },
        { id: 'savings', order: 950, Component: () => createElement('span', null, 'Savings slot') },
        { id: 'statusBanner', order: 1000, Component: ({ compact }: { compact: boolean }) => createElement('p', { role: 'status' }, compact ? 'Model slow (compact)' : 'Model slow') }
      ]
    }
  };
});

import { ComicStudio, ComicStudioShell } from './ComicStudio';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';

beforeEach(() => {
  state.wide = true;
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ComicStudio header slots', () => {
  it('interleaves registered slots with the built-ins by order', () => {
    // A regular header with the board out of sight (Chat only), so the header carries its Read (DC-1: Read shows only
    // while the board, whose Read tab is the reader, is hidden).
    window.localStorage.setItem('cs.split.mode.expanded', 'chat');
    render(
      <FormFactorProvider value={formFactorFor({ w: 1100, h: 800 })}>
        <ComicStudioShell studio={makeFakeStudio()} onBack={vi.fn()} />
      </FormFactorProvider>
    );
    const header = screen.getByRole('banner');
    const order = [
      within(header).getByRole('button', { name: 'Easy' }),
      within(header).getByRole('button', { name: /^Spent / }),
      within(header).getByRole('button', { name: 'Share' }),
      within(header).getByRole('button', { name: 'Read the comic' }),
      within(header).getByRole('button', { name: 'More' }),
      within(header).getByText('Savings slot')
    ];
    for (let i = 1; i < order.length; i += 1) {
      // DOCUMENT_POSITION_FOLLOWING = 4
      expect(order[i - 1].compareDocumentPosition(order[i]) & 4).toBe(4);
    }
    // The crashing slot disappears (logged); the header and studio keep working.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('header slot "broken"'), expect.any(Error));
    expect(screen.getByLabelText('Comic title')).toBeInTheDocument();
  });

  it('below 1024 the icon-only quality chip sits in its built-in place between the slots', () => {
    render(
      <FormFactorProvider value={formFactorFor({ w: 900, h: 800 })}>
        <ComicStudioShell studio={makeFakeStudio()} onBack={vi.fn()} />
      </FormFactorProvider>
    );
    const header = screen.getByRole('banner');
    const order = [within(header).getByRole('button', { name: 'Easy' }), within(header).getByTitle('Quality'), within(header).getByRole('button', { name: /^Spent / })];
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & 4).toBe(4);
  });

  it('renders banner slots (order ≥ 1000) in a strip under the header, not inside it', () => {
    state.studio = makeFakeStudio();
    render(<ComicStudio projectId="proj_1" onBack={vi.fn()} />);
    const banner = screen.getByText('Model slow');
    expect(within(screen.getByRole('banner')).queryByText('Model slow')).toBeNull();
    expect(banner.closest('[data-header-banners]')).not.toBeNull();
  });

  it('passes compact on narrow screens', () => {
    render(
      <FormFactorProvider value={formFactorFor({ w: 390, h: 844, coarse: true })}>
        <ComicStudioShell studio={makeFakeStudio()} onBack={vi.fn()} />
      </FormFactorProvider>
    );
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Share (compact)' })).toBeInTheDocument();
  });
});
