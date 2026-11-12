// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FOCUS_RING, FOCUS_RING_FLUSH } from '../components/chat/studioDesign';
import { cn } from './utils';

describe('cn (tailwind-merge configured for Tailwind 3.4)', () => {
  it('keeps the focus ring whole: a bare outline is the outline style, not a width', () => {
    for (const ring of [FOCUS_RING, FOCUS_RING_FLUSH]) {
      const merged = cn('rounded-md px-3', ring).split(' ');
      expect(merged).toContain('focus-visible:outline');
      expect(merged).toContain('focus-visible:outline-2');
      for (const cls of ring.split(' ')) expect(merged, cls).toContain(cls);
    }
  });

  it('still resolves real conflicts in the outline groups (later wins)', () => {
    expect(cn('outline-2', 'outline-4')).toBe('outline-4');
    expect(cn('outline-[3px]', 'outline-1')).toBe('outline-1');
    expect(cn('outline-dashed', 'outline')).toBe('outline');
    expect(cn('outline', 'outline-none')).toBe('outline-none');
    // A width and a style never cancel each other.
    expect(cn('outline', 'outline-2')).toBe('outline outline-2');
  });

  it('merges ordinary utilities as before', () => {
    expect(cn('px-2 text-[13px]', false && 'hidden', 'px-4')).toBe('text-[13px] px-4');
    expect(cn('text-[var(--ds-muted)]', 'text-[var(--ds-ink)]')).toBe('text-[var(--ds-ink)]');
  });
});
