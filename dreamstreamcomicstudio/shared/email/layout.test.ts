import { describe, expect, it } from 'vitest';
import { button, codeBadge, featureCard, infoBox, linkFallback, wrapHtml } from './layout.js';
import { DEFAULT_BRAND } from './theme.js';

const brand = DEFAULT_BRAND;
const preheader = 'An example message';

describe('responsive email envelope', () => {
  it('keeps a fluid inline layout and actionable content when a mail client removes head styles', () => {
    const url = 'https://example.test/action?id=123&state=pending';
    const content = button('View project', url) + linkFallback(url) + codeBadge('123456');
    const doc = new DOMParser().parseFromString(wrapHtml({ brand, preheader, content }), 'text/html');
    doc.querySelector('style')?.remove();
    const tables = Array.from(doc.querySelectorAll('table'));
    expect(tables.every(table => table.getAttribute('role') === 'presentation')).toBe(true);
    expect(tables.some(table => table.style.width === '100%' && table.style.maxWidth === '600px')).toBe(true);
    expect(doc.querySelector('.ds-action')?.getAttribute('href')).toBe(url);
    expect(doc.querySelector('.ds-link')?.textContent).toBe(url);
    expect(doc.querySelector('.ds-code')?.textContent).toBe('123456');
    expect(doc.querySelector('.ds-cta')?.hasAttribute('bgcolor')).toBe(true);
  });

  it('preserves template-specific context, logo alternatives and dark-mode support', () => {
    const html = wrapHtml({
      brand: { ...brand, productName: 'A & B', logoUrl: 'https://example.test/mark.png' },
      preheader, content: infoBox('Access is pending') + featureCard('', 'Public Library', 'Read without an account.'),
      essential: true, unsubscribeUrl: 'https://example.test/unsub', footerNotice: 'You registered interest in A & B.'
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('html')?.lang).toBe('en');
    expect(doc.querySelector('img')?.alt).toBe('A & B');
    expect(doc.body.textContent).toContain('You registered interest in A & B.');
    expect(doc.body.textContent).not.toContain('Unsubscribe');
    expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('light dark');
    expect(html).toContain('<!--[if mso]>');
  });
});

describe('DreamStream product identity', () => {
  it('draws the product lockup with the same manifest artwork and live text as the app header', async () => {
    const { default: suiteManifest } = await import('../../public/app.webmanifest?raw');
    const { default: comicsManifest } = await import('../../public/comics.webmanifest?raw');
    const suiteIcons = JSON.parse(suiteManifest).icons.map((icon: { src: string }) => icon.src);
    const comicIcons = JSON.parse(comicsManifest).icons.map((icon: { src: string }) => icon.src);
    for (const [productName, label, icons] of [
      ['DreamStream Studio', 'DreamStream Studio', suiteIcons],
      ['Comic Studio', 'Comic Studio', comicIcons],
      ['Stream Studio', 'Stream Studio', suiteIcons]
    ] as const) {
      const doc = new DOMParser().parseFromString(wrapHtml({
        brand: { ...brand, productName, appUrl: 'https://preview.example.test/live' }, preheader, content: ''
      }), 'text/html');
      const lockup = doc.querySelector('.ds-head a')!;
      const mark = lockup.querySelector('img')!;
      expect(icons).toContain(new URL(mark.src).pathname);
      expect(mark.width).toBe(32);
      expect(mark.height).toBe(32);
      mark.remove();
      expect(lockup.textContent?.trim()).toBe(label);
      expect(lockup.querySelector('strong')?.textContent).toBe(label.split(' ')[0]);
      expect(lockup.querySelector('.ds-muted')?.textContent).toBe('Studio');
    }
  });

  it('uses Atlas ink on suite actions and the paper theme for comic mail across registered scenarios', async () => {
    const { EMAIL_TEMPLATE_NAMES, renderEmail } = await import('./templates');
    for (const name of EMAIL_TEMPLATE_NAMES) {
      const { html } = renderEmail(name);
      // All shell colors are ink, grayscale or warm paper. A violet fill has a higher blue channel than red.
      for (const hex of html.match(/#[0-9a-f]{6}\b/gi) ?? []) {
        const rgb = hex.match(/[0-9a-f]{2}/gi)!.map(channel => Number.parseInt(channel, 16));
        expect(rgb[2], hex).toBeLessThanOrEqual(rgb[0]);
      }
      expect(html).not.toMatch(/^[ \t]+$/m);
    }
    const auth = renderEmail('auth-magic-link', { actionUrl: 'https://example.test/sign-in' });
    const doc = new DOMParser().parseFromString(auth.html, 'text/html');
    expect(doc.querySelector('.ds-cta')?.getAttribute('bgcolor')).toBe('#0a0a0a');
    const comic = wrapHtml({ brand: { ...brand, productName: 'Comic Studio' }, preheader, content: '' });
    expect(comic).toContain('bgcolor="#fbf8f0"');
    expect(comic).toContain('bgcolor="#fffdf7"');
  });
});

it('selects the masthead at the shared dispatch entry point across templates, grants and trusted auth brands', async () => {
  const { renderEmail } = await import('./templates');
  const scenarios = [
    [renderEmail('access-requested'), 'Comic'],
    [renderEmail('studio-invite'), 'Stream'],
    [renderEmail('studio-invite', { studio: 'chat_studio' }), 'Chat'],
    [renderEmail('studio-invite', { studio: 'comic_studio' }), 'Comic'],
    [renderEmail('beta-invite', { studios: 'comic_studio' }), 'Comic'],
    [renderEmail('beta-invite', { studios: 'comic_studio,chat_studio' }), 'DreamStream'],
    [renderEmail('auth-magic-link', {}, { productName: 'Comic Studio', appUrl: 'https://comics.dreamstreamstudio.ai' }), 'Comic'],
    [renderEmail('studio-invite', { studio: 'comic_studio' }, { productName: 'Stream Studio' }), 'Stream']
  ] as const;
  for (const [message, studio] of scenarios) {
    const doc = new DOMParser().parseFromString(message.html, 'text/html');
    expect(doc.querySelector('.ds-head a')?.textContent?.trim()).toBe(studio + ' Studio');
    if (studio === 'Comic') {
      const home = doc.querySelector<HTMLAnchorElement>('.ds-head a')!;
      expect(new URL(home.href).href).toBe('https://comics.dreamstreamstudio.ai/');
    }
    expect(doc.querySelector('.ds-head img')?.getAttribute('src')).toBe(
      DEFAULT_BRAND.appUrl + '/icons/' + (studio === 'Comic' ? 'comics-192.png' : 'app-192.png')
    );
  }
});
