// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  STREAM_HOST_ON,
  STREAM_ORIGIN,
  isLegacyLivePath,
  isStreamHost,
  isStreamUrl,
  screenOfHash,
  streamAddressLabel,
  streamAppHref,
  toStreamUrl,
} from './streamHost';

describe('Stream Studio host', () => {
  it('is stream.dreamstreamstudio.ai, behind one boolean switch', () => {
    expect(STREAM_ORIGIN).toBe('https://stream.dreamstreamstudio.ai');
    expect(typeof STREAM_HOST_ON).toBe('boolean');
    expect(isStreamHost('stream.dreamstreamstudio.ai')).toBe(true);
    expect(isStreamHost('STREAM.dreamstreamstudio.ai')).toBe(true);
    for (const h of ['dreamstreamstudio.ai', 'www.stream.dreamstreamstudio.ai', 'stream.dreamstreamstudio.ai.evil.com', '', null]) {
      expect(isStreamHost(h)).toBe(false);
    }
  });

  it('maps every old address onto the new host, keeping query and fragment', () => {
    expect(toStreamUrl('/live')).toBe(`${STREAM_ORIGIN}/`);
    expect(toStreamUrl('/live/')).toBe(`${STREAM_ORIGIN}/`);
    expect(toStreamUrl('/live.html?e=evt_1')).toBe(`${STREAM_ORIGIN}/?e=evt_1`);
    expect(toStreamUrl('/live#/monitor')).toBe(`${STREAM_ORIGIN}/#/monitor`);
    expect(toStreamUrl('/live.html?e=a#/studio?k=secret')).toBe(`${STREAM_ORIGIN}/?e=a#/studio?k=secret`);
    expect(toStreamUrl('/live?after=monitor&token_hash=h&type=signup')).toBe(`${STREAM_ORIGIN}/?after=monitor&token_hash=h&type=signup`);
    expect(toStreamUrl('', 'https://stream.dreamstreamstudio.ai/')).toBe(`${STREAM_ORIGIN}/`);
    expect(isLegacyLivePath('/live')).toBe(true);
    expect(isLegacyLivePath('/livestream')).toBe(false);
    expect(isLegacyLivePath('/live/x')).toBe(false);
  });

  it('links stay exactly as before with the switch off, and go to the new host with it on', () => {
    for (const legacy of ['/live', '/live.html', '/live#/monitor', '/live#/settings']) {
      expect(streamAppHref(legacy, false)).toBe(legacy);
    }
    expect(streamAppHref('/live#/monitor', true)).toBe(`${STREAM_ORIGIN}/#/monitor`);
    expect(streamAppHref(undefined, true)).toBe(`${STREAM_ORIGIN}/`);
    expect(streamAddressLabel(false)).toBe('dreamstreamstudio.ai/live');
    expect(streamAddressLabel(true)).toBe('stream.dreamstreamstudio.ai');
  });

  it('recognises only real Stream Studio URLs', () => {
    expect(isStreamUrl(`${STREAM_ORIGIN}/#/monitor`)).toBe(true);
    for (const bad of ['/live', 'http://stream.dreamstreamstudio.ai/', 'https://stream.dreamstreamstudio.ai:8443/', 'https://a@stream.dreamstreamstudio.ai/', 'https://stream.dreamstreamstudio.ai.evil.com/', 'javascript:alert(1)', '', null]) {
      expect(isStreamUrl(bad)).toBe(false);
    }
  });

  it('reads the screen a link may return to from a #route', () => {
    expect(screenOfHash('#/monitor/abc/watch')).toBe('monitor');
    expect(screenOfHash('#/calls')).toBe('calls');
    expect(screenOfHash('#/settings?x=1')).toBe('settings');
    expect(screenOfHash('#/studio?k=secret')).toBeUndefined();
    expect(screenOfHash('')).toBeUndefined();
  });
});
