import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { historyLayers, leaveLayer, pushLayer, resetBackStack } from '../comicstudio/mobile/backStack';
import { LEGAL_DOCS } from '../legal/legalRoutes';
import { LegalMicroLinks } from './LegalMicroLinks';

afterEach(() => resetBackStack());

describe('LegalMicroLinks', () => {
  it('sends Contact to the routed support mailbox on the domain we own', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:support@dreamstreamstudio.ai');
  });

  it('links every legal document by its real path, and calls the Terms "Terms of Service"', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    for (const doc of LEGAL_DOCS) expect(screen.getByRole('link', { name: doc.label })).toHaveAttribute('href', doc.path);
    expect(screen.queryByText(/Conditions/)).toBeNull();
  });

  it('is a navigation landmark, and every link and button is a 44 px target on a touch screen', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Legal and support' });
    const targets = [...within(nav).getAllByRole('link'), within(nav).getByRole('button', { name: 'FAQs' })];
    expect(targets).toHaveLength(LEGAL_DOCS.length + 2); // the six documents, Contact and FAQs
    for (const el of targets) {
      expect(el.className, el.textContent ?? '').toContain('[@media(pointer:coarse)]:min-h-[44px]');
      expect(el.className, el.textContent ?? '').toContain('[@media(pointer:coarse)]:min-w-[44px]');
    }
  });

  it('opens documents inside the app on a plain click, and lets modified clicks through', () => {
    const onOpenPrivacy = vi.fn();
    const onOpenLegal = vi.fn();
    render(<LegalMicroLinks onOpenPrivacy={onOpenPrivacy} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} onOpenLegal={onOpenLegal} />);
    const swallow = (e: MouseEvent) => e.preventDefault(); // jsdom can't navigate
    document.addEventListener('click', swallow);
    fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
    fireEvent.click(screen.getByRole('link', { name: 'Subprocessors' }));
    fireEvent.click(screen.getByRole('link', { name: 'Copyright' }), { ctrlKey: true });
    document.removeEventListener('click', swallow);
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(onOpenLegal).toHaveBeenCalledTimes(1);
    expect(onOpenLegal).toHaveBeenCalledWith('subprocessors');
  });

  it('under a back-stack layer (the comic reader), leaves the history to the layer: its entry is popped, none is added', async () => {
    window.history.replaceState({}, '', '/?view=read&id=c1');
    const id = pushLayer('reader:c1', vi.fn());
    const withLayer = window.history.length;
    expect(historyLayers()).toEqual([id]);
    const openPrivacy = vi.fn();
    // The reader's footer: each link leaves the reader's layer first, then opens the page.
    render(<LegalMicroLinks onOpenPrivacy={() => leaveLayer(id, openPrivacy)} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    const swallow = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('click', swallow);
    fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
    document.removeEventListener('click', swallow);
    await waitFor(() => expect(openPrivacy).toHaveBeenCalledTimes(1));
    // Back on the entry under the layer (App's address sync then puts /privacy on it): no stale reader entry.
    expect(historyLayers()).toEqual([]);
    expect(window.location.search).toBe('?view=read&id=c1');
    expect(window.history.length).toBe(withLayer);
  });
});
