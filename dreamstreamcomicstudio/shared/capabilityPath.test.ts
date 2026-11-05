// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loggablePath, maskCapabilityUrls } from './capabilityPath';

const SLUG = 'Ab3dEf6hIj9kLm2nP';

describe('loggablePath (S19: share capabilities never reach a log)', () => {
  it.each([
    ['/c', '/c'],
    [`/c/${SLUG}`, '/c/:slug'],
    [`/c/${SLUG}/`, '/c/:slug/'],
    [`/c/${SLUG}/embed`, '/c/:slug/embed'],
    [`/c/${SLUG}/playtime-at-the-lake?lang=hi`, '/c/:slug/playtime-at-the-lake'],
    [`/C/${SLUG}`, '/c/:slug'],
    [`//c/${SLUG}`, '/c/:slug'],
    ['/share/0123456789abcdef0123456789abcdef', '/share/:token'],
    [`/api/comic/public/s/${SLUG}`, '/api/comic/public/s/:slug'],
    [`/api/comic/public/s/${SLUG}/report`, '/api/comic/public/s/:slug/report'],
    [`/api/comic/public/s/${SLUG}/event`, '/api/comic/public/s/:slug/event'],
    [`/API/Comic/Public/S/${SLUG}/report`, '/api/comic/public/s/:slug/report'],
    ['/api/shares/token/tok_abc123XYZ', '/api/shares/token/:token'],
    ['/api/shares/token/tok_abc123XYZ?x=1#frag', '/api/shares/token/:token'],
    ['/api/newsletter/confirm?t=NEWSLETTERTOKEN', '/api/newsletter/confirm'],
    ['/api/connectors/oauth/callback?code=abc&state=xyz', '/api/connectors/oauth/callback'],
    [`/api/comic/oembed?url=https%3A%2F%2Fcomics.dreamstreamstudio.ai%2Fc%2F${SLUG}`, '/api/comic/oembed'],
    [`/api/agent-gate?from=/c/${SLUG}`, '/api/agent-gate']
  ])('%s → %s', (input, expected) => {
    expect(loggablePath(input)).toBe(expected);
  });

  it('keeps the origin of absolute URLs and masks only their path (credentials dropped)', () => {
    expect(loggablePath(`https://comics.dreamstreamstudio.ai/c/${SLUG}?lang=te#p3`)).toBe('https://comics.dreamstreamstudio.ai/c/:slug');
    expect(loggablePath(`https://user:pw@dreamstreamstudio.ai/share/tok_1`)).toBe('https://dreamstreamstudio.ai/share/:token');
    expect(loggablePath('https://dreamstreamstudio.ai/?view=studio&id=p1')).toBe('https://dreamstreamstudio.ai/');
    expect(loggablePath(`https://bad host/c/${SLUG}?x`)).toBe('/c/:slug');
  });

  it('passes ordinary paths through unchanged (owner ids stay debuggable)', () => {
    for (const path of [
      '/api/comic/public/library',
      '/api/comic/public/11111111-2222-3333-4444-555555555555',
      '/api/comic/projects/11111111-2222-3333-4444-555555555555/stream',
      '/api/shares/project/p1',
      '/comics',
      '/chapter/x',
      '/',
      'ai_chat'
    ]) {
      expect(loggablePath(path)).toBe(path);
    }
  });

  it('is idempotent and safe on junk', () => {
    expect(loggablePath(loggablePath(`/c/${SLUG}/embed`))).toBe('/c/:slug/embed');
    for (const junk of [undefined, null, 42, {}, '', '   ']) expect(loggablePath(junk)).toBe('');
    expect(loggablePath(`/x/${'a'.repeat(5000)}`).length).toBeLessThanOrEqual(512);
  });

  it('masks capability URLs inside free text (an error filename / stack frame can be the page URL)', () => {
    const page = `https://comics.dreamstreamstudio.ai/c/${SLUG}/playtime?lang=hi`;
    expect(maskCapabilityUrls(page)).toBe('https://comics.dreamstreamstudio.ai/c/:slug/playtime');
    const chrome = `TypeError: x is undefined\n    at <anonymous> (${page}:110:5)\n    at https://comics.dreamstreamstudio.ai/assets/index-Ab12.js:1:2345`;
    const masked = maskCapabilityUrls(chrome);
    expect(masked).not.toContain(SLUG);
    expect(masked).toContain('(https://comics.dreamstreamstudio.ai/c/:slug/playtime)');
    // Script URLs (with their line:col) and everything else stay as they were.
    expect(masked).toContain('at https://comics.dreamstreamstudio.ai/assets/index-Ab12.js:1:2345');
    const firefox = `run@https://dreamstreamstudio.ai/share/tok_abc123XYZ:3:9\nother@https://dreamstreamstudio.ai/api/comic/public/s/${SLUG}/event`;
    expect(maskCapabilityUrls(firefox)).toBe('run@https://dreamstreamstudio.ai/share/:token\nother@https://dreamstreamstudio.ai/api/comic/public/s/:slug/event');
    expect(maskCapabilityUrls(`Blocked "HTTPS://Comics.DreamStreamStudio.ai/C/${SLUG}".`)).toBe('Blocked "https://comics.dreamstreamstudio.ai/c/:slug".');
    for (const plain of ['', 'Script error.', 'see https://openrouter.ai/api/v1/chat?x=1 now', '/c/not-a-url-in-text', 'https://dreamstreamstudio.ai/?view=read&id=11111111-2222-3333-4444-555555555555']) {
      expect(maskCapabilityUrls(plain)).toBe(plain);
    }
  });
});
