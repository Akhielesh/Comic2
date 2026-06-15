# Changelog

All notable user-facing changes. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Newest first.

## [Unreleased]

### Fixed
- **Reliability pass — builds finish cleaner and nothing silently disappears (2026-06-13):**
  - Panels whose image comes back empty or blocked (the model returned nothing)
    are now flagged as retryable failures instead of vanishing — they no longer
    drop out of the progress count, and a user-canceled run leaves its in-flight
    panels replannable instead of dead.
  - Comic images that fail to load on a transient network/auth hiccup retry once
    before giving up, and a genuine outage is logged instead of leaving a blank
    panel with no explanation.
  - The Build card in the agent stream stays **active** until the run truly
    finishes (it no longer flips to "done" mid-render), and the Export card reads
    **done** once every requested output (comic / book / HTML) is prepared —
    publishing stays optional.
  - The offline HTML export now omits panels that never rendered, so a comic with
    a few failed frames no longer exports broken empty images.
  - Hardened the server idempotency cache with a hard entry cap so a burst of
    large, unique requests can't grow process memory without bound.

### Changed
- **Comic Studio: one engine, three stages, comics that finish (2026-06-12):**
  - The creation flow is now presented as **Story → Cast → Pages** (the same
    nine steps underneath, grouped — existing projects resume unchanged).
  - **Builds self-heal instead of dying:** if no style image is locked, the run
    generates a style anchor automatically; characters (and flagged
    locations/items) without reference art get auto-generated turnaround/concept
    sheets before any panel renders, so character consistency works without
    ever visiting the World step. The old hard stops ("Failed: style lock",
    "Failed: missing reference images") are gone — remaining issues flag
    individual panels for retry instead of blocking the whole comic.
  - **Removed:** the experimental ComicForge pipeline (stubbed, disabled, never
    shipped a working generation path) and the admin Test Lab. Old ComicForge
    projects open in the standard editor. (ADR 0004)

### Fixed
- **The agent notices when a chart/code result came out wrong (2026-06-15):**
  - Some tools silently degrade instead of failing: a chart built from a spec with a
    non-numeric value renders that bar as a flat **0** (and points with a blank label
    just vanish), yet the tool reports success — so the model narrated a confidently-
    wrong chart as correct. Likewise `run_python` returning "ran but printed nothing"
    looked like a normal result. The default chat loop now runs a deterministic
    post-check (the same kind of verifier the research/swarm modes already had) that
    flags these — non-numeric values coerced to 0, dropped points, a no-op code run —
    so the model knows not to trust the result and can re-do it. The check only fires
    on unambiguous degradation (genuine zeros and legitimately-empty results are never
    flagged), and it only adds an advisory note — it never changes your answer.
- **Cleaner source lists — no more duplicate citations (2026-06-15):**
  - A web-grounded answer gathers citations across up to nine tool rounds from ~30
    sources, and the same article routinely came back in slightly different URL forms
    (`http` vs `https`, with/without `www.` or a trailing slash, a `#fragment`, or
    `?utm_*`/`gclid`/`fbclid` tracking junk). Exact-string dedup let every variant
    through, so the numbered "Web sources (N)" panel showed the same article several
    times and an inflated count. Citations are now deduped on a canonical form, so each
    real source appears once. Distinct sources are never merged — load-bearing query
    params (e.g. a YouTube `?v=`) are preserved, and the original link you click is
    untouched.
- **"Build me a chart/app" no longer silently does nothing (2026-06-15):**
  - A tool call's arguments arrive as streamed JSON fragments, and a big payload (a
    whole chart spec, a generated app, a UI layout — all of it rides inside those
    arguments) could be cut off mid-JSON by the output-token budget. The agent loop
    used to swap the unreadable arguments for an empty object and run the tool with no
    input, so the tool returned a plausible "no data" result and the model dead-ended —
    the user saw nothing built, with no explanation. The loop now recovers the common
    salvageable cases (fenced/trailing-comma JSON) via the shared coercion helper, and
    when the arguments are genuinely truncated it tells the model so it re-issues the
    call with complete JSON instead of faking an empty run. One shared chokepoint, so
    every tool (and MCP tool) benefits.
- **Long chats stay smooth while a reply streams (2026-06-15):**
  - Every streamed token re-renders the whole thread, and the message renderer was
    re-parsing **every** prior turn's full Markdown on **every** token — so a 40-turn
    chat re-parsed ~40 documents per token, which is the jank/typing-lag you felt the
    longer a conversation got (made worse by the new live activity trace, which ticks
    the thread on each tool step). The Markdown renderer is now memoized and its
    parser plugins are stabilized, so only the turn whose text is actually growing
    re-parses; settled turns are skipped entirely. No behavior change — purely fewer
    redundant re-parses. (A render-count test locks this in.)
- **A chatty tool can no longer kill a whole answer (tool-output cap, 2026-06-15):**
  - Every tool/MCP result is fed back into the model and re-sent on each subsequent
    tool round. A single verbose result (a long page read, a giant MCP
    `structuredContent` blob, noisy stdout) could overflow the model's context
    window — failing the **entire turn** with a provider 400 — and inflated cost and
    latency on every later round. Tool results are now bounded before re-entering the
    model: built-ins at ~24k chars, third-party MCP tighter at ~12k, with a head+tail
    keep (so both the lead and the totals/closing rows survive) and a marker telling
    the model the middle was elided. Only pathological output is ever touched —
    legitimate results pass through unchanged, and the live activity trace keeps the
    full short summary.

### Added
- **You can watch the agent work — live activity trace in normal chat (2026-06-15):**
  - Tool-grounded answers can take 20–60s before the first word appears while the
    agent searches, reads pages and pulls live data. That window used to be a bare
    spinner. Now the default chat loop streams a live **Agent activity** card that
    fills in step-by-step — "Searching the web → Reading the page → Pulling market
    data → …" — each row flipping from a spinner to a ✓ (or a ✗ with the reason) as
    it settles, with the query and a one-line result under it. The swarm and deep-
    research modes already did this; the everyday loop finally does too.
  - The card is **transient**: once the answer lands it's replaced by the existing
    collapsed "How it answered" panel, so there's no duplication. It's purely
    additive — plain chats that run no tools look exactly as before. It has compact
    and detailed density modes and a live Gallery demo (Settings → Gallery).
- **Finance data works IN PRODUCTION — edge egress relay (2026-06-12):**
  - Direct production probing (newly possible via the public widget-refresh route)
    revealed that Yahoo Finance and Stooq block the backend host's egress IPs —
    the real reason every stock/metals/ticker widget showed nothing on the live
    site while working in development. A new auto-deployed Cloudflare Worker
    (`data-egress`, strict 5-host allowlist) now relays those public market-data
    calls through the edge; the backend retries through it only when a direct
    call fails. Verified live: Apple/NVDA/gold/silver, the ticker tape and the
    debt clock all render on dreamstreamstudio.ai, with production telemetry
    showing Yahoo traffic at zero errors for the first time.
  - Failed widgets now say WHY (per-source upstream reasons reach the tile)
    instead of a generic "No data returned".
- **Finance accuracy + boards you can truly shape (2026-06-12):**
  - **Found and fixed the "everything broke when I added API keys" bug:** the Alpaca
    key silently switched US stock cards to the thin IEX feed (wrong-looking volume,
    bare cards with no name/fundamentals/long-range charts). Yahoo's consolidated
    tape is primary again; Alpaca is now strictly a licensed fallback. A misconfigured
    CoinGecko key likewise can no longer take crypto down — it auto-falls back to the
    keyless API, majors skip the search round-trip, and results cache for a minute.
  - **Dashboards can't be killed by a stale login anymore:** widget refresh, the
    article reader and link previews are now public, rate-limited data endpoints —
    an expired session token used to 401 every tile at once ("nothing works").
  - **Window-style tile resize:** grab ANY edge or corner of any tile — width snaps
    live to grid columns, height is free, double-click resets. Works on every widget
    including video and news.
  - **Pin anything from chat:** cards without live data (quizzes, itineraries,
    documents, model-built charts…) now pin to boards as frozen snapshots — the
    whole component gallery is board-eligible, not just the 22 live widgets.
  - Charts, the market card and the weather station were rebuilt to be fully
    fluid — they fill the card at any size (no more tiny chart in an expanded
    widget) with draw-in and morph animations matching the studio design.
- **Dashboards that actually work — full widget gallery, readable news, real directions (2026-06-12):**
  - **It remembers where you were:** reloading the studio restores your last view and
    your last open dashboard (shareable `?board=` deep links) instead of bouncing to
    defaults.
  - **Every widget is addable now:** the Add-widget panel is the complete catalog —
    markets, crypto, macro, calendars, travel and more, grouped, searchable, with
    one-tap presets (e.g. a Metals & energy tape) — enforced by a coverage test.
  - **News you can read in place:** Google News article links are decoded to the real
    publisher server-side (they were unreadable redirects before), and wide news
    cards become a split-pane reader — headlines on the left, the extracted article
    with a reading-progress bar on the right. Bot-walled sites fall back honestly to
    "open original" at the real outlet; an optional `JINA_API_KEY` makes in-app
    reading much more reliable.
  - **Places search that respects names:** searching a specific spot ("mezeh") finds
    that place — not every restaurant nearby — with honest card titles and no filler.
  - **Real directions:** drive/walk/bike routes with live ETAs, alternatives and an
    animated route draw, Google-Maps-style mode pills, and a transit deep link. Works
    from chat, the widget gallery, and the dashboard AI bar ("directions from home to
    Dulles Airport").
  - **Fixed "broken" finance tiles:** the yield curve no longer races its own timeout
    (parallel + cached Treasury fetch), and starter templates only ship widgets that
    self-populate keyless — plus a new Metals & energy board (gold, silver, copper,
    crude).
  - **Resize everything:** dashboard tiles (including video and news) and the floating
    mini-player are drag-resizable, persisted.
  - **Honest picks:** "Your picks today" only suggests from your real chat/memory
    signal — no more canned filler — and hides when there's nothing relevant.
  - Slimmer top: the Dashboards title bar is gone; boards sit on one scrolling strip
    with a name search when it gets crowded.
- **One account, everywhere — account sync overhaul + memory import (2026-06-11):**
  - **Your API keys now follow your account, not your browser.** The server resolves
    provider keys per request as *this device's key → your account's stored key →
    platform default*, so a key added in any studio on any device works in all of them
    (chat, code, comics). Deleting a key or switching the active one now updates the
    account too.
  - **Settings sync, properly namespaced:** chat/comics model choices, the Code
    Studio's pinned model and knobs, your chat memory and custom agents all sync with
    the account now (they used to silently stay on one device). Account-wide vs
    per-studio settings are kept in separate sections so studios never overwrite each
    other.
  - **Import memories from other AI tools:** Settings → Memory → "Import from another
    AI" absorbs your ChatGPT memory list, Claude preferences, or Gemini saved info
    (paste or upload an export file). Assistant chatter and metadata are stripped,
    facts are distilled into editable memories, and you review before saving.
  - **Security:** the account settings snapshot is now encrypted on the server with a
    server-only secret (the old scheme encrypted in the browser with a key shipped in
    the public bundle). Signing out now also clears all preference state, so the next
    person on a shared device no longer inherits — or uploads — your settings.
  - Full issue register: `docs/audits/2026-06-account-sync-audit.md`.
- **Stream Studio v5 — on-air guests, meeting scenes, hard cost guardrails (2026-06-11):**
  - **Guests on the program:** invite up to 4 guests with one link (People panel → "Invite
    guests on air"). Guests join from any device with cam + mic (+ optional screen share on
    desktop), talk to the host in real time over a host-centric WebRTC mesh signaled through
    the event room, and are mixed live into the program canvas + a new WebAudio program
    mixer — so viewers and recordings get everyone, on the existing near-zero-cost R2 rail.
    Multiple participants can share screens AT THE SAME TIME (every share is its own tile).
  - **Three new meeting scenes** with live layout control: **Grid** (equal tiles, centered last
    row), **Spotlight** (featured tile + right-aligned strip), **Sidebar** (content stage +
    people column), each with name-tag chips, a "featured tile" picker, hotkeys 1–6.
  - **Tab-close guardrail:** closing the studio tab while on air now ENDS the stream
    immediately via a `pagehide` beacon (`POST /api/events/:id/exit`) — viewers see a clean
    end, storage/egress stop, and the event is restartable with the new "Go live again"
    button. Network drops keep the gentler pause → 2-minute auto-end.
  - **Account attach from inside Stream Studio:** a real "Sign in" button (Settings →
    Account) round-trips through the main app (`/?next=/live.html#/settings`) and lands
    back in the studio with sync on — no more "open the main app and find your way back".
  - **Self-view mirror control** (Auto / On / Off) — the program out is never mirrored.
  - **108 reactions** (was 72): 36 new curated emoji, mirrored into the room's allowlist.
  - **Admin → Studios panel:** grant/revoke per-studio standalone access
    (Stream / Comic / Chat) by email, with optional branded invite email (inviter name +
    personal note). The main app now ENFORCES those grants: confined accounts see only
    their products, and stream-only accounts land directly on /live.html.
  - **Per-studio invite emails:** the `studio-invite` template now carries feature cards
    per studio (Stream / Comic / Chat), the right deep link, and the "more studios coming
    soon" tease — and the email worker finally auto-deploys
    (`.github/workflows/deploy-email-worker.yml`) so template changes actually ship.
  - **Mobile fix:** `live.html` now sets `interactive-widget=resizes-content`, keeping the
    chat composer above the phone keyboard (matches the main app).
- **Enterprise Foundations audit + plan + Cloudflare architecture (2026-06-07, docs only):**
  ran a code-level audit of all 10 cross-cutting concerns (session/identity, multi-device
  sync, concurrency, model/source reliability, testing, design system, integrations,
  observability, docs, security) with file references and honest exists/partial/missing
  verdicts → `docs/studio/autopilot/F-ENTERPRISE-FOUNDATIONS.md` (F0–F10 epic backlog, ranked
  by ROI, each with tasks + acceptance + owner action). Verified current Cloudflare
  capabilities (Containers/Workers/Durable Objects/Workflows, 2026-06) and defined the
  enterprise topology — Workers + **Durable Objects** (sessions, real-time sync, per-venture
  isolation, Alarm-driven tick heartbeat) + **Workflows** (durable build pipelines) +
  Containers — in `docs/studio/autopilot/ARCHITECTURE-CLOUDFLARE.md`. Revised sequencing so
  F0 (observability) → F1 (provider reliability) → F2 (distributed correctness) ship before
  the autonomous loop wires real builds. Top audited gaps: no error tracking/metrics/tracing;
  single AI key with no pool/circuit-breaker/cross-provider failover; in-memory limits that
  break across instances; no integration/E2E/contract tests; manual SQL migrations (missing
  `user_devices`); no OpenAPI; no helmet/zod/CI security scans.
- **Autopilot workstream — plan only (2026-06-07):** defined the always-on autonomous
  ventures layer (idea → roadmap → continuous build/test/deploy/iterate, 24/7, with hard
  budgets + human checkpoints, hybrid hosting via managed previews + BYO accounts through
  Nango, and central Stripe billing). New docs under `docs/studio/autopilot/`:
  `00-MASTER-PLAN.md` (vision delta, architecture, security/multi-tenancy, hosting adapters,
  billing, the A0–A9 epic backlog), `OPERATING-MODEL.md` (how Claude builds it continuously +
  safety gates), `STATUS.md` (living tracker). Wired into `docs/studio/00-STATUS.md` and
  `09-ROADMAP.md`. **No code yet** — Epic A0 (budgets/kill-switch/checkpoints/audit) is next,
  flag-gated (`VENTURES_ENABLED` off) + admin-only, on owner go-ahead. Owner decisions locked:
  hybrid hosting, generalize the studio, continuous-with-checkpoints autonomy, extend this repo.
- **Code Studio (Sprint 0):** a dedicated, dark, animated workspace route — a 3-pane shell
  (prompt/build · code · live preview) with a working "Run live". Code apps in AI Chat now
  hand off with a single **"Open in Code Studio"** button. Admin-gated private preview;
  others can still preview an app instantly. Built on a new motion design system
  (`components/studio/kit/`) that respects reduced-motion.
- Model Library: live OpenRouter catalog, **compare up to 5** models, and
  **"Use this model"** (quick confirm) to set your image/text model.
- Universal Assistant runs on a **free** OpenRouter model with an anti-hallucination
  guardrail.
- **Free public comics** — anyone can read any comic without an account (commenting/
  liking still require login).
- **Onboarding readiness checklist** on the dashboard — flags missing account / API key /
  model with one-click fixes; hides when ready.
- Documentation architecture under `docs/` — `README.md` (index), `ARCHITECTURE.md`,
  `decisions/` (ADRs 0001-0003), `features/`, and `SOLUTION_LOG.md`.
- **Settings → API Configuration:** add multiple keys per provider, pick one active
  per provider, and set a per-key monthly limit with usage meters. Generation is
  blocked on a key once it reaches its limit (ADR 0003).
- Header usage pill now shows the **active key's** usage with a hover card (provider,
  spend vs. limit %, and the models in use) — replaces the CT credits pill.
- OpenRouter BYOK: enter your own OpenRouter key in Settings; live image generation
  runs on your key when set.
- Accurate per-comic cost using OpenRouter's real reported cost; "Actual API cost"
  shown in Review/Export.
- OpenRouter generation routes (`/api/text/generate`, `/api/image/openrouter`) and a
  smoke test (`npm run openrouter:smoketest`).

### Changed
- Notifications redesigned to the house style (legible, on-brand) with relative
  timestamps and a clear unread count.

### Removed
- Subscription pricing section from the home page.
- Billing tab from Settings, and the CT credits pill from the header.
  (Billing backend is kept dormant — see ADR 0002.)
- Duplicate notification bell on the dashboard (the global header provides one).
