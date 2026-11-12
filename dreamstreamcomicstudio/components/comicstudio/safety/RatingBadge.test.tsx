// RatingBadge's on-art variant (DS-R1; redesign plan §4): an opaque pill over a cover, and no terracotta literal
// left in the file (PG-13 reads the accent-soft token off art, the accent mixed into the raised surface on art).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RATING_TONE_ON_ART, RatingBadge } from './RatingBadge';

const SOURCE = readFileSync(path.join(__dirname, 'RatingBadge.tsx'), 'utf8');

describe('RatingBadge on art', () => {
  it('over a cover every rating is an opaque raised pill (no translucent tint for the art to show through)', () => {
    for (const rating of ['G', 'PG', 'PG-13'] as const) {
      const { unmount } = render(<RatingBadge rating={rating} onArt />);
      const pill = screen.getByLabelText(`Rated ${rating}`);
      expect(pill).toHaveAttribute('data-on-art');
      expect(pill.className).toContain(RATING_TONE_ON_ART[rating].split(' ')[0]);
      expect(pill.className).toMatch(/var\(--ds-raised\)/);
      expect(pill.className).not.toMatch(/surface-soft|accent-soft/);
      unmount();
    }
  });

  it('off art PG-13 uses the accent-soft token, and the file spells no hex colour', () => {
    render(<RatingBadge rating="PG-13" />);
    const pill = screen.getByLabelText('Rated PG-13');
    expect(pill.className).toContain('bg-[var(--ds-accent-soft)]');
    expect(pill).not.toHaveAttribute('data-on-art');
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(SOURCE).not.toMatch(/--ds-spark/);
  });
});
