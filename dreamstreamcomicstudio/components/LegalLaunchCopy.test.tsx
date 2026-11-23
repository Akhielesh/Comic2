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

  it('names OpenRouter, which routes every Comic Studio image request, among the providers', () => {
    render(<PrivacyPolicy onBack={vi.fn()} />);

    const item = screen.getByText('OpenRouter:').closest('li');
    expect(item).toHaveTextContent('OpenRouter: Routes Comic Studio image requests to the model you pick.');
  });

  it('covers interest registration, optional receipts, consent to updates and the front-page cookie', () => {
    render(<PrivacyPolicy onBack={vi.fn()} />);

    const interest = screen.getByText('Interest registration.').closest('li');
    expect(interest).toHaveTextContent(/address and optional answers you submit, the registration page, time and updates preference/i);
    expect(interest).toHaveTextContent(/send a receipt when enabled/i);
    expect(interest).toHaveTextContent(/ask us to remove your registration/i);
    expect(interest).toHaveTextContent(/product updates require your permission and an email confirmation/i);
    expect(interest).toHaveTextContent(/unsubscribe from an update at any time/i);
    const cookie = screen.getByText(/ds_member/).closest('p')!;
    expect(cookie).toHaveTextContent(/only while you are signed in on dreamstreamstudio\.ai/i);
    expect(cookie).toHaveTextContent(/which front page to show/i);
    expect(cookie).toHaveTextContent(/no identifier/i);
  });

  it('sets launch-safe Stream Studio terms for private links, beta limits, and billing approval', () => {
    render(<TermsOfService onBack={vi.fn()} />);

    expect(screen.getByText(/Private studio, guest, admin, or recap links are bearer capability links/i)).toBeInTheDocument();
    expect(screen.getByText(/controlled beta/i)).toBeInTheDocument();
    expect(screen.getByText(/recording and replay availability are not guaranteed/i)).toBeInTheDocument();
    expect(screen.getByText(/subscriptions, paid plans, credit packs, or overage billing are not active unless/i)).toBeInTheDocument();
  });
});
