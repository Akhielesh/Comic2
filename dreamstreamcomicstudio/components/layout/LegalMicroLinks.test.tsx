import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LegalMicroLinks } from './LegalMicroLinks';

describe('LegalMicroLinks', () => {
  it('sends Contact to the DreamStream Studio domain we own', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:contact@dreamstreamstudio.ai');
  });
});
