import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET_ID, QUALITY_PRESETS, presetById } from './config';
import { pickSupportedMime, lensLabel, recordingFilename } from './media';
import { Ema, fmtBps, fmtBytes, fmtDuration } from './metrics';

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
    expect(recordingFilename('abc', 1, 'video/mp4;codecs=avc1')).toMatch(/^dreamstream-abc-.*\.mp4$/);
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
