# Video: HTML → MP4 (HyperFrames render worker)

Two ways the studio produces video, onboarded from open-design / [nexu-io/html-video](https://github.com/nexu-io/html-video) (Apache-2.0):

## 1. Record the live preview (shipped, no infra, no egress)
A **Record** button on the live-preview pane uses the browser's `getDisplayMedia` + `MediaRecorder`
to capture the running app to a downloadable `.webm`/`.mp4`. Entirely client-side — nothing leaves the
box. Great for quick demos of any app the studio builds. (`services/studioRecord.ts`.)

## 2. HTML → MP4 render worker (the real HyperFrames pipeline)
For deterministic motion-graphics / promo / explainer MP4s, the agent calls the **`render_video`**
tool, which POSTs HTML to a **self-hosted render worker**. We deliberately do NOT put this in the main
API: it needs **Playwright Chromium + an ffmpeg binary** and is a heavy sandboxing surface. Same
pattern as Nango — a thin tool → a self-hosted service.

### Worker contract
`POST {STUDIO_VIDEO_RENDER_URL}/render`
```jsonc
// request
{ "html": "<!doctype html>…(self-contained, animations autoplay; GSAP allowed)",
  "width": 1920, "height": 1080, "fps": 30, "durationSec": 8 /* optional */ }
// response
{ "url": "https://…/out.mp4" }   // or { "path": "/abs/out.mp4" }  — or { "error": "…" }
```

### How to build the worker (from html-video, Apache-2.0)
A minimal Node service that wraps `@html-video/adapter-hyperframes`:
1. Write the request `html` to a temp `index.html`.
2. Call the adapter `render({ template:{ id, engine:'hyperframes', sourcePath }, config:{ format:'mp4', resolution:{width,height}, fps, durationMode:'auto'|'explicit', outputPath } })` — it launches headless Chromium (`recordVideo`), then ffmpeg encodes WebM→MP4.
3. Return the MP4 URL/path.

**npm:** `playwright@^1.49`, `@html-video/core`, `@html-video/adapter-hyperframes`, `express`.
**system:** Node 20+, **ffmpeg** on PATH (libx264 + aac), Chromium via `npx playwright install --with-deps chromium`.
**gotchas** (from the engine): freeze animations (`animation-play-state: paused`) before navigating; `waitUntil:'domcontentloaded'`; await `fonts.ready` + 2×rAF; play via `window.__hvPlayAll()`; trim lead-in with ffmpeg `-ss`; `-movflags +faststart`, `-pix_fmt yuv420p`; run **unsandboxed** (sandbox-exec hangs headless Chrome).

### Wire it up
```bash
STUDIO_VIDEO_RENDER_URL=http://video-render:8400   # the deployed worker
```
Then `render_video` lights up (and shows "ok" in Settings → System). The agent writes a self-contained
animated HTML (GSAP) and calls the tool; it gets back an MP4. Deck/explainer/promo prompts can now
yield real video. The design-skills set (`ambient-bg`, `kinetic-type`, `canvas-fx`, etc.) gives the
agent the motion vocabulary to author good frames.

> Security: the worker executes AI-authored HTML/JS in headless Chromium — run it isolated
> (its own container/network), with CPU/memory/time limits, no access to internal services, and treat
> its output as untrusted. It's why this is a separate worker, never the main API.
