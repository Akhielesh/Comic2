import { describe, it, expect } from 'vitest';
import { screenRecordingSupported, startPreviewRecording } from './studioRecord';

describe('studioRecord', () => {
  it('reports unsupported when getDisplayMedia / MediaRecorder are absent (jsdom)', () => {
    expect(screenRecordingSupported()).toBe(false);
  });

  it('startPreviewRecording resolves null when unsupported (never throws)', async () => {
    await expect(startPreviewRecording('demo')).resolves.toBeNull();
  });
});
