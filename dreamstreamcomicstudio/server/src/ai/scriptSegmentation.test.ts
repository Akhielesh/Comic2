import { describe, expect, it } from 'vitest';
import { segmentScript } from './scriptSegmentation.js';

describe('segmentScript', () => {
  it('segments by scene markers when present', () => {
    const script = `
Scene 1: SALTY enters the drain.

Scene 2: PIP spots the ball.
    `.trim();

    const segments = segmentScript(script);
    expect(segments).toHaveLength(2);
    expect(segments[0].source).toBe('scene_marker');
    expect(segments[1].rawText.toLowerCase()).toContain('scene 2');
  });

  it('falls back to paragraph segmentation when no scene markers exist', () => {
    const script = `
SALTY enters the tunnel.

PIP follows close behind.
    `.trim();

    const segments = segmentScript(script);
    expect(segments).toHaveLength(2);
    expect(segments[0].source).toBe('paragraph');
  });
});
