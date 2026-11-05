// BrandLockup → StudioLogo: the DreamStream house mark and wordmark (components/brand), never the old yellow
// "D" tile in Bangers.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandLockup } from './BrandLockup';

afterEach(cleanup);

describe('BrandLockup', () => {
  it('is the StudioLogo lockup, as a link home', () => {
    const onClick = vi.fn();
    render(<BrandLockup onClick={onClick} />);
    const link = screen.getByRole('link', { name: 'DreamStream Studio home' });
    expect(link).toHaveAttribute('href', '/');
    expect(link.querySelector('.ds-logo svg[data-studio="dreamstream"]')).not.toBeNull();
    expect(link).toHaveTextContent('DreamStream Studio');
    expect(link.outerHTML).not.toMatch(/brand-yellow|font-display|border-black|shadow-/);
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.click(link, { button: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('without a click target it is the lockup alone', () => {
    render(<BrandLockup clickable={false} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('DreamStream')).toBeInTheDocument();
  });

  it('on a phone the muted "Studio" can step aside so the header row fits', () => {
    render(<BrandLockup compactOnPhone />);
    expect(screen.getByRole('link').querySelector('.ds-logo')!.className).toContain('[&_.ds-logo-word-muted]:hidden');
  });
});
