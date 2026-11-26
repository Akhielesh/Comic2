# Alerts: a chime and a toast when work lands

When a comic turn, a drawing run, a translation, a publish or a chat answer finishes — or the Director, the plan or a
chat card waits on the person — while they are somewhere else, the app plays one short chime, shows one toast and, while
the tab is in the background, puts "(n) " in front of the tab title. Nothing is stored except three preferences in this
browser. No bell, no list, no new header icon: the comic sidebar's dot and Chat's "new answer" dot stay the lasting
markers; alerts are the moment-of signal.

Code: `services/alerts/` (the core), `shared/comic/attention.ts` (what waits on the person in a comic),
`components/comicstudio/alerts/studioTransitions.ts` (Comic Studio's moments), `services/alerts/chatAlerts.ts` (Chat's),
`components/alerts/AlertsHost.tsx` (on for signed-in people), `components/alerts/AlertSettingsCard.tsx` (Settings →
Preferences → Alerts). QA scene: `/qa/comic-qa.html?surface=app&scene=alerts`.

## Where the person is decides what happens

| Where they are when it happens | Toast | Chime | "(n) " on the tab |
|---|---|---|---|
| Looking at it: tab visible, window focused, that comic open (any tab or reader inside it), or that chat open | no | no | no |
| Elsewhere in the app on the same site, tab visible and focused | yes | yes | no |
| Tab visible, window not focused | yes | yes | yes |
| Tab hidden (desktop) | one toast when they come back (one alert, or "3 updates") | yes | yes, cleared on return |
| Tab hidden on a phone | one toast when they come back | usually none (phones freeze hidden pages) | — |

Rules (`services/alerts/rules.ts`, every row unit-tested): the same key never alerts twice (the 200 newest are kept);
"Only when I'm needed" passes needs-you and failure kinds only; alerts within 400 ms share one chime and Needs you wins;
at most one chime every 4 s; at most 10 alerts wait while away (the count says how many came; past ten the oldest Ready
alert goes first, so a question or a failure is never pushed out by later replies and Open still goes to it); a toast
held while the window was unfocused counts as shown only once it reached the screen; two alert toasts within
8 s become the summary; an alert toast waits while someone else's toast is on screen (an app toast, a timeline Undo,
History's restore) and shows when the slot frees, or is dropped after 60 s; an alert toast goes away once the person
opens what it is about. The only timer is the 400 ms chime window, and it exists only while a chime is due. Nothing in
the core makes a network request or wakes the backend.

## The moments

| Kind | When | Chime |
|---|---|---|
| `reply` | A Director turn that only talked has replied | Ready |
| `question` | An open options card (with choices), a conflict card, a publish confirm or a model-outage choice, in any assistant message since the person's last message, while the card is still live (a later turn from the agent settles it; a message from work that was already running does not) | Needs you |
| `credit` | A live `credit` card in the same place as a question: a run stopped on a key with no credit, or a paid step that did not fit (credit-safety.md). "Waiting for a top-up or another key", never a money word | Needs you |
| `plan` | The page plan waits for its OK (draft, pages, a live plan or breakdown card, nothing drawing) | Needs you |
| `approval` | A paid step is held for Approve (an open gate) | Needs you |
| `style` | Looks drawn and waiting to be picked | Needs you |
| `drawn` / `drawn_issues` | Pages, cover or sheets drawn since the stream started (a redraw counts) / some failed or were withheld. A picture counts as drawn by the progress card's own rule (`shared/comic/renderOutcome.ts` `progressState`, with the `since` of the newest renders card that includes it): never a take the content check withheld (it needs a look, like a failure), and never an earlier picture put back (a reuse or a kept take), so a run that drew nothing new says nothing is ready. Not shown yet: it reaches people once the Comic Studio sources below are wired | Ready / Needs you |
| `translated` / `translate_issues` | A stream that translated (a Translate action, an approved translate gate, or a turn that posted a translation card) wrote these languages, each now complete / one incomplete. An edit that only leaves an edition stale is not a translation | Ready / Needs you |
| `published` / `publish_failed` | The chat Publish card moved to done / failed | Ready / Needs you |
| `failed` | A stream ended with a server error (never Stop, BUSY or a lost connection) | Needs you |
| `chat_reply` / `chat_question` / `chat_confirm` / `chat_failed` | A chat answer finished / holds a clarify card / a calendar confirm card / failed | Ready / Needs you |

A turn that replied and started drawing (or publishing) does not alert at the reply; the end of the work does. A settle
gives at most one alert, in this order: failed, a new needs-you, drawn, translated, published, a reply nobody alerted
yet. A needs-you that already waited when the stream started is not new. A stream that ends while Stop winds down is the
person's own Stop and stays silent; a transport failure with no server code (a lost connection) is never alerted, because
the server may still finish the turn. Patch streams (silent saves) are ignored everywhere. The "drawn" rule is tested in
`components/comicstudio/alerts/studioTransitions.test.ts` ("drawn" counts only real drawings: withheld, reused, mixed,
an older run's picture).

## Copy

Every alert is a fixed phrase plus the person's own comic or chat title (folded to one line, clipped at 48 characters
with "…"; "Your comic" / "Your chat" when untitled). No model-written text reaches an alert, so no price, no "$", no
usage share and no credit word can either, for any user (`services/alerts/copy.test.ts` runs every kind through the
price patterns of `tests/config/priceDetect.ts`). The only action is Open, which only navigates. The phrases live in
`services/alerts/copy.ts`; the QA scene shows every one.

## The two chimes

A soft glass marimba, synthesised with Web Audio (no audio file). Each note is a sine plus quiet partials, each with a
linear attack and an exponential decay; all sum into one master gain = volume step × 10^(−14/20) × norm, with a 20 ms
fade to silence at the end.

| | Notes (start s, Hz, gain, attack s, tau s) | Partials (× f, gain, tau scale) | Length | norm |
|---|---|---|---|---|
| Ready (rising fifth) | 0.00 A♭5 830.61, 1.0, 0.006, 0.10 · 0.10 E♭6 1244.51, 0.8, 0.006, 0.11 | 1 1.0 1 · 2 0.16 0.6 · 4 0.08 0.25 | 0.52 s | 0.866369 |
| Needs you (lower rising minor third) | 0.00 C5 523.25, 0.9, 0.012, 0.13 · 0.15 E♭5 622.25, 1.0, 0.012, 0.14 | 1 1.0 1 · 2 0.10 0.6 | 0.60 s | 0.783079 |

Both peak at −14 dBFS at Normal and about −20 dBFS at Soft; no fundamental sits within 15 Hz of Stream Studio's 740,
784 or 1047 Hz or the classic generator's old 987.77 Hz beep (`chimeSpec.test.ts`). Rendered from `chimeSpec.ts` at
48 kHz they match the approved previews to within one 16-bit step in seven samples (the stored norm is rounded).

## Audio lifecycle

No audio context exists before the person presses something, or while the sound is off. While the sound is on, one
capture-phase passive `pointerdown`/`keydown` listener waits for the first press; there the context is created, resumed
inside the gesture and suspended again, and the listener goes away. Where the browser has an audio session (Safari
16.4+) it is "ambient" only while a chime plays, so the chime mixes with music and obeys the iPhone silent switch, and
it goes back to "auto" when the last chime ends: the session is page-wide, and dictation and calls need it free. A
session something else set (a call or a recording's "play-and-record") is never changed. To play, the context is
resumed, the notes scheduled, and it is suspended when the last note ends; if the browser keeps it suspended, the chime
is skipped and the toast and the count still carry the alert. Sign-out closes it. The Settings Play button is itself a
press, so it unlocks too. Reduced motion does not mute the chime. A tab the person muted in the browser stays silent (the
browser does that; the page cannot tell).

## Settings

Settings → Preferences → Alerts: Play a chime (on/off), Volume (Soft · Normal), Alert me for (Everything · Only when
I'm needed), and Play (Ready, then Needs you). Stored per browser in `localStorage` `ds.alerts.v1`
(`{ sound: true, volume: 'normal', level: 'all' }` by default); never synced to the account. A change is counted as
`alert_settings` with the new values only; an Open is counted as `alert_open` with the kind only (no titles, no ids).

## Two sites

The core runs separately on the comics host and on the main site: comic alerts appear where Comic Studio runs, Chat
alerts on the main site, each with its own preferences and audio unlock. Nothing crosses hosts.

## For sources: the bus

`services/alerts/bus.ts` is the one place a source hands its moments to:

- `postAlert(draft)` with an `AlertDraft` (`services/alerts/types.ts`): kind, a key built from message, card, gate or
  picture ids (so a replayed stream dedupes), the target (`{ app: 'comic' | 'chat', id }`) and the person's own title.
- `setLooking(target | null, owner)` when something is open in the source, cleared on unmount; `isLooking(target)`,
  `lookingTarget()` and `onLookingChange(fn)` to read it.
- `onAlertsStop(fn)` runs at sign-out and account switches (a stream held after the person left a comic aborts there).
- `playChimeNow(tier, { gesture?, after?, prefs? })` plays a chime through the person's prefs, or the sound and volume
  given (the Settings card passes its own store's; the classic generator's finish uses this browser's).

Comic Studio feeds `studioTransitions(prev, next, memo, now)` with frames built by `studioFrameOf(projectId, state)`
from each rendered state (mounted) or from each event folded through `studioReducer` (a held stream): both produce the
same alerts. The studio sources themselves (the mounted hook and holding a comic's streams after the person leaves it)
are not wired yet; until they are, no comic moment in the table above (`reply` through `failed`) reaches anyone, and
the "drawn" rule is ready for the day they are.

## Chat

An answer that is saved calls `chatAnswered` (never on Stop, never for a connected-data notice). While the person is not
looking at that chat, `services/chatStreams.ts` marks it unseen (page scope, never persisted) and Chat's list shows an
ink dot in the spinner's place, with "(new answer)" for screen readers, until the chat is opened or looked at again.
Open on a chat alert chooses that chat and goes to Chat; a Chat already on screen switches to it (`ds:chat-open`).

## Classic generator

The classic generator's finish plays the Ready chime through the same prefs (no toast; it no longer makes an audio
context of its own).

## Device checks

| Browser | Chime in another comic | Chime from a hidden tab | Title count | Return toast | Silent switch mutes | Music keeps playing | Dictation after a chime |
|---|---|---|---|---|---|---|---|
| Chrome desktop | not yet checked | not yet checked | not yet checked | not yet checked | — | — | not yet checked |
| Firefox desktop | not yet checked | not yet checked | not yet checked | not yet checked | — | — | not yet checked |
| macOS Safari | not yet checked | not yet checked | not yet checked | not yet checked | — | not yet checked | not yet checked |
| iPhone Safari | not yet checked | expected none | — | not yet checked | not yet checked | not yet checked | not yet checked |
| Android Chrome | not yet checked | not yet checked | — | not yet checked | — | not yet checked | not yet checked |

"Dictation after a chime": play a chime (Settings → Play), then dictate in the studio composer; the microphone must
start and the words arrive (the session is back to "auto" once the chime ends).
