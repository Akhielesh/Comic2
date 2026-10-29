import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConversationPane } from './ConversationPane';
import { makeFakeStudio, resetUsageStatus, showDollarPrices } from './testing/fixtures';

// The docked conversation after the director's reply landed while the pages it started still draw
// (the composer unlocks on the reply): Send is back, and the drawing keeps exactly one Stop — the
// activity line's, right above the composer (the phone sheet's is in StudioComposer.test.tsx).

const textarea = () => screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement;

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

it('once the reply lands Send is back while its pages still draw, and the drawing keeps one Stop (the activity line)', () => {
  // The post-reply state (useStudio): the turn's stream stays open for page 1's progress.
  const studio = makeFakeStudio({ busy: true, messageBusy: false, renderingTotal: 1 });
  render(<ConversationPane studio={studio} />);
  fireEvent.change(textarea(), { target: { value: 'what is left?' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  // Exactly one Stop for the drawing in the docked conversation — none duplicated beside Send.
  const stops = screen.getAllByRole('button', { name: /^Stop/ });
  expect(stops).toHaveLength(1);
  fireEvent.click(stops[0]);
  expect(studio.cancel).toHaveBeenCalledTimes(1);
});

it('while the director is still working, the only Stop is the composer’s "Stop the director"', () => {
  render(<ConversationPane studio={makeFakeStudio({ busy: true, messageBusy: true, renderingTotal: 1 })} />);
  const stops = screen.getAllByRole('button', { name: /^Stop/ });
  expect(stops).toHaveLength(1);
  expect(stops[0]).toHaveAttribute('title', 'Stop the director');
});
