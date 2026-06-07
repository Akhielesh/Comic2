import { describe, it, expect, afterEach } from 'vitest';
import { VIDEO_TOOLS, videoRenderEnabled } from './videoRender.js';

const tool = VIDEO_TOOLS[0];
const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('render_video tool', () => {
  it('is disabled (with a clear notice) until STUDIO_VIDEO_RENDER_URL is set', async () => {
    delete process.env.STUDIO_VIDEO_RENDER_URL;
    expect(videoRenderEnabled()).toBe(false);
    const r = await tool.execute({ html: '<html></html>' });
    expect(r.notice?.message).toMatch(/not configured/i);
  });

  it('reports enabled when the worker URL is configured', () => {
    process.env.STUDIO_VIDEO_RENDER_URL = 'http://video-render:8400';
    expect(videoRenderEnabled()).toBe(true);
  });
});
