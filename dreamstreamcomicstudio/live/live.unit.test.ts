import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESET_ID,
  FALLBACK_PAGES_LIVE_WORKER_BASE,
  QUALITY_PRESETS,
  presetById,
  resolveWorkerBase,
} from './config';
import { classifyLiveWorkerProbeResponse } from './api';
import { pickSupportedMime, lensLabel, recordingFilename } from './media';
import { Ema, fmtBps, fmtBytes, fmtDuration } from './metrics';

describe('live worker readiness probe', () => {
  it('routes the temporary Pages launch domain to the public workers.dev worker', () => {
    expect(resolveWorkerBase(undefined, { hostname: 'comic2.pages.dev', origin: 'https://comic2.pages.dev' })).toBe(
      FALLBACK_PAGES_LIVE_WORKER_BASE,
    );
  });

  it('keeps custom domains on their same-origin /live-api worker route', () => {
    expect(resolveWorkerBase(undefined, { hostname: 'dreamstreamstudio.ai', origin: 'https://dreamstreamstudio.ai' })).toBe(
      'https://dreamstreamstudio.ai/live-api',
    );
  });

  it('lets an explicit build-time worker base override host heuristics', () => {
    expect(resolveWorkerBase('https://worker.example.test/', { hostname: 'comic2.pages.dev', origin: 'https://comic2.pages.dev' })).toBe(
      'https://worker.example.test',
    );
  });

  it('accepts the no-write missing-event JSON 404 as reachable', () => {
    const body = JSON.stringify({ error: 'not found' });
    const result = classifyLiveWorkerProbeResponse(
      new Response(body, { status: 404, headers: { 'content-type': 'application/json' } }),
      body,
      'https://example.test/live-api',
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('live-worker route reachable');
  });

  it('blocks website HTML so hosts do not submit into a dead /live-api route', () => {
    const body = '<!doctype html><div id="root"></div><script type="module" src="/assets/index.js"></script>';
    const result = classifyLiveWorkerProbeResponse(
      new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      body,
      'https://comic2.pages.dev/live-api',
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('website shell');
  });

  it('calls out Cloudflare challenges separately from generic API failures', () => {
    const body = '<title>Just a moment...</title><p>Cloudflare security verification</p>';
    const result = classifyLiveWorkerProbeResponse(
      new Response(body, { status: 403, headers: { server: 'cloudflare', 'content-type': 'text/html' } }),
      body,
      'https://dreamstreamstudio.ai/live-api',
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Cloudflare security verification');
  });
});

describe('quality presets', () => {
  it('are ordered from cheapest to richest', () => {
    for (let i = 1; i < QUALITY_PRESETS.length; i++) {
      expect(QUALITY_PRESETS[i].videoBps).toBeGreaterThan(QUALITY_PRESETS[i - 1].videoBps);
    }
  });

  it('state an uplink requirement above the actual bitrate (honest headroom)', () => {
    for (const p of QUALITY_PRESETS) {
      const totalMbps = (p.videoBps + p.audioBps) / 1e6;
      expect(p.minUplinkMbps).toBeGreaterThan(totalMbps);
    }
  });

  it('falls back to the default preset for unknown ids', () => {
    expect(presetById('nope').id).toBe(DEFAULT_PRESET_ID);
    expect(presetById('1080p60').id).toBe('1080p60');
  });
});

describe('pickSupportedMime', () => {
  it('prefers mp4/h264 so Safari viewers can always play', () => {
    const mime = pickSupportedMime(() => true);
    expect(mime).toContain('video/mp4');
    expect(mime).toContain('avc1');
  });

  it('falls back to webm when mp4 recording is unsupported', () => {
    const mime = pickSupportedMime((m) => m.startsWith('video/webm'));
    expect(mime).toContain('video/webm');
    expect(mime).toContain('vp9');
  });

  it('returns null when nothing is supported', () => {
    expect(pickSupportedMime(() => false)).toBeNull();
  });

  it('can prefer webm when the host opts into it', () => {
    const mime = pickSupportedMime(() => true, false);
    expect(mime).toContain('video/webm');
  });
});

describe('playbackSupport (viewer fallback chain)', async () => {
  const { playbackSupport } = await import('./player');
  const mime = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';

  it('uses classic MSE when available', () => {
    expect(playbackSupport(mime, { mse: () => true, mms: () => false, canPlayType: () => '' })).toBe('mse');
  });

  it('falls back to ManagedMediaSource on iPhone Safari', () => {
    expect(playbackSupport(mime, { mse: () => false, mms: () => true, canPlayType: () => '' })).toBe('mms');
  });

  it('falls back to the blob queue when no MSE exists but the codec decodes', () => {
    expect(playbackSupport(mime, { mse: () => false, mms: () => false, canPlayType: () => 'probably' })).toBe('blob');
  });

  it('reports none when the device cannot decode the codec at all', () => {
    expect(playbackSupport('video/webm;codecs=vp9,opus', { mse: () => false, mms: () => false, canPlayType: () => '' })).toBe('none');
  });
});

describe('cover themes', async () => {
  const { COVER_THEMES, coverGradient } = await import('./theme');

  it('clamps out-of-range cover indices instead of crashing the invite page', () => {
    expect(coverGradient(-1)).toContain(COVER_THEMES[0][0]);
    expect(coverGradient(99)).toContain(COVER_THEMES[COVER_THEMES.length - 1][0]);
    expect(coverGradient(2)).toContain(COVER_THEMES[2][1]);
  });
});

describe('room moderation (worker)', async () => {
  const { hasProfanity, checkSpam, EMOJI_LIBRARY } = await import('../live-worker/src/moderation');

  it('flags profanity including simple leet-speak, leaves normal chat alone', () => {
    expect(hasProfanity('what the fuck')).toBe(true);
    expect(hasProfanity('sh1t happens')).toBe(true);
    expect(hasProfanity('this stream is great')).toBe(false);
    expect(hasProfanity('the class assignment is done')).toBe(false); // no scunthorpe on "class"
  });

  it('detects the same message repeated 3+ times inside 30 s', () => {
    let s = checkSpam(undefined, 'buy my coins', 0);
    expect(s.spam).toBe(false);
    s = checkSpam(s.next, 'buy my coins', 5_000);
    expect(s.spam).toBe(false);
    s = checkSpam(s.next, 'buy my coins', 10_000);
    expect(s.spam).toBe(true);
    // a different message resets the run
    s = checkSpam(s.next, 'ok sorry', 12_000);
    expect(s.spam).toBe(false);
  });

  it('keeps the client emoji library in sync with the room allowlist', async () => {
    const { EMOJI_LIBRARY: clientLib, QUICK_EMOJI } = await import('./emoji');
    expect([...clientLib]).toEqual([...EMOJI_LIBRARY]);
    // 108 reactions in a 6-per-row grid; the quick bar is the first row.
    expect(clientLib.length).toBe(108);
    expect(new Set(clientLib).size).toBe(clientLib.length); // no duplicates
    expect(QUICK_EMOJI.length).toBe(6);
    expect([...clientLib.slice(0, QUICK_EMOJI.length)]).toEqual([...QUICK_EMOJI]);
    for (const q of QUICK_EMOJI) expect(clientLib).toContain(q);
  });
});

describe('lensLabel', () => {
  it('maps iOS lens names to compact chips', () => {
    expect(lensLabel('Back Ultra Wide Camera', 0)).toBe('0.5×');
    expect(lensLabel('Back Telephoto Camera', 1)).toBe('Tele');
    expect(lensLabel('Back Triple Camera', 2)).toBe('Auto');
    expect(lensLabel('FaceTime HD Camera (Front)', 0)).toBe('Front');
    expect(lensLabel('', 2)).toBe('Cam 3');
  });
});

describe('recordingFilename', () => {
  it('uses the container extension and marks later parts', () => {
    expect(recordingFilename('abc', 1, 'video/mp4;codecs=avc1')).toMatch(/^streamstudio-abc-.*\.mp4$/);
    expect(recordingFilename('abc', 2, 'video/webm')).toMatch(/-part2\.webm$/);
  });
});

describe('metrics helpers', () => {
  it('Ema smooths toward new values', () => {
    const ema = new Ema(0.5);
    expect(ema.push(10)).toBe(10);
    expect(ema.push(20)).toBe(15);
    expect(ema.value).toBe(15);
  });

  it('formats bitrates, bytes and durations', () => {
    expect(fmtBps(null)).toBe('—');
    expect(fmtBps(2_500_000)).toBe('2.5 Mbps');
    expect(fmtBps(96_000)).toBe('96 kbps');
    expect(fmtBytes(1_048_576)).toBe('1.0 MB');
    expect(fmtDuration(65)).toBe('01:05');
    expect(fmtDuration(3725)).toBe('1:02:05');
  });
});

describe('schedule helpers', async () => {
  const { formatCountdown, buildIcs } = await import('./schedule');

  it('formats countdowns at every magnitude', () => {
    expect(formatCountdown(10_000)).toBe('any moment now');
    expect(formatCountdown(5 * 60_000)).toBe('in 5m');
    expect(formatCountdown(90 * 60_000)).toBe('in 1h 30m');
    expect(formatCountdown(50 * 60 * 60_000)).toBe('in 2d 2h');
  });

  it('builds a valid ICS with escaped text and the watch URL', () => {
    const ics = buildIcs({ title: 'Inking; live, draw-along', startMs: Date.UTC(2026, 5, 19, 18, 0, 0), url: 'https://x.test/live.html?e=abc' });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20260619T180000Z');
    expect(ics).toContain('SUMMARY:Inking\\; live\\, draw-along');
    expect(ics).toContain('URL:https://x.test/live.html?e=abc');
    expect(ics).toContain('END:VEVENT');
  });
});

describe('meeting scenes & guest links (v5)', async () => {
  const { SCENES, MULTI_SCENES, fitCanvasToSource } = await import('./studio/compositor');
  const { guestUrl, studioUrl, viewerUrl } = await import('./nav');
  const { MAX_GUESTS } = await import('./protocol');

  it('exposes six scenes with unique sequential hotkeys 1–6', () => {
    expect(SCENES).toHaveLength(6);
    expect(SCENES.map((s) => s.hotkey)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(6);
  });

  it('marks exactly the meeting layouts as multi scenes', () => {
    expect([...MULTI_SCENES].sort()).toEqual(['grid', 'sidebar', 'spotlight']);
    for (const id of MULTI_SCENES) expect(SCENES.some((s) => s.id === id)).toBe(true);
  });

  it('caps guest seats at a small mesh-friendly number', () => {
    expect(MAX_GUESTS).toBeGreaterThanOrEqual(2);
    expect(MAX_GUESTS).toBeLessThanOrEqual(6);
  });

  it('mints distinct viewer / studio / guest links from one event', () => {
    const v = viewerUrl('abc123');
    const s = studioUrl('abc123', 'host-key');
    const g = guestUrl('abc123', 'guest-key');
    expect(v).toContain('?e=abc123');
    expect(v).not.toContain('k=');
    expect(s).toContain('k=host-key');
    expect(g).toContain('g=guest-key');
    expect(g).not.toContain('k=');
  });

  it('keeps canvas dimensions even and orientation-faithful (regression)', () => {
    const portrait = fitCanvasToSource(720, 1280, 1280, 720);
    expect(portrait.h).toBeGreaterThan(portrait.w);
    expect(portrait.w % 2).toBe(0);
    expect(portrait.h % 2).toBe(0);
  });
});
