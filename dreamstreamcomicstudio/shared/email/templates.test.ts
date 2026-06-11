import { describe, expect, it } from 'vitest';
import { renderEmail, EMAIL_TEMPLATE_NAMES, isEmailTemplateName, isMarketing, isNoReply, TEMPLATE_KIND } from './index.js';

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
    expect(out.text).toContain('Hey there,');
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

  it('embeds a read-receipt pixel only when a URL is supplied', () => {
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
    expect(out.html).toContain('Go live from any device');
    expect(out.html).toContain('Stay tuned');
    expect(out.text).toContain('Stay tuned');
  });

  it('studio-invite renders per-studio feature sets and deep links', () => {
    const comic = renderEmail('studio-invite', { studio: 'comic_studio', inviterName: 'Sam' });
    expect(comic.subject).toBe('Sam invited you to Comic Studio — DreamStream Studio');
    expect(comic.html).toContain('Script to panels');
    expect(comic.html).not.toContain('Go live from any device');
    expect(comic.html).toContain('https://dreamstreamstudio.ai'); // suite root deep link
    expect(comic.html).toContain('Stream Studio and Chat Studio');

    const chat = renderEmail('studio-invite', { studio: 'chat_studio' });
    expect(chat.subject).toBe("You're invited to Chat Studio");
    expect(chat.html).toContain('Dashboards that stay live');
    expect(chat.html).toContain('Stream Studio and Comic Studio');

    // No inviteUrl for stream ⇒ the /live.html deep link is derived from the brand URL.
    const stream = renderEmail('studio-invite', { studio: 'stream_studio' });
    expect(stream.subject).toBe("You're invited to Stream Studio");
    expect(stream.html).toContain('https://dreamstreamstudio.ai/live.html');

    // Unknown ids fall back to the Stream Studio content (existing calls unchanged).
    const fallback = renderEmail('studio-invite', { studio: 'nope' });
    expect(fallback.html).toContain('Go live from any device');
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
  });

  it('automated mail is no-reply with a do-not-reply notice; warm mail is not', () => {
    const auto = renderEmail('auth-magic-link', { actionUrl: 'https://dreamstreamstudio.ai/v' });
    expect(auto.html).toContain("isn't monitored");
    expect(auto.text).toContain("please don't reply");
    expect(isNoReply('auth-magic-link')).toBe(true);
    expect(isNoReply('welcome')).toBe(false);
    expect(renderEmail('welcome', {}).html).not.toContain("isn't monitored");
  });

  it('welcome email is fuller — shows the feature sections', () => {
    const out = renderEmail('welcome', { firstName: 'Akhielesh' });
    expect(out.html).toContain('Comic Studio');
    expect(out.html).toContain('AI Chat');
    expect(out.html).toContain('Code Studio');
    expect(out.subject).toContain('Welcome');
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
    expect(out.html).toContain('Open');
  });
});
