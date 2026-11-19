// The public reader's cover card: the Read button's label must stay readable on the accent fill in every
// theme. In Atlas dark the accent is near-white (#fafafa), so a hard `text-white` label disappears there.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ON_ACCENT_TEXT } from '../../chat/studioDesign';
import { ReaderCoverCard } from './ReaderCoverCard';

describe('ReaderCoverCard Read button', () => {
  it('labels the accent fill with the on-accent ink (never text-white), while loading too', () => {
    for (const loading of [false, true]) {
      const { unmount } = render(<ReaderCoverCard title="The Saffron Thief" pageCount={3} onRead={vi.fn()} loading={loading} />);
      const read = screen.getByRole('button', { name: loading ? /Opening/ : /^Read$/ });
      const classes = read.className.split(/\s+/);
      expect(classes).toContain('bg-[var(--ds-accent)]');
      expect(classes).not.toContain('text-white');
      expect(classes).toContain(ON_ACCENT_TEXT);
      unmount();
    }
  });

  it('tries the original cover once after the preloaded cover fails, then shows a steady fallback', () => {
    const cover = 'https://images.test/cover-1080.webp';
    const original = 'https://images.test/cover.webp';
    const { unmount } = render(<ReaderCoverCard title="The Saffron Thief" coverUrl={cover} fallbackCoverUrl={original} onRead={vi.fn()} />);
    const coverArt = screen.getByRole('img', { name: /Cover of/ });
    expect(coverArt).toHaveAttribute('src', cover);
    fireEvent.error(coverArt);
    expect(coverArt).toHaveAttribute('src', original);
    fireEvent.error(coverArt);
    expect(screen.getByRole('img', { name: /Cover unavailable/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read' })).toBeEnabled();
    unmount();
  });
});

describe('ReaderCoverCard call to action', () => {
  it('wraps a long line at narrow widths instead of cutting it off', () => {
    render(<ReaderCoverCard title="Baby at the Lake" pageCount={1} onRead={vi.fn()} cta={{ label: 'Made with Comic Studio', href: '/' }} />);
    const link = screen.getByRole('link', { name: /Made with Comic Studio/ });
    const text = link.querySelector('span')!;
    expect(text.className.split(/\s+/)).not.toContain('truncate');
    expect(text.className).toContain('[overflow-wrap:anywhere]');
  });

  it('the share reader names the studio plainly and invites no sign-up while it is closed', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.resolve(__dirname, '..', 'PublicComicReader.tsx'), 'utf8');
    const cta = src.split('\n').find((line) => line.includes('cta={isOwner')) ?? '';
    expect(cta).toContain("label: 'Made with Comic Studio'");
    expect(cta).not.toMatch(/make your own|DreamStream/i);
  });
});
