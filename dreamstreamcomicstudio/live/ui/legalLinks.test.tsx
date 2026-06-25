import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LiveLegalLinks } from './legalLinks';

describe('LiveLegalLinks', () => {
  it('keeps legal and support surfaces reachable from the standalone Stream Studio shell', () => {
    render(<LiveLegalLinks />);

    const nav = screen.getByLabelText(/legal and support links/i);
    expect(within(nav).getByRole('link', { name: /privacy/i })).toHaveAttribute('href', '/?view=privacy');
    expect(within(nav).getByRole('link', { name: /terms/i })).toHaveAttribute('href', '/?view=terms');
    expect(within(nav).getByRole('link', { name: /support/i })).toHaveAttribute(
      'href',
      'mailto:contact@dreamstream.com?subject=Stream%20Studio%20support'
    );
  });
});
