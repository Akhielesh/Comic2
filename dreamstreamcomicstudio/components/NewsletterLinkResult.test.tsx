import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { newsletterLinkStatus, NewsletterLinkResult } from './NewsletterLinkResult';

afterEach(cleanup);

describe('outcomes of newsletter links', () => {
  it.each([
    ['confirmed', 'Your subscription is confirmed'],
    ['unsubscribed', 'You’re unsubscribed'],
    ['invalid', 'This confirmation link is no longer valid'],
    ['unsub-invalid', 'This unsubscribe link is no longer valid']
  ])('shows the %s outcome without an account', (key, heading) => {
    const status = newsletterLinkStatus(new URL('https://dreamstreamstudio.ai/?newsletter=' + key));
    expect(status).toBe(key);
    if (!status) throw new Error('Missing status');
    render(<NewsletterLinkResult status={status} />);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue to DreamStream' }).getAttribute('href')).toBe('/');
    expect(Boolean(screen.queryByRole('link', { name: 'Contact support' }))).toBe(key.includes('invalid'));
  });
  it.each(['/?newsletter=unknown', '/?newsletter=constructor', '/?newsletter=confirmed&invite=xyz',
    '/?newsletter=confirmed#access_token=test', '/c/test?newsletter=confirmed', '/auth/callback?newsletter=confirmed'])(
    'leaves %s to application routing', path => {
      expect(newsletterLinkStatus(new URL(path, 'https://dreamstreamstudio.ai'))).toBeNull();
    }
  );
});
