// @vitest-environment jsdom
// The landing's spotlight group (Atlas useSpotlight): a mouse lights the group and feeds every spotlight card
// its own pointer position; touch and pen never do, nor does anything under reduced motion.
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SpotlightGroup } from './SpotlightGroup';
import { SPOTLIGHT_ACTIVE_ATTRIBUTE } from './useSpotlight';

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const move = (el: Element, pointerType: string, x = 40, y = 30) => {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    el.dispatchEvent(event);
  });
};

const setup = () =>
  render(
    <SpotlightGroup data-testid="group">
      <article className="ds-spotlight" data-testid="card" />
    </SpotlightGroup>
  );

describe('SpotlightGroup', () => {
  it('lights up for a mouse and writes the pointer position into each card', () => {
    const { getByTestId } = setup();
    const group = getByTestId('group');
    move(group, 'mouse', 40, 30);
    expect(group.getAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE)).toBe('on');
    const card = getByTestId('card');
    expect(card.style.getPropertyValue('--ds-spot-x')).toBe('40px');
    expect(card.style.getPropertyValue('--ds-spot-y')).toBe('30px');
    act(() => {
      group.dispatchEvent(new MouseEvent('pointerleave'));
    });
    expect(group.hasAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE)).toBe(false);
  });

  it('ignores touch and pen', () => {
    const { getByTestId } = setup();
    move(getByTestId('group'), 'touch');
    move(getByTestId('group'), 'pen');
    expect(getByTestId('group').hasAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE)).toBe(false);
  });

  it('does nothing under reduced motion', () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const { getByTestId } = setup();
    move(getByTestId('group'), 'mouse');
    expect(getByTestId('group').hasAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE)).toBe(false);
  });
});
