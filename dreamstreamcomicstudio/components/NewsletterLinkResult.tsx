import React from 'react';
import { SUPPORT_EMAIL } from './legal/contacts';

const results = {
  confirmed: {
    heading: 'Your subscription is confirmed',
    detail: 'You’re subscribed to DreamStream product updates. You can unsubscribe from any update email.'
  },
  unsubscribed: {
    heading: 'You’re unsubscribed',
    detail: 'You’ve opted out of marketing emails. You can still receive messages needed for your account.'
  },
  invalid: {
    heading: 'This confirmation link is no longer valid',
    detail: 'Try the newest confirmation email. If you still want updates, you can request a new confirmation.'
  },
  'unsub-invalid': {
    heading: 'This unsubscribe link is no longer valid',
    detail: 'Use the unsubscribe link in your latest update email, or contact support for help.'
  }
} as const;

type ResultStatus = keyof typeof results;

/** The API redirects to this exact form. Leave invitations, shared projects and auth callbacks to their own handlers. */
export function newsletterLinkStatus(url: URL): ResultStatus | null {
  if (url.pathname !== '/' || url.hash || url.searchParams.size !== 1) return null;
  const status = url.searchParams.get('newsletter');
  return status && Object.hasOwn(results, status) ? status as ResultStatus : null;
}

export function NewsletterLinkResult({ status }: { status: ResultStatus }) {
  const { heading, detail } = results[status];
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--ds-canvas)] p-6 text-[var(--ds-ink)]">
      <section className="w-full max-w-md space-y-5" aria-labelledby="newsletter-result">
        <p className="text-sm text-[var(--ds-muted)]">DreamStream Studio</p>
        <h1 id="newsletter-result" className="text-3xl font-semibold tracking-tight">{heading}</h1>
        <p className="leading-relaxed text-[var(--ds-muted)]">{detail}</p>
        <div className="flex flex-wrap items-center gap-x-6">
          <a className="ds-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4" href="/">Continue to DreamStream</a>
          {(status === 'invalid' || status === 'unsub-invalid') && (
            <a className="ds-link inline-flex min-h-11 items-center underline underline-offset-4" href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a>
          )}
        </div>
      </section>
    </main>
  );
}
