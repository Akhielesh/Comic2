# Comic Studio — live production generation test (2026-06-12)

First end-to-end generation test against **production** after the engine
consolidation + Phase 0 self-healing work. Run through the real production
endpoints (`comic2-production.up.railway.app`) with a dedicated, user-authorized
test account, in the same order the browser client drives them.

## Setup

- **Account:** `akhieleshsrirangam+dreamtest@gmail.com` (id `4dd985b1…`),
  email-confirmed and temporarily set to `pro` tier (to clear the 5/day free
  Nano Banana cap) — both explicitly authorized by the owner.
- **Story:** a 3-scene script (Maya, a Mumbai chef; her grandmother's paneer
  tikka recipe; spice-market vendor Arjun).
- **Budget:** authorized $3 (extendable to $6). **Actual spend: $0.45.**
- **Project:** `873f751d-0a17-4355-81b6-30668c801c96`, saved public.
  Reader: `https://dreamstreamstudio.ai/?view=read&id=873f751d-0a17-4355-81b6-30668c801c96`

## What ran (full pipeline, production)

| Step | Endpoint | Result | Cost |
|---|---|---|---|
| Analyze script | `/api/text/analyze-script` | 3 scenes (auto-routed to a free model) | ~$0 |
| Extract world | `/api/text/extract-world` | 2 characters (Maya, Arjun), 3 items, 2 locations | ~$0 |
| **Phase 0a** style anchor | `/api/image/openrouter` (nano banana) | 1 style board | $0.039 |
| **Phase 0b** char sheets | `/api/image/openrouter` (nano banana) | 2 turnaround sheets (Maya, Arjun) | $0.078 |
| Panel breakdown ×3 | `/api/text/panel-breakdown` | 5 panels planned | ~$0 |
| Panel render ×5 | `/api/image/openrouter` (nano banana) | 5 panels, all rendered | $0.195 |
| Comparison | `/api/image/openrouter` (nano banana **pro**) | 1 panel | $0.138 |

## Findings

### Works well ✓
- **The pipeline produces a complete, coherent comic end-to-end in production.**
  All 5 panels rendered; nothing blocked the run. This is the headline: the old
  "comics won't generate" failure mode is gone.
- **Single-character consistency is strong.** Maya is recognizably the same
  person across scenes 1 and 3 — same braid, same teal blouse + pink saree, same
  face — because the Phase 0b reference sheet was injected into every panel
  prompt. The kitchen set (arched window, sunset skyline, hanging lamp, sleeping
  cat, grandmother's wall portrait) is also consistent across non-adjacent
  panels. This validates the auto-reference approach.
- **Style consistency is excellent** across all panels.
- **Clean images** (no baked-in text/speech bubbles) — correct; the app overlays
  dialogue separately.
- **Cost is tiny:** a full 3-page comic on Nano Banana ≈ **$0.31** (8 images);
  the whole test including comparisons was $0.45. At this rate $3 funds ~9 full
  comics; the $6 ceiling was never approached.

### Needs work ✗
1. **Multi-character scenes bleed identities (top priority).** In scene 2, Arjun
   (scripted as a grey-bearded male vendor in a saffron kurta) rendered as a
   *second Maya-like woman*. When two character reference sheets are fed to one
   panel, the dominant identity wins and the second character loses distinct
   features. The single-character path is solid; the multi-character reference
   compositing is the real gap. Likely fixes: stronger per-character labeling in
   the prompt ("LEFT: Arjun, an older man…; RIGHT: Maya…"), or sheet ordering /
   weighting by who's focal in the panel.
2. **OpenAI image models are not viable through the current path.** Both
   `openai/gpt-5-image` and `openai/gpt-5.4-image-2` exceeded the server's **60 s
   image timeout** (`MODEL_TIMEOUT`) and produced nothing. Nano Banana (~8–13 s)
   and Nano Banana Pro (under 60 s) both succeed. Either raise the image timeout
   for OpenAI specifically or drop OpenAI image from the comic options until it's
   faster. `openai/gpt-image-1` (used in `services/imageModelRanking.ts`) is **not
   a valid OpenRouter id** — the live ids are `openai/gpt-5-image[-mini]` and
   `openai/gpt-5.4-image-2`; that ranking entry should be corrected.

### Model comparison (image)
| Model | Per-image | Latency | Notes |
|---|---|---|---|
| `google/gemini-2.5-flash-image` (Nano Banana) | **$0.039** | ~8–13 s | Default. Great quality + consistency for the price. |
| `google/gemini-3-pro-image-preview` (Nano Banana Pro) | **$0.138** (3.5×) | slower, <60 s | Higher fidelity; worth offering as a pro upgrade, not the default. |
| `openai/gpt-5-image` / `gpt-5.4-image-2` | n/a | **>60 s → timeout** | Not usable until the timeout is raised. |

## Recommended next actions (priority order)
1. Fix multi-character reference compositing (labeled, focal-weighted character
   refs in the panel prompt). This is the one quality gap a reader will notice.
2. Correct the OpenAI image model id in `imageModelRanking.ts` and decide:
   raise the image timeout for slow providers, or hide OpenAI image for comics.
3. Keep Nano Banana as the default; expose Nano Banana Pro as an opt-in
   "higher quality" toggle (cost is 3.5× but still ~$1/comic).
4. Transfer this test comic to the owner's main account if they want it there
   (currently public + in the test account).
