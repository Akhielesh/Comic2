// FlightStatus without live data: the card names the flight, says why there is no live status
// and offers one link to check the flight on the web. It shows no times, gates, terminals, delays
// or route arc, even when a card saved in chat history before carries some (live:false).
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FlightStatusArtifact } from '../../../apiTypes';
import { FlightStatus } from './FlightStatus';
import { DensityProvider } from './kit';

afterEach(cleanup);

const UNAVAILABLE: FlightStatusArtifact = { flightNumber: 'UA2402', airline: 'United', live: false, unavailable: true };

const LIVE: FlightStatusArtifact = {
  airline: 'United',
  flightNumber: 'UA2402',
  status: 'active',
  departure: { code: 'SFO', city: 'San Francisco', scheduled: '2026-06-10T09:15:00', actual: '2026-06-10T09:32:00', gate: 'G92' },
  arrival: { code: 'HND', city: 'Tokyo Haneda', scheduled: '2026-06-11T13:05:00' },
  progressPct: 62,
  delayMin: 17,
  live: true,
  asOf: '2026-06-10T14:30:00Z'
};

/** The shape the old keyless path saved: live:false, remembered times, no `unavailable` flag. */
const SAVED_KEYLESS: FlightStatusArtifact = {
  airline: 'United',
  flightNumber: 'UA2402',
  status: 'scheduled',
  departure: { code: 'SFO', scheduled: '2026-06-10T09:15:00', terminal: 'I', gate: 'G92' },
  arrival: { code: 'HND', scheduled: '2026-06-11T13:05:00' },
  progressPct: 0,
  live: false,
  asOf: '2026-06-10T08:00:00Z'
};

const CLOCK = /\b\d{1,2}:\d{2}\b/;

describe('FlightStatus without live data', () => {
  it('names the flight, says why, links to a web search and shows no times', () => {
    const { container } = render(<FlightStatus data={UNAVAILABLE} />);
    expect(screen.getByText('United UA2402')).toBeInTheDocument();
    expect(screen.getByText('Live status needs a data source')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Check this flight on the web/ });
    expect(link).toHaveAttribute('href', 'https://www.google.com/search?q=UA2402%20flight%20status');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(CLOCK);
    expect(text).not.toMatch(/Departure|Arrival|Terminal|Gate|min\b|Scheduled|In flight|Unknown|updated/);
    expect(screen.queryByText('Live')).toBeNull();
    expect(container.querySelector('svg[viewBox="0 0 280 90"]')).toBeNull();
  });

  it('shows none of the times or gates a card saved in chat history before carries', () => {
    // The old keyless path saved live:false with the times the model remembered and no `unavailable`.
    const { container } = render(<FlightStatus data={SAVED_KEYLESS} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(CLOCK);
    expect(text).not.toMatch(/G92|Gate|Terminal|Departure|Arrival|Scheduled|SFO|HND/);
    expect(screen.getByText('United UA2402')).toBeInTheDocument();
    expect(screen.getByText('Live status needs a data source')).toBeInTheDocument();
    expect(container.querySelector('svg[viewBox="0 0 280 90"]')).toBeNull();
  });

  it('shows no saved times in the compact glance either', () => {
    const { container } = render(
      <DensityProvider value="compact">
        <FlightStatus data={SAVED_KEYLESS} />
      </DensityProvider>
    );
    expect(container.textContent ?? '').not.toMatch(CLOCK);
    expect(container.textContent ?? '').not.toMatch(/SFO|HND|Scheduled/);
    expect(screen.getByText('Live status needs a data source')).toBeInTheDocument();
  });

  it('a card that kept old times next to the new flag shows none of them', () => {
    const stale: FlightStatusArtifact = { ...LIVE, live: false, unavailable: true };
    const { container } = render(<FlightStatus data={stale} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(CLOCK);
    expect(text).not.toMatch(/G92|SFO|HND|\+17/);
    expect(screen.getByText('Live status needs a data source')).toBeInTheDocument();
  });

  it('says why when a configured source answered without a record, was busy or did not answer', () => {
    const cases: [NonNullable<FlightStatusArtifact['unavailableReason']>, string][] = [
      ['no_record', 'No live status for this flight right now'],
      ['busy', 'Live flight status is busy right now'],
      ['no_answer', 'Live flight status is not answering right now']
    ];
    for (const [reason, sentence] of cases) {
      const { container, unmount } = render(<FlightStatus data={{ ...UNAVAILABLE, unavailableReason: reason }} />);
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText('Live status needs a data source')).toBeNull();
      expect(container.textContent ?? '').not.toMatch(CLOCK);
      unmount();
    }
  });

  it('keeps the same honesty in the compact glance', () => {
    const { container } = render(
      <DensityProvider value="compact">
        <FlightStatus data={UNAVAILABLE} />
      </DensityProvider>
    );
    expect(screen.getByText('United UA2402')).toBeInTheDocument();
    expect(screen.getByText('Live status needs a data source')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Check this flight on the web/ })).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(CLOCK);
  });
});

describe('FlightStatus with live data', () => {
  it('still renders the route, both endpoints and the live badge', () => {
    render(<FlightStatus data={LIVE} />);
    expect(screen.getByText('Departure')).toBeInTheDocument();
    expect(screen.getByText('Arrival')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Live status needs a data source')).toBeNull();
  });
});
