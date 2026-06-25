import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PrivacyPolicy } from './PrivacyPolicy';
import { TermsOfService } from './TermsOfService';

describe('launch legal copy', () => {
  it('explains Stream Studio live-event data, infrastructure, and retention in the privacy policy', () => {
    render(<PrivacyPolicy onBack={vi.fn()} />);

    expect(screen.getByText(/Stream Studio live-event data/i)).toBeInTheDocument();
    expect(screen.getByText(/event titles, schedules, host and viewer display names/i)).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare Workers, Durable Objects, and R2/i)).toBeInTheDocument();
    expect(screen.getByText(/replay segments are designed to expire after about 24 hours/i)).toBeInTheDocument();
  });

  it('sets launch-safe Stream Studio terms for private links, beta limits, and billing approval', () => {
    render(<TermsOfService onBack={vi.fn()} />);

    expect(screen.getByText(/Private studio, guest, admin, or recap links are bearer capability links/i)).toBeInTheDocument();
    expect(screen.getByText(/controlled beta/i)).toBeInTheDocument();
    expect(screen.getByText(/recording and replay availability are not guaranteed/i)).toBeInTheDocument();
    expect(screen.getByText(/subscriptions, paid plans, credit packs, or overage billing are not active unless/i)).toBeInTheDocument();
  });
});
