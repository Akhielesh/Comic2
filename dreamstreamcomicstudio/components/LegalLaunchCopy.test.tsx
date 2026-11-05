import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PrivacyPolicy } from './PrivacyPolicy';
import { TermsOfService } from './TermsOfService';
import { SubprocessorsPage } from './legal/SubprocessorsPage';
import { RETENTION } from './legal/legalFacts';

describe('launch legal copy', () => {
  it('explains Stream Studio live-event data, infrastructure, and retention in the privacy policy', () => {
    const { container } = render(<PrivacyPolicy onBack={vi.fn()} />);

    expect(screen.getByText(/Stream Studio live-event data/i)).toBeInTheDocument();
    expect(screen.getByText(/event titles, schedules, host and viewer display names/i)).toBeInTheDocument();
    const retention = container.querySelector('#retention') as HTMLElement;
    const row = (name: string) => within(retention).getByRole('rowheader', { name }).closest('tr') as HTMLElement;
    expect(row('Live stream replays')).toHaveTextContent(`About ${RETENTION.replayHours} hours after the stream ends.`);
    expect(row('7-day cloud copies of recordings')).toHaveTextContent(`About ${RETENTION.cloudCopyDays} days.`);
  });

  it('names the Stream Studio infrastructure on the subprocessors page', () => {
    render(<SubprocessorsPage onBack={vi.fn()} />);
    expect(screen.getByText(/Stream Studio's real-time rooms, storage for live-stream replays and 7-day copies, the encrypted relay for calls and meetings/)).toBeInTheDocument();
  });

  it('sets launch-safe Stream Studio terms for private links, beta limits, and billing approval', () => {
    render(<TermsOfService onBack={vi.fn()} />);

    expect(screen.getByText(/Private studio, guest, admin, or recap links are bearer capability links/i)).toBeInTheDocument();
    expect(screen.getByText(/controlled beta/i)).toBeInTheDocument();
    expect(screen.getByText(/recording and replay availability are not guaranteed/i)).toBeInTheDocument();
    expect(screen.getByText(/subscriptions, paid plans, credit packs, or overage billing are not active unless/i)).toBeInTheDocument();
  });
});
