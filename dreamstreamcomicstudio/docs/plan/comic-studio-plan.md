# Comic Studio: working plan

This is the living plan for Comic Studio's current programme of work. It is updated with every release that ships to
production (`Dreamstrream-v1`), so a new session can pick the work up from here. The repository is public: this page
holds no keys, no security details and no one's personal data.

Last updated: 2026-11-27, with the page flip release: the page swings in from the spine again, in every reader and
for past comics.

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
| #320 | This plan brought up to date; a timing-dependent test steadied. |
| #321 | Studio Originals' artwork is protected from the publication cleanup (the database guard is applied). |
| #322 | Every comic knows its stage (Story, Style, Plan, Draw, Publish) with a strip and a status line; My comics rebuilt with calm cards and the next step one tap away; one side panel everywhere; inside a comic, a parts tree, a breadcrumb and a stage map. Optional SQL to apply: `server/sql/comic_docs_listing.sql`. |
| #323 | A drawing run stops at once when a key runs out of credit, with one card that says what to do; a balance check before any paid step; your own key's real balance in the header and Settings (a percent for people on DreamStream's allowance); one price from one price book on every surface; chained runs never close a newer question; thumbs up or down on the Director's replies. Optional SQL to apply: `server/sql/token_ledger_text_ops.sql`. |

## In this release (page flip)

| Package | What the person sees |
| --- | --- |
| fx-reader | The page flip is back as the default in every reader (the board's Read tab, public, shared and embed readers, Studio Originals, full screen, the classic reader for older comics, and the landing sample). Past comics need no change: a comic that never chose a style flips, and one that chose Paper, Slide or Fade keeps it. Readers can pick their own style; Reduce motion turns the page at once; a flip waits for the next picture so no turn is blank; webtoon pages open at the top; both readers count pages to the whole book. |

No SQL in this release.

## Building now

**Handmade books.** A family photographs a child's handmade book. The child's real cover becomes the comic's cover,
cleaned but never redrawn; the handwritten story is read (with the family checking every word), and the comic is drawn
in the child's own style with the child's own words. Private by default; shared copies hide the artist's name. Five
packages: pages from photos at no cost (NB-1), reading the book (NB-2), cast, look and storyboard from the child's art
(NB-3), drawing page 1 first then the rest (NB-4), and private-by-default sharing (NB-5).

**Customization (designed; builds next).** Eight releases, listed under Next, that take Comic Studio from one rigid
layout and a long list of questions to comics made your way: custom page layouts, creation for young makers with almost
no questions, art that follows your own drawings, visual direction beyond text, and publishing as series and
magazine-style editions.

**Fixes.** A sweep of the whole product found and independently confirmed over a hundred problems. The fixes release
covers every serious one: the backend's ability to sleep, stopping a chat really stops its spending, money never shown
to people on DreamStream's allowance, publishing checks on every path, the readers and library, and layouts on every
screen size from small phones to very wide screens.

## Next

The customization programme ships as eight releases, in this order, each one built from production after the one before
it merges. Editions needs only releases 1 to 4, so it may build alongside 5 and 6. The earlier Wave 2 items (the
agent and Approve; the Director sees and finishes; finish and feel) are placed inside these releases.

1. **A Director that talks your way and asks less.** One Approve before planning ("Plan and draw" or "Plan only
   first"), then no further stop unless the plan grows; small paid steps asked for directly start at once and say their
   cost. The Director can simply talk, adapts its voice to the person (a simpler voice for young makers), refuses less,
   and asks at most one real question per reply, designed and readable, with a recommended answer and "You decide".
   One Approve card per request with the price once; work receipts with an Undo for each change.
2. **Make my comic in two taps.** A young maker's comic starts from a sentence or a drawing, picks a 4, 6 or 8 page
   book, and gets a free storyboard read-through before anything is drawn. Read to me: free narration on the device in
   every reader. A premiere when a book is finished, with the next steps. Young makers share with a family link by
   default.
3. **Your drawings lead.** Uploaded drawings are read for their style, and "Exactly like mine" holds the comic to it,
   pausing after page 1 if the style missed. A drawing tray, figures from your drawings, looks from your own earlier
   comics, and Studio Original looks as a starting point.
4. **Originals-grade layouts.** Fixing one panel without redrawing the page. Page designs like the Studio Originals
   (splashes, insets, wide and tall frames), chosen per page so no two pages in a row look the same; a Picture book
   design for young makers. Existing comics keep their layout.
5. **Direct it with pictures.** A Panel sheet to change a panel by pointing at it, sound words and effects by tap or by
   asking, and the Director looks at the art when asked.
6. **Point, sketch and pose.** One motion and haptics grammar, then sketching over a panel and posing figures to guide
   a redraw.
7. **Publishing and editions.** Series and collections, issue and set covers with lettered titles, magazine-style
   editions, a keepsake print edition (handmade books included), and scheduled releases.
8. **Studio reach.** Talking to the Director while it works, picking a running turn back up after a reload or a
   crash, a Director dock in the thumb zone on phones, a first-comic coach, and Chat and Comic Studio as one.

**After the customization releases**

- Pages: a "Your book" plan card with a shape picker for each page, and a better board.
- Components that chain: each page card's footer always shows the next step; balloon and panel actions one tap away;
  a calmer editor.
- Models: clearer model choice in Settings and a smaller picker in Chat; new comics start on Nano Banana 2.1.
- Motion: real covers loaded when needed, a hero that plays once with Replay, muted clips with Pause, one pricing
  strip, more hover and info tips.
- Thinking: one live line while working, then two or three sentences of what was done and why, with detail on tap.
- Typing help: fixes after a pause, "fixed N words · Undo", free and with no AI call; on by default on desktop.
- Comic Studio alerts (a reply, a question, a plan waiting, a drawing run that finished), live status in the panel,
  and the free whole-comic review with its own screen.

## Known follow-ups

- Both earlier follow-ups (chained runs closing questions, and the "drawn" alert) are fixed in the money release.
- Studio Originals drawn before 2026-11-23 and older Director artwork still sit in the public bucket; moving them to
  private storage is an operator step with no tooling yet.
- Referral rewards are announced as "coming soon" and wait on the owner's choice of reward.

## Rules every release keeps

- Sign-up is open with a verified email or Google (since #307). Auth and account rules change only in a release that
  is about them.
- Shared and public links are read-only (readers may download). Public pages show only published comics within PG-13.
- People on DreamStream's allowance never see dollars or cents. No colour sits on or beside a price or a control that
  spends. Paid steps wait for Approve, except small steps a person asks for directly, which say their cost.
- The backend container must be able to sleep: nothing calls `/api` on a timer.
- No groundwork-only work: every package is visible or used on the day it ships.
- Secrets never go in the repository, logs or the browser; people's data never goes in the repository, tests or docs.
