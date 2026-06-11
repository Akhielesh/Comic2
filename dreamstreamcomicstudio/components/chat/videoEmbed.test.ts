import { describe, it, expect } from 'vitest';
import { toVideoEmbed, isEmbeddableVideo, toVideoPreview } from './videoEmbed';

describe('toVideoEmbed', () => {
  it('handles youtube watch URLs', () => {
    const e = toVideoEmbed('https://www.youtube.com/watch?v=CtK8QQjRZOs');
    expect(e?.provider).toBe('youtube');
    expect(e?.id).toBe('CtK8QQjRZOs');
    expect(e?.embedUrl).toContain('youtube-nocookie.com/embed/CtK8QQjRZOs');
    expect(e?.embedUrl).toContain('autoplay=1');
  });

  it('handles youtu.be short links', () => {
    expect(toVideoEmbed('https://youtu.be/PV7_a1jgtWs')?.id).toBe('PV7_a1jgtWs');
  });

  it('handles shorts and embed paths', () => {
    expect(toVideoEmbed('https://www.youtube.com/shorts/abc123def')?.id).toBe('abc123def');
    expect(toVideoEmbed('https://www.youtube.com/embed/abc123def')?.id).toBe('abc123def');
  });

  it('parses start offsets (t=1m30s and t=90)', () => {
    expect(toVideoEmbed('https://youtu.be/abc123def?t=1m30s')?.embedUrl).toContain('start=90');
    expect(toVideoEmbed('https://www.youtube.com/watch?v=abc123def&t=42')?.embedUrl).toContain('start=42');
  });

  it('handles vimeo', () => {
    const e = toVideoEmbed('https://vimeo.com/123456789');
    expect(e?.provider).toBe('vimeo');
    expect(e?.embedUrl).toContain('player.vimeo.com/video/123456789');
  });

  it('returns null for non-video and malformed URLs', () => {
    expect(toVideoEmbed('https://example.com/foo')).toBeNull();
    expect(toVideoEmbed('not a url')).toBeNull();
    expect(isEmbeddableVideo('https://example.com')).toBe(false);
    expect(isEmbeddableVideo('https://youtu.be/CtK8QQjRZOs')).toBe(true);
  });
});

describe('toVideoPreview', () => {
  it('builds a muted, looping, chrome-less youtube preview embed', () => {
    const p = toVideoPreview('https://www.youtube.com/watch?v=CtK8QQjRZOs');
    expect(p?.provider).toBe('youtube');
    expect(p?.embedUrl).toContain('mute=1');
    expect(p?.embedUrl).toContain('controls=0');
    expect(p?.embedUrl).toContain('loop=1');
    // A single-video loop requires playlist=<id>.
    expect(p?.embedUrl).toContain('playlist=CtK8QQjRZOs');
  });

  it('builds a muted, looping vimeo preview', () => {
    const p = toVideoPreview('https://vimeo.com/123456789');
    expect(p?.embedUrl).toContain('muted=1');
    expect(p?.embedUrl).toContain('loop=1');
  });

  it('returns null for unembeddable URLs', () => {
    expect(toVideoPreview('https://example.com/foo')).toBeNull();
  });
});
