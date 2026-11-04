// W1.9 (plan §7): the email draft card. Agents draft, people send: the preview is a sandbox="" srcdoc iframe under a
// CSP, there is no Send control, a model-only address enters the compose links only when the person taps Add, every
// link is listed with its full address, and a governed person never sees '$'.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { EMAIL_PREVIEW_CSP, EmailDraftCard, emailPreviewAttributes, emailPreviewSrcDoc } from './EmailDraftCard';
import { DensityProvider } from './kit';
import { emailDraftDemo } from '../ComponentGallery';
import type { EmailDraftArtifact } from '../../../apiTypes';
import { renderEmail, reviewEmail } from '../../../packages/platform-core/src/email/index';
import { brandKitById } from '../../../packages/platform-core/src/brand/index';
import { checkEmailDoc } from '../../../packages/platform-core/src/models/email/index';

const gmailHref = (): string => (screen.getByRole('link', { name: /open in gmail/i }) as HTMLAnchorElement).getAttribute('href') || '';
const mailtoHref = (): string => (screen.getByRole('link', { name: /open in mail app/i }) as HTMLAnchorElement).getAttribute('href') || '';

describe('EmailDraftCard', () => {
  it('previews in a sandbox="" srcdoc iframe with the CSP first in <head> (no src, no referrer)', () => {
    const { container } = render(<EmailDraftCard data={emailDraftDemo} />);
    const frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const srcdoc = frame.getAttribute('srcdoc') || '';
    expect(srcdoc.indexOf(`<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`)).toBe(srcdoc.indexOf('<head>') + '<head>'.length);
    expect(EMAIL_PREVIEW_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(srcdoc).toContain('We open the doors on Friday');
    // Without a <head>, the guard still comes first.
    expect(emailPreviewSrcDoc('<p>x</p>').startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    // A <header> is not a <head>: a CSP meta inside <header> (in the body) would be ignored and the image would load.
    const headerOnly = emailPreviewSrcDoc('<header>x</header><img src="https://t.example/p.png">');
    expect(headerOnly.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(headerOnly).toContain('<body><header>x</header>');
    // A <head> with attributes still takes the guard first.
    expect(emailPreviewSrcDoc('<html><head lang="en"><title>t</title></head><body></body></html>')).toContain(
      `<head lang="en"><meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`
    );
    expect(emailPreviewAttributes()).toMatchObject({ sandbox: '' });
    expect('src' in emailPreviewAttributes()).toBe(false);
  });

  it('has no Send control, in either density: only Open in Gmail, Open in mail app and Copy text', () => {
    for (const density of ['detailed', 'compact'] as const) {
      const { container, unmount } = render(
        <DensityProvider value={density}>
          <EmailDraftCard data={emailDraftDemo} />
        </DensityProvider>
      );
      const controls = [...container.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
      for (const c of controls) expect(c.textContent || c.getAttribute('aria-label') || '', density).not.toMatch(/\bsend\b/i);
      expect(screen.getByRole('link', { name: /open in gmail/i })).toBeTruthy();
      expect(screen.getByRole('link', { name: /open in mail app/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /copy text/i })).toBeTruthy();
      expect(container.querySelector('form')).toBeNull();
      unmount();
    }
  });

  it('keeps a model-only address out of the compose links until the person taps Add', () => {
    render(<EmailDraftCard data={emailDraftDemo} />);
    const suggested = screen.getByRole('list', { name: /suggested addresses, not added/i });
    expect(within(suggested).getByText(/press@citydesk\.news/)).toBeTruthy();
    expect(within(suggested).getByText('Suggested by AI — not added')).toBeTruthy();
    for (const href of [gmailHref(), mailtoHref()]) {
      expect(href).toContain('dana%40northwind.co');
      expect(href).toContain('marcus%40northwind.co');
      expect(href).not.toContain('press');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add press@citydesk.news' }));
    expect(gmailHref()).toContain('to=dana%40northwind.co%2Cpress%40citydesk.news');
    expect(mailtoHref()).toContain('press%40citydesk.news');
    expect(screen.queryByRole('list', { name: /suggested addresses, not added/i })).toBeNull();
    expect(screen.getByText('· added by you')).toBeTruthy();
  });

  it('a stored artifact someone edited cannot navigate the preview or put a script link on the page', () => {
    const edited: EmailDraftArtifact = {
      ...emailDraftDemo,
      html: emailDraftDemo.html.replace('<head>', '<head><meta http-equiv="refresh" content="0;url=https://evil.example/">'),
      review: { ...emailDraftDemo.review, links: [{ href: 'javascript:alert(1)', text: 'click', blockId: 'p1', source: 'run' }] }
    };
    const { container } = render(<EmailDraftCard data={edited} />);
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).not.toMatch(/refresh/i);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('javascript:alert(1)').tagName).toBe('SPAN');
  });

  it('lists every link with its full address', () => {
    render(<EmailDraftCard data={emailDraftDemo} />);
    const links = screen.getByRole('region', { name: 'Links' });
    for (const href of ['https://northwind.co/opening/rsvp', 'https://northwind.co/opening']) {
      const a = within(links).getByText(href).closest('a')!;
      expect(a.getAttribute('href')).toBe(href);
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });

  it('the usage line names no amount (the chat turn already counted it), so nobody sees $ or "Free"', () => {
    for (const governed of [true, false, undefined]) {
      const view = render(<EmailDraftCard data={{ ...emailDraftDemo, governed: governed as boolean }} />);
      const text = view.container.textContent || '';
      expect(text, String(governed)).toContain("Included in this chat's usage — no extra model call. Nothing is sent from here.");
      expect(text, String(governed)).not.toContain('$');
      expect(text, String(governed)).not.toMatch(/\bFree\b/);
      view.unmount();
    }
  });

  it('in a reply nothing is pre-filled and the card says why', () => {
    const reply: EmailDraftArtifact = {
      ...emailDraftDemo,
      doc: { ...emailDraftDemo.doc, mode: 'reply' },
      review: reviewEmail({ ...emailDraftDemo.doc, mode: 'reply' }, { mode: 'reply', participants: [], userTyped: ['dana@northwind.co'] })
    };
    render(<EmailDraftCard data={reply} />);
    expect(screen.getAllByText(/In a reply your mail app chooses the recipients/)).toHaveLength(1);
    expect(gmailHref()).toContain('to=&');
  });

  it('the gallery demo is exactly what the server tool would return (renderEmail, reviewEmail)', () => {
    const checked = checkEmailDoc(emailDraftDemo.doc);
    expect(checked.ok).toBe(true);
    const rendered = renderEmail(emailDraftDemo.doc, brandKitById(emailDraftDemo.doc.brand));
    expect(emailDraftDemo.html).toBe(rendered.html);
    expect(emailDraftDemo.text).toBe(rendered.text);
    expect(emailDraftDemo.review).toEqual(
      reviewEmail(emailDraftDemo.doc, { mode: emailDraftDemo.doc.mode, participants: [], userTyped: ['dana@northwind.co', 'marcus@northwind.co'] })
    );
  });
});
