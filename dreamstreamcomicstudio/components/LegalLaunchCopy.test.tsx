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

  it('covers registering interest (what is kept, where, for how long, no emails) and the front-page cookie', () => {
    render(<PrivacyPolicy onBack={vi.fn()} />);

    const interest = screen.getByText('Register Interest Data:').closest('li');
    expect(interest).toHaveTextContent(/email address and any optional answers \(first name, what you would like to make, how you heard about us, and anything else you add\)/i);
    expect(interest).toHaveTextContent(/whether you ticked the box to be kept updated, with the time/i);
    expect(interest).not.toHaveTextContent(/studios you pick/i);
    expect(interest).toHaveTextContent(/kept until you ask us to remove it/i);
    expect(interest).toHaveTextContent(/we do not send emails for it/i);
    // The box belongs to the register-interest form only; the Stream Studio list has its own confirm step.
    expect(interest).toHaveTextContent(/From the register-interest form, only people who ticked that box will hear about news or new studios/i);
    expect(interest).toHaveTextContent(/only after confirming their address/i);
    expect(interest).toHaveTextContent(/the Stream Studio list is mailed only after its own confirm step/i);
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
