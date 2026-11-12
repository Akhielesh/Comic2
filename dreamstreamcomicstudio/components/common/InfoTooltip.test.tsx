/**
 * InfoTooltip on Atlas (DS-2): the inverted-ink bubble on the tooltip layer (Z.tooltip, not z-[9999]),
 * portalled so a scroll container never clips it; the trigger carries the ink focus ring.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FOCUS_RING, Z } from '../chat/studioDesign';
import { expectClasses } from '../ds/ds.testkit';
import { INFO_TOOLTIP_BUBBLE, InfoTooltip } from './InfoTooltip';

describe('InfoTooltip', () => {
  it('shows the inverted-ink bubble on the tooltip layer on focus, and hides it on blur', () => {
    render(
      <InfoTooltip content={{ title: 'Context window', body: 'How much text the model reads at once.', scale: 'Bigger is better' }}>
        <span>Context</span>
      </InfoTooltip>
    );
    const trigger = screen.getByText('Context').parentElement!;
    expectClasses(trigger, FOCUS_RING);
    fireEvent.focus(trigger);
    const bubble = screen.getByRole('tooltip');
    expectClasses(bubble, INFO_TOOLTIP_BUBBLE, Z.tooltip);
    expect(bubble.className).not.toMatch(/z-\[9999\]|border-black|shadow-comic|bg-white/);
    expect(bubble.parentElement).toBe(document.body);
    expect(trigger).toHaveAttribute('aria-describedby', bubble.id);
    expect(bubble).toHaveTextContent('Bigger is better');
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
