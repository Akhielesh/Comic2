// HTML → MP4 rendering via a self-hosted HyperFrames render worker (the open-design / html-video
// approach: headless Chromium records frames → ffmpeg encodes MP4). That pipeline CANNOT live in the
// main API — it needs Playwright Chromium + an ffmpeg binary and is a heavy sandboxing surface — so
// the agent calls a separate worker at STUDIO_VIDEO_RENDER_URL. Thin + best-effort, like the Nango tools.
// See deploy/studio-tools/ + docs/studio/INTEGRATIONS-VIDEO.md for the worker.

import type { ChatTool, ToolExecResult } from './types.js';

const RENDER_TIMEOUT_MS = 120_000; // renders take a while

const workerUrl = (): string => (process.env.STUDIO_VIDEO_RENDER_URL || '').replace(/\/+$/, '');
export const videoRenderEnabled = (): boolean => Boolean(workerUrl());

const renderVideo: ChatTool = {
  name: 'render_video',
  description:
    'Render an HTML/CSS (+GSAP) animation to an MP4 video via the self-hosted HyperFrames render worker. Provide a COMPLETE, self-contained HTML document whose animations AUTOPLAY on load. Returns a URL/path to the MP4. Use for motion graphics, promos, explainers, logo stings, data-viz videos.',
  parameters: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'A complete, self-contained HTML document (inline CSS/JS; GSAP allowed) whose animation autoplays.' },
      width: { type: 'number', description: 'Video width in px (default 1920).' },
      height: { type: 'number', description: 'Video height in px (default 1080).' },
      fps: { type: 'number', description: 'Frames per second (default 30).' },
      durationSec: { type: 'number', description: 'Optional explicit duration in seconds (otherwise auto-detected from the animation).' },
    },
    required: ['html'],
  },
  execute: async (args, signal): Promise<ToolExecResult> => {
    if (!videoRenderEnabled()) {
      return {
        content:
          'Video rendering is not configured on this server. Deploy a HyperFrames render worker (headless Chromium + ffmpeg) and set STUDIO_VIDEO_RENDER_URL to enable HTML→MP4. (Tip: users can still record the live preview to video client-side.)',
        notice: { level: 'warn', message: 'Video render worker not configured', fix: 'Set STUDIO_VIDEO_RENDER_URL to a deployed render worker.' },
      };
    }
    const html = String(args?.html || '');
    if (!html.trim()) return { content: 'Provide a complete HTML document to render.' };
    const body = {
      html,
      width: Number(args?.width) || 1920,
      height: Number(args?.height) || 1080,
      fps: Number(args?.fps) || 30,
      ...(Number(args?.durationSec) ? { durationSec: Number(args.durationSec) } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${workerUrl()}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { content: `Render worker returned ${res.status}. ${text.slice(0, 300)}` };
      }
      const json = (await res.json()) as { url?: string; path?: string; error?: string };
      if (json.error) return { content: `Render failed: ${json.error}` };
      const out = json.url || json.path;
      return { content: out ? `Rendered MP4: ${out}` : 'Render completed but the worker returned no output URL.' };
    } catch (err) {
      return { content: `Video render failed: ${(err as Error)?.message || 'unknown error'}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};

export const VIDEO_TOOLS: ChatTool[] = [renderVideo];
export const VIDEO_TOOL_NAMES = VIDEO_TOOLS.map((t) => t.name);
