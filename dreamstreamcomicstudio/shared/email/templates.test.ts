import { describe, expect, it } from 'vitest';
import { renderEmail, EMAIL_TEMPLATE_NAMES, isEmailTemplateName, isMarketing, isNoReply, senderRoleFor, TEMPLATE_KIND } from './index.js';

describe('email templates', () => {
  it('renders every template with subject, html and text', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      const out = renderEmail(name, {
        confirmUrl: 'https://dreamstreamstudio.ai/confirm?t=abc',
        actionUrl: 'https://dreamstreamstudio.ai/auth/verify?t=abc',
        unsubscribeUrl: 'https://dreamstreamstudio.ai/unsub?t=abc',
        secureUrl: 'https://dreamstreamstudio.ai/security',
        firstName: 'Ada',
        token: '123456',
        newEmail: 'new@example.com',
        time: 'Jun 8, 2026 10:00 UTC',
        device: 'Chrome on macOS',
        location: 'Austin, US',
        ip: '203.0.113.7',
        heading: 'Heads up',
        body: 'First paragraph.\n\nSecond paragraph.',
        inviteUrl: 'https://dreamstreamstudio.ai/?invite=DS-AAAA-BBBB',
        inviterName: 'Sam',
        personalNote: 'Join me!',
        code: 'DS-AAAA-BBBB'
      });
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.html).toContain('<!DOCTYPE html>');
      expect(out.html).toContain('</html>');
      expect(out.text.length).toBeGreaterThan(0);
      // No unresolved mustache-style placeholders leaked through.
      expect(out.html).not.toMatch(/\{\{.*?\}\}/);
    }
  });

  it('escapes HTML in dynamic values (no injection)', () => {
    const out = renderEmail('welcome', { firstName: '<script>alert(1)</script>' });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('neutralizes non-http action URLs', () => {
    const out = renderEmail('auth-magic-link', { actionUrl: 'javascript:alert(1)' });
    expect(out.html).not.toContain('javascript:alert(1)');
  });

  it('greets generically when no name is provided', () => {
    const out = renderEmail('newsletter-confirm', { confirmUrl: 'https://x.test/c' });
    expect(out.text).toContain('Hello,');
  });

  it('acknowledges an interest registration and points to public signup', () => {
    const receipt = renderEmail('access-requested', { firstName: 'Ada' });
    for (const content of [receipt.html, receipt.text]) {
      expect(content).toContain('We recorded your interest in Comic Studio.');
      expect(content).toContain('Choose Sign up on the Comic Studio home page');
      expect(content).not.toContain('your invite will arrive');
    }
  });

  it('applies brand overrides', () => {
    const out = renderEmail('welcome', { firstName: 'Sam' }, { productName: 'Acme Comics' });
    expect(out.subject).toContain('Acme Comics');
    expect(out.html).toContain('Acme Comics');
  });

  it('throws on an unknown template name', () => {
    // @ts-expect-error — deliberately invalid name
    expect(() => renderEmail('nope', {})).toThrow();
  });

  it('exposes a working name guard', () => {
    expect(isEmailTemplateName('welcome')).toBe(true);
    expect(isEmailTemplateName('not-a-template')).toBe(false);
  });

  it('only puts an unsubscribe link on marketing mail', () => {
    const marketing = renderEmail('newsletter-welcome', { unsubscribeUrl: 'https://x.test/unsub?t=1' });
    expect(marketing.html).toContain('Unsubscribe');
    expect(marketing.html).toContain('https://x.test/unsub?t=1');
    expect(marketing.text).toContain('Unsubscribe:');
  });

  it('never lets essential mail be unsubscribed, even if a URL is passed', () => {
    const essential = renderEmail('auth-recovery', {
      actionUrl: 'https://x.test/r',
      unsubscribeUrl: 'https://x.test/unsub?t=1'
    });
    expect(essential.html).not.toContain('https://x.test/unsub?t=1');
    expect(essential.html).toContain('required');
    expect(essential.text).toContain('required');
  });

  it('renders acknowledgement in HTML and text only for eligible messages', () => {
    const ackUrl = 'https://mail.example.test/api/email/ack/sample';
    const pixelUrl = 'https://mail.example.test/api/email/o/sample.gif';
    const receipt = renderEmail('announcement', { ackUrl, pixelUrl });
    expect(receipt.html).toContain(ackUrl);
    expect(receipt.text).toContain(ackUrl);
    expect(receipt.html).toContain('Loading images can record an image request');
    for (const name of ['auth-confirm-signup','auth-magic-link','auth-recovery','auth-security-notice','signin-alert','product-update','newsletter-confirm'] as const) {
      const email = renderEmail(name, { ackUrl, pixelUrl });
      expect(email.html + email.text).not.toContain('mail.example.test');
    }
  });

  it('embeds an image-request pixel only when a URL is supplied', () => {
    const withPixel = renderEmail('welcome', { pixelUrl: 'https://x.test/o/abc.gif' });
    expect(withPixel.html).toContain('https://x.test/o/abc.gif');
    expect(withPixel.html).toMatch(/width="1" height="1"/);
    const without = renderEmail('welcome', {});
    expect(without.html).not.toMatch(/width="1" height="1"/);
  });

  it('classifies auth + security mail as essential and updates as marketing', () => {
    expect(isMarketing('auth-confirm-signup')).toBe(false);
    expect(isMarketing('signin-alert')).toBe(false);
    expect(isMarketing('newsletter-welcome')).toBe(true);
    expect(isMarketing('product-update')).toBe(true);
    // Every template is classified.
    expect(Object.keys(TEMPLATE_KIND).sort()).toEqual([...EMAIL_TEMPLATE_NAMES].sort());
  });

  it('studio-invite defaults to Stream Studio with the suite subject format', () => {
    const out = renderEmail('studio-invite', {
      inviterName: 'Sam',
      inviteUrl: 'https://dreamstreamstudio.ai/live.html'
    });
    expect(out.subject).toBe('Sam invited you to Stream Studio — DreamStream Studio');
    expect(out.html).toContain('Host a live broadcast');
    expect(out.html).toContain('Sign in with the account that received this message.');
    expect(out.text).toContain('Sign in with the account that received this message.');
  });

  it('studio-invite renders per-studio feature sets and deep links', () => {
    const comic = renderEmail('studio-invite', { studio: 'comic_studio', inviterName: 'Sam' });
    expect(comic.subject).toBe('Sam invited you to Comic Studio — DreamStream Studio');
    expect(comic.html).toContain('review your page plan');
    expect(comic.html).not.toContain('Host a live broadcast');
    expect(comic.html).toContain('https://comics.dreamstreamstudio.ai/');
    expect(renderEmail('studio-invite', { studio: 'comic_studio', inviteUrl: 'https://preview.test/' }).text).toContain('Open Comic Studio: https://preview.test/');
    expect(renderEmail('studio-invite', { studio: 'comic_studio', inviteUrl: 'https://dreamstreamstudio.ai/?invite=DS-ABC' }).text).toContain('?invite=DS-ABC');
    expect(comic.html).not.toContain('Stream Studio and Chat Studio');

    const chat = renderEmail('studio-invite', { studio: 'chat_studio' });
    expect(chat.subject).toBe("You're invited to Chat Studio");
    expect(chat.html).toContain('return to your saved chats');
    expect(chat.html).not.toContain('Stream Studio and Comic Studio');

    // No inviteUrl for stream ⇒ the /live.html deep link is derived from the brand URL.
    const stream = renderEmail('studio-invite', { studio: 'stream_studio' });
    expect(stream.subject).toBe("You're invited to Stream Studio");
    expect(stream.html).toContain('https://dreamstreamstudio.ai/live.html');

    // Unknown ids fall back to the Stream Studio content (existing calls unchanged).
    const fallback = renderEmail('studio-invite', { studio: 'nope' });
    expect(fallback.html).toContain('Host a live broadcast');
  });

  it('renders a beta-invite with inviter, note and link', () => {
    const out = renderEmail('beta-invite', {
      inviterName: 'Sam',
      personalNote: 'Join me!',
      inviteUrl: 'https://dreamstreamstudio.ai/?invite=DS-AAAA-BBBB',
      code: 'DS-AAAA-BBBB'
    });
    expect(out.subject).toContain('Sam');
    expect(out.html).toContain('DS-AAAA-BBBB');
    expect(out.html).toContain('Join me!');
    expect(out.html).toContain('invite=DS-AAAA-BBBB');
    // No studios param ⇒ the generic copy, with no coming-soon section.
    expect(out.html).not.toContain('Coming soon to your account');
  });

  it('beta-invite with studios names them, walks their features, without promising ungranted access', () => {
    const out = renderEmail('beta-invite', {
      inviterName: 'Sam',
      inviteUrl: 'https://dreamstreamstudio.ai/?invite=DS-AAAA-BBBB',
      code: 'DS-AAAA-BBBB',
      studios: 'stream_studio,chat_studio'
    });
    // Subject + intro name exactly the included studios.
    expect(out.subject).toBe('Sam invited you to Stream Studio and Chat Studio — DreamStream Studio');
    expect(out.html).toContain('Stream Studio and Chat Studio');
    // Included studios bring their feature tours…
    expect(out.html).toContain('Host a live broadcast');
    expect(out.html).toContain('return to your saved chats');
    // …and the studio NOT included is only present as coming soon (no feature cards).
    expect(out.html).not.toContain('Coming soon to your account');
    expect(out.html).not.toContain('Comic Studio');
    expect(out.html).not.toContain('review your page plan');
    // Plain-text mirrors both halves.
    expect(out.text).toContain('Stream Studio');
    expect(out.text).not.toContain('Coming soon to your account:');
    expect(out.text).not.toContain('Comic Studio');
  });

  it('beta-invite with every studio features all three and skips coming soon', () => {
    const out = renderEmail('beta-invite', { studios: 'stream_studio,comic_studio,chat_studio' });
    expect(out.subject).toBe("You're invited to Stream Studio, Comic Studio and Chat Studio — DreamStream Studio");
    expect(out.html).toContain('Host a live broadcast');
    expect(out.html).toContain('review your page plan');
    expect(out.html).toContain('return to your saved chats');
    expect(out.html).not.toContain('Coming soon to your account');
    // Unknown ids are ignored — garbage degrades to the generic invite, never a crash.
    expect(renderEmail('beta-invite', { studios: 'bogus,unknown' }).html).not.toContain('Coming soon to your account');
  });

  it('automated mail is no-reply with a do-not-reply notice; warm mail is not', () => {
    const auto = renderEmail('auth-magic-link', { actionUrl: 'https://dreamstreamstudio.ai/v' });
    expect(auto.html).toContain("isn't monitored");
    expect(auto.text).toMatch(/please don't reply/i);
    expect(isNoReply('auth-magic-link')).toBe(true);
    expect(isNoReply('welcome')).toBe(false);
    expect(renderEmail('welcome', {}).html).not.toContain("isn't monitored");
  });

  it('welcomes account holders without promising access to specific studios or tiers', () => {
    const out = renderEmail('welcome', { firstName: 'Akhielesh' });
    expect(out.subject).toContain('Welcome');
    for (const body of [out.html, out.text]) {
      expect(body).toContain('studios available to you');
      expect(body).toContain('Open your workspace');
      expect(body).not.toMatch(/100\+ models|Code Studio|three superpowers/);
    }
  });

  it('gives recovery instructions when a required credential is missing', () => {
    for (const body of Object.values(renderEmail('auth-reauthentication', {})).slice(1)) {
      expect(body).toContain('missing its verification code');
      expect(body).not.toContain('------');
    }
    const expired = renderEmail('auth-recovery', {});
    for (const body of [expired.html, expired.text]) {
      expect(body).toContain('missing its action link');
      expect(body).toContain('Forgot password?');
    }
  });

  it('keeps a supplied code out of the subject and preheader and private in both bodies', () => {
    const mail = renderEmail('auth-magic-link', { codeFirst: '1', token: '234567', actionUrl: 'https://example.com/verify' });
    expect(mail.subject).not.toContain('234567');
    expect(mail.html.slice(0, mail.html.indexOf('<body'))).not.toContain('234567');
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('234567');
      expect(body).toContain('Keep this code private');
      expect(body).toContain('https://example.com/verify');
    }
  });

  it('makes an access receipt independent of a subscription or account grant', () => {
    const receipt = renderEmail('access-requested');
    for (const body of [receipt.html, receipt.text]) {
      expect(body).toContain('this address was submitted');
      expect(body).not.toContain('required DreamStream Studio account notification');
      expect(body).not.toContain('Unsubscribe');
    }
  });

  it('includes admin text and a readable plain-text alternative for HTML-only updates', () => {
    const update = renderEmail('product-update', { title: 'Edition export', bodyHtml: '<p>Export is ready.</p><p>Open your book.</p>' });
    expect(update.text).toContain('Edition export');
    expect(update.text).toContain('Export is ready.\nOpen your book.');
    expect(update.text).not.toMatch(/<p>|required DreamStream/);
  });

  it('announcement escapes the composed body (no raw HTML) and keeps paragraphs', () => {
    const out = renderEmail('announcement', {
      heading: 'Title',
      body: 'Para one with <b>tags</b>.\n\nPara two.',
      ctaLabel: 'Open',
      ctaUrl: 'https://dreamstreamstudio.ai/x'
    });
    expect(out.html).not.toContain('<b>tags</b>');
    expect(out.html).toContain('&lt;b&gt;tags&lt;/b&gt;');
    expect(out.html).toContain('Para two.');
    for (const body of [out.html, out.text]) {
      expect(body).toContain('This service notice was sent by DreamStream Studio.');
      expect(body).not.toContain('required DreamStream Studio account notification');
    }
    expect(out.html).toContain('Open');
  });

  it('auth-security-notice is an essential, reply-able notice with per-type copy', () => {
    expect(isMarketing('auth-security-notice')).toBe(false);
    expect(senderRoleFor('auth-security-notice')).toBe('notifications');
    const linked = renderEmail('auth-security-notice', { notice: 'identity_linked', provider: 'github', email: 'ada@example.com' });
    expect(linked.subject).toBe('A new sign-in method was linked — DreamStream Studio');
    expect(linked.html).toContain('GitHub was linked');
    expect(linked.html).toContain('support@dreamstreamstudio.ai');
    expect(linked.html).toContain('required');
    const mfa = renderEmail('auth-security-notice', { notice: 'mfa_factor_enrolled', factorType: 'totp' });
    expect(mfa.text).toContain('authenticator app');
    // Unknown/absent notice ⇒ a safe generic message, never a crash.
    expect(renderEmail('auth-security-notice', {}).subject).toContain('security settings changed');
    // Dynamic values are escaped.
    expect(renderEmail('auth-security-notice', { notice: 'email_changed', oldEmail: '<b>x</b>' }).html).not.toContain('<b>x</b>');
  });

  it('directs security notices to the account security settings when no recovery link is supplied', () => {
    for (const name of ['signin-alert', 'auth-security-notice'] as const) {
      for (const [appUrl, origin] of [
        ['https://comics.dreamstreamstudio.ai', 'https://comics.dreamstreamstudio.ai'],
        ['https://dreamstreamstudio.ai/live', 'https://dreamstreamstudio.ai'],
        ['https://stream.dreamstreamstudio.ai', 'https://dreamstreamstudio.ai']
      ]) {
        const rendered = renderEmail(name, {}, { appUrl });
        expect(rendered.text).toContain(`${origin}/?view=settings&tab=security`);
        expect(rendered.html).toContain(`${origin}/?view=settings&amp;tab=security`);
      }
    }
  });

  it('auth-email-change has a distinct approve-from-current-address variant', () => {
    const current = renderEmail('auth-email-change', {
      emailChangeStep: 'current',
      bothRequired: '1',
      newEmail: 'new@example.com',
      actionUrl: 'https://x.supabase.co/auth/v1/verify?token=h&type=email_change'
    });
    expect(current.subject).toContain('Approve your email change');
    expect(current.html).toContain('new@example.com');
    expect(current.text).toContain('both links are confirmed');
    const next = renderEmail('auth-email-change', { newEmail: 'new@example.com', actionUrl: 'https://x.supabase.co/v' });
    expect(next.subject).toContain('Confirm your new email');
    expect(next.text).not.toContain('both links');
  });
});

describe('Comic Studio creative mail', () => {
  const comicBrand = { productName: 'Comic Studio', appUrl: 'https://comics.dreamstreamstudio.ai' };
  const reader = 'https://comics.dreamstreamstudio.ai/?view=gallery&sample=last-tram';

  it('takes readers straight into the public two-page comic in HTML and plain text', () => {
    for (const message of [
      renderEmail('access-requested'), renderEmail('welcome'),
      renderEmail('newsletter-confirm', { confirmUrl: 'https://example.test/confirm' }, comicBrand),
      renderEmail('newsletter-welcome', {}, comicBrand),
      renderEmail('auth-confirm-signup', { actionUrl: 'https://example.test/verify' }, comicBrand)
    ]) {
      const doc = new DOMParser().parseFromString(message.html, 'text/html');
      const sampleLink = Array.from(doc.querySelectorAll('a')).find(a => a.textContent?.includes('Read both pages'));
      expect(sampleLink?.getAttribute('href')).toBe(reader);
      expect(message.text).toContain(reader);
      expect(doc.querySelector('.ds-comic-still')?.getAttribute('src')).toMatch(/last-tram-strip\.jpg$/);
      expect(doc.querySelector('.ds-comic-motion')?.getAttribute('style')).toContain('display:none');
      expect(message.html).toContain('@media screen and (prefers-reduced-motion:no-preference)');
      expect(message.text).not.toContain('?view=images');
    }
  });

  it('keeps the personal verification action primary, and gives only a known member the image-workspace destination', () => {
    const primary = 'https://example.test/personal-confirm';
    for (const pending of [
      renderEmail('auth-confirm-signup', { actionUrl: primary }, comicBrand),
      renderEmail('newsletter-confirm', { confirmUrl: primary }, comicBrand)
    ]) {
      const doc = new DOMParser().parseFromString(pending.html, 'text/html');
      expect(doc.querySelector('.ds-action')?.getAttribute('href')).toBe(primary);
      expect(pending.text.indexOf(primary)).toBeLessThan(pending.text.indexOf(reader));
      expect(pending.text).not.toMatch(/account is ready|subscription is confirmed/i);
    }
    for (const [studio, include] of [['comic_studio', true], ['stream_studio', false], ['chat_studio', false]] as const) {
      const mail = renderEmail('studio-invite', { studio });
      expect(mail.text.includes('https://comics.dreamstreamstudio.ai/?view=images')).toBe(include);
      expect(mail.html.includes('last-tram-strip.jpg')).toBe(include);
    }
    for (const name of ['auth-recovery', 'auth-reauthentication', 'auth-magic-link', 'auth-security-notice'] as const) {
      const security = renderEmail(name, {}, comicBrand);
      expect(security.html).not.toContain('last-tram-strip');
      expect(security.text).not.toContain(reader);
    }
  });
});
