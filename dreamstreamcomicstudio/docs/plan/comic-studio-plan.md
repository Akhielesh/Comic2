# Comic Studio: working plan

This is the living plan for Comic Studio's current programme of work. It is updated with every release that ships to
production (`Dreamstrream-v1`), so a new session can pick the work up from here. The repository is public: this page
holds no keys, no security details and no one's personal data.

Last updated: 2026-11-20, with the release that brings the new register-interest questions, one progress card and
settled chat options.

## How work ships

1. Each package is built on its own branch from the newest production head, reviewed adversarially (performance,
   storage and cost, reliability, security, maintainability), and fixed.
2. A release branch merges the packages, merges production again, and passes: client and server typechecks, both
   Workers' typechecks, the production build, the licence check, the full test suite, and the layout smoke as CI runs
   it. First-load size ceilings are never raised.
3. The release goes to the development branch `claude/gifted-volta-qdhhor`, a draft pull request is opened, and it is
   merged into production once all five CI checks are green.
4. After a release that touches `server/`, `shared/`, `api-proxy/` or `packages/`, the backend container redeploys.
   About 16 minutes after that deploy finishes, one call to `/api/system/version` confirms the new build is live.
5. SQL files are additive and applied by hand after review, in the order the release notes give.

## Shipped

| Release | What creators got |
| --- | --- |
| #302 | Light, Dark, System and Paper appearance across the app. |
| #303 | Truer live data in Chat, research pictures that are safe to use, groundwork for the platform's own daily comics. |
| #304 | Drawn looks wait for Approve, look pictures at once, big lettering styles, a calmer board, ink icons. |
| #305 | The Director keeps working when you leave a comic; alerts with two chimes; one account menu with Settings. |
| #306 | Register-interest questions a visitor can answer; one compact progress card when several pages draw; chat options that settle once answered and stay settled after a reload. |
| #307 | Sign-up opens with a verified email or Google, with referrals (rewards "coming soon"); the Director's whole-book drawing approval and reader; standalone reference images; text and voice chat; branded account mail; your own provider usage on the dashboard and a balance view for operators; artwork backups. |
| #308 | After a provider refuses for quota, drawing moves on to the next usable key or provider; older image drafts are kept; provider setup in place; approved translations keep running; ready for many creators at once. |
| #309 | Story continuity across long books; visual corrections carried through a whole book; discovery and release tools. |
| #310, #311 | Classic Review compares saved panel artwork; creators can dismiss and restore visual findings; new and older Director artwork is stored privately in the project. |
| #312 to #315, #317, #318 | DreamStream Studio Originals in the public library, each edition published through its own PG review. |
| #316 | Tactile page turns in the current and the historical readers. |

## Building now (release "stages, My comics, panel, money")

| Package | What the person sees |
| --- | --- |
| SH-A | Every comic knows its stage: Story, Plan, Style, Draw, Publish, shown as a stage strip and a status line. |
| SH-B | My comics, rebuilt: calmer, clearer cards, the stage of each comic, the next step one tap away. |
| SH-C1 | One side panel everywhere that shows where you are, your comics and their status. |
| SH-C2 | Inside a comic: a tree of its parts, a breadcrumb, and a stage map. |
| MA (MN-1, 2, 3, 9) | A run stops at once when a key runs out; a check before spending with a "not enough" card; the real balance of your own OpenRouter key in the studio header and in Settings (people on DreamStream's allowance see a percent, never dollars). |
| MB (MN-4, 5) | One price on every image surface, corrected with what drawing really costs (pages were costing about 1.3x the listed price on one model and about 2x on another), and planning, translation and checks priced from what is really paid. |

## Next

**Wave 2: the agent and Approve**
- AG-ASK: questions from the agent look designed and readable, with clear structure and type.
- AG-TALK: the agent can just talk (replies up to about 220 words) and refuses less.
- AG-STOPS: far fewer stops. A new comic has one Approve before planning ("Plan and draw" or "Plan only first"), then
  no further stop unless the plan grows. Small paid steps asked for directly start at once and say their cost; the
  balance check still stops them.
- AG-APPROVE, MN-6, MN-7, MN-8: one Approve card per request with the price once and what you have left; an old
  approval is closed when a new request replaces it; the Director says the cost before it spends.

**Wave 3**
- Pages: the Director picks each page's shape from its beats (a splash, one to seven panels, wide, tall or inset),
  and no two pages in a row look the same; a "Your book" plan card with a shape picker; a better board.
- Components that chain: each page card's footer always shows the next step; balloon and panel actions one tap away;
  a calmer editor.
- Models: clearer model choice in Settings and a smaller picker in Chat; new comics start on Nano Banana 2.1.
- Motion: real covers loaded when needed, a hero that plays once with Replay, muted clips with Pause, one pricing
  strip, more hover and info tips.
- Thinking: one live line while working, then two or three sentences of what was done and why, with detail on tap.
- Rate a reply: thumbs up or down on agent replies, with text shared only when the person ticks the box.
- Typing help: fixes after a pause, "fixed N words · Undo", free and with no AI call; on by default on desktop.
- Comic Studio alerts (a reply, a question, a plan waiting, a drawing run that finished), live status in the panel,
  re-attaching to a running turn after a reload, and the free whole-comic review with its own screen.

## Known follow-ups

- After a model switch with "redraw everything", or an automatic retry, the later drawing run can close a question the
  Director asked meanwhile. The run should carry the time the switch or retry was confirmed.
- The "drawn" alert while you are away can count a withheld or reused picture as drawn; it should use the same rule
  as the progress card.

## Rules every release keeps

- Sign-up is open with a verified email or Google (since #307). Auth and account rules change only in a release that
  is about them.
- Shared and public links are read-only (readers may download). Public pages show only published comics within PG-13.
- People on DreamStream's allowance never see dollars or cents. No colour sits on or beside a price or a control that
  spends. Paid steps wait for Approve, except small steps a person asks for directly, which say their cost.
- The backend container must be able to sleep: nothing calls `/api` on a timer.
- No groundwork-only work: every package is visible or used on the day it ships.
- Secrets never go in the repository, logs or the browser; people's data never goes in the repository, tests or docs.
