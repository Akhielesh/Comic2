/**
 * InfoTooltip on the ds Tooltip (DS-2 B-14, DS-1c #6): the inverted-ink panel on the tooltip layer (Z.tooltip, not
 * z-[9999]), portalled so a scroll container never clips it, opened by keyboard focus; the trigger carries the ink
 * focus ring and is described by the tooltip. The InfoTooltip, InfoDot and GlossaryTerm props are unchanged.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_RING, INVERSE_SURFACE, Z } from '../chat/studioDesign';
import { expectClasses } from '../ds/ds.testkit';
import { TOOLTIP_PANEL } from '../ds/Tooltip';
import { GlossaryTerm, INFO_TOOLTIP_BUBBLE, InfoTooltip } from './InfoTooltip';
import { GLOSSARY } from '../../services/modelGlossary';

// Radix measures its trigger with ResizeObserver, which jsdom lacks (as components/ds/Tooltip.test.tsx stubs it).
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InfoTooltip', () => {
  it('shows the inverted-ink bubble on the tooltip layer on focus, describes its trigger, and hides on Esc', () => {
    render(
      <InfoTooltip content={{ title: 'Context window', body: 'How much text the model reads at once.', scale: 'Bigger is better' }}>
        <span>Context</span>
      </InfoTooltip>
    );
    const trigger = screen.getByText('Context').parentElement!;
    expectClasses(trigger, FOCUS_RING);
    expect(trigger).toHaveAttribute('tabindex', '0');
    act(() => trigger.focus());
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Bigger is better');
    const bubble = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    // The Tooltip panel, widened for a definition (w-60 takes the place of the panel's w-fit).
    expectClasses(bubble, INVERSE_SURFACE, TOOLTIP_PANEL.replace('w-fit ', ''), Z.tooltip, INFO_TOOLTIP_BUBBLE);
    expect(bubble).not.toHaveClass('w-fit');
    expect(bubble.className).not.toMatch(/z-\[9999\]|border-black|shadow-comic|bg-white/);
    // Portalled out of the trigger's container, so a scroll box never clips it.
    expect(trigger.contains(bubble)).toBe(false);
    expect(trigger).toHaveAccessibleDescription(/How much text the model reads at once\./);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('GlossaryTerm keeps its words and shows the glossary entry', () => {
    const term = Object.keys(GLOSSARY)[0] as keyof typeof GLOSSARY;
    render(<GlossaryTerm term={term}>the term</GlossaryTerm>);
    const trigger = screen.getByText('the term').parentElement!;
    act(() => trigger.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY[term]!.body);
  });
});
