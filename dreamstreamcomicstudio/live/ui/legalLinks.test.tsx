import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LiveLegalLinks } from './legalLinks';

describe('LiveLegalLinks', () => {
  it('keeps legal and support surfaces reachable from the standalone Stream Studio shell', () => {
    render(<LiveLegalLinks />);

    const nav = screen.getByLabelText(/legal and support links/i);
    expect(within(nav).getByRole('link', { name: /privacy/i })).toHaveAttribute('href', '/privacy');
    expect(within(nav).getByRole('link', { name: /terms/i })).toHaveAttribute('href', '/terms');
    expect(within(nav).getByRole('link', { name: /support/i })).toHaveAttribute(
      'href',
      'mailto:support@dreamstreamstudio.ai?subject=Stream%20Studio%20support'
    );
    expect(within(nav).getByRole('link', { name: /acceptable use/i })).toHaveAttribute('href', '/acceptable-use');
    expect(within(nav).getByRole('link', { name: /copyright/i })).toHaveAttribute('href', '/copyright');
  });
});
