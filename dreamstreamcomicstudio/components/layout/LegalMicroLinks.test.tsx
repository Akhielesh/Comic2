import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LEGAL_DOCS } from '../legal/legalRoutes';
import { LegalMicroLinks } from './LegalMicroLinks';

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
});
