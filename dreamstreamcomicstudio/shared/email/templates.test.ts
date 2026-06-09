import { describe, expect, it } from 'vitest';
import { renderEmail, EMAIL_TEMPLATE_NAMES, isEmailTemplateName, isMarketing, TEMPLATE_KIND } from './index.js';

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
        ip: '203.0.113.7'
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
});
