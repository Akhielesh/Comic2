# Glance v1 — the watch, widget and push contract

**Status:** Frozen for ADR 0006 Phase 0 (changing it needs a note in the ADR).
**Source of truth:** `packages/monitor-core/src/glance.ts` (types, `composeGlance`, `glanceFacts`,
`parseGlance`, `glanceEtag`, `coarseGlance`) and `src/glanceBump.ts` (`nextBump`). Golden
fixtures: `packages/monitor-core/fixtures/glance/*.json`. Decision:
[ADR 0006 D2](../decisions/0006-native-apps-watch-local-first-security.md#d2-shared-core-and-contracts).

One small, complete description of a nursery **right now**, for everything that can't hold a live
monitor open: Apple Watch and Wear OS apps, complications and Tiles, the iPhone Live Activity (and
its Smart Stack view on the watch), push payloads and the `mode:'glance'` socket. It answers "is
the baby OK, and do I need to do anything?" in three seconds, and nothing else.

---

## The shape

Under **512 bytes** as JSON (`GLANCE_MAX_BYTES`); about 480 bytes once encrypted and base64url-encoded
for a push. Every glance is complete: an absent optional field means "none".

```ts
type Mood = 'calm'|'stirring'|'awake'|'noisy'|'fussing'|'crying'|'offline'|'unknown';
interface GlanceV1 {
  v: 1;
  n: string;                    // nursery id
  nm?: string;                  // display name ≤ 24 chars — NEVER in push payloads (cached on device)
  q: number;                    // per-nursery sequence; bumps only on a visible change
  at: number;                   // server ms when composed
  m: Mood; ms: number;          // mood + since (ms)
  sl?: { p: 'idle'|'settling'|'asleep'|'awake'; s: number|null; min: number; w: number };
  db?: number|null;             // LAeq dB(A), integer
  dbb?: 0|1|2|3;                // quiet <40 · normal <55 · loud <70 · very loud
  cam: { on: number; bat?: number|null; chg?: boolean|null; pz?: 'privacy'|'interrupted'|'hidden'|null; ls: number };
  al?: { id: string; k: string; sev: 'urgent'|'warn'|'info'|'care'; at: number; st: 'open'|'acked'|'resolved'; by?: string|null } | null;
  du?: { nm: string; me: boolean; u: number } | null;   // duty; `me` computed per requesting device
  so?: string|null;             // soothing sound playing
  tk?: string|null;             // who is talking into the nursery
  can: number;                  // per device: 1 ack · 2 soothe · 4 listen · 8 talk · 16 peek · 32 duty · 64 log
  src?: 'cloud'|'lan'|'phone';  // added by the delivering client, never by the server
}
```

| Field | Notes |
|---|---|
| `m` | Worst mood across the nursery's online cameras (`MOOD_RANK`). `offline`: no camera answers; `unknown`: no camera yet. |
| `ms` | When the shown mood began, as the bump rules saw it begin — never earlier (with twins, one camera's calmer `since` can't back-date the other's cry). |
| `cam.on` / `ls` | Cameras online now; last message from any camera. A client shows "stale" (`○`) when `at` is older than 90 s with no live link. |
| `cam.bat` | The lowest battery among online cameras. |
| `al` | The one alert that most needs a person (`pickAlert`): unanswered before answered, then the most severe, then the newest; with none active, the last one resolved in the past 30 min (`RESOLVED_SHOWN_MS`). `by` is who answered ("Dad"). |
| `du.me` | Whether this device's person is on duty — composed per device, which is why it is in the ETag. |
| `can` | What this device may do (`CAN`). Parents and caregivers 127; viewers 20 (listen, peek); viewer guests 20; caregiver guests 31 (no duty, no logging). A watch's device grant only ever narrows it, never above a caregiver (`DEVICE_MAX_CAN`). Share-link guests get no watch grant at all. |
| `src` | Set by the client that received it (`cloud`, `lan`, `phone`), for the status dot. The server never sends it. |

**Text limits** (`GLANCE_LIMITS`): `nm` 24, names 20, alert kind 16, ids 20, sound 20 characters.
Too long → the composer shortens the longest free-text field first and never cuts an id; if still
over 512 bytes it drops `tk`, then `so`, then `al.by`.

**Decoders** (Swift `Codable`, `kotlinx.serialization`, `parseGlance` in TypeScript) must:
accept absent and `null` alike; ignore unknown fields; accept text up to 64 characters
(`DECODE_TEXT_MAX` — roomier than the composer, so a later composer doesn't break shipped watches);
and **reject any `v` other than 1**. `fixtures/glance/decode.json` holds every port to it.

## When `q` bumps

`nextBump(prev, facts, now)` is pure; the room, the phone apps and (Phase 4) the nursery hub run the
same function and must produce the same bumps on the fixtures. Target: **≤ 60 bumps a night**.

| Change | Bump |
|---|---|
| Mood rises to fussing or above; camera offline / back / none | At once |
| Any other mood change | After 15 s of stability |
| Sleep phase | At once |
| dB band (`dbb`); the raw dB number alone never bumps | After 30 s sustained, 2 dB hysteresis at each edge |
| Alert opened, answered or resolved; duty; soothing; talk | At once |
| Cameras online count; picture paused / resumed | At once |
| Battery crossing 20 % or 10 %, or first seen under 20 % (3 points of hysteresis going up) | At once |
| Nursery renamed | At once |

- Between bumps the published glance is frozen: one `q` is one content (only `at` differs), so an
  ETag on `q` is honest. A bump publishes every current fact — except a mood still waiting out its
  15 s and an unconfirmed dB band, which stay as shown.
- **Safety first:** nothing delays crying, fussing, an alert or a camera going offline.
- The night fixture (`fixtures/glance/night-2026-10-21.json`: two cries answered by different
  parents, a fuss, stirs, a Wi-Fi blip, an unplugged camera phone, a duty hand-over, a second camera
  from 22:00, fed at the room's real cadence) gives **57** bumps.
- Production: Admin → Costs → Stream Studio → *Glance bumps / night* (once the room counts them,
  ADR 0006 WS-9).

## How a glance travels

| Path | Shape | Who | Status |
|---|---|---|---|
| `GET /api/monitor/:nid/glance` | `Authorization: Bearer <Supabase JWT>` or a device token + `DS-Proof`; `If-None-Match: "<etag>"` → **304**, else 200 `{g}` with `ETag` | Watches without the phone nearby, widgets, the phone app | Endpoint: WS-9 (capability `glance1`) |
| Socket `mode:'glance'` | `{t:'glance', g}` on each bump, nothing else | Wear OS standalone, the phone app while open | WS-9 |
| `POST /api/monitor/:nid/act` | `{a:'ack'\|'resolve'\|'soothe'\|'soothe_stop'\|'duty_on'\|'duty_off', inc?, v?, id}` → `{ok, g, dup?}`; or `Authorization: DS-Act <token>` from a notification | "I'm on it", Soothe, take duty | WS-9; same `id` twice acts once |
| Native push (APNs / FCM) | `PushEnvelope {e, s?, i?, q?}`: `e` = RFC 8291 aes128gcm of `{g, title, body, act?, replace?}` to the device's own keys; `g` composed **without `nm`** | Alerts on locked phones and watches | Router dormant until native tokens exist (WS-3) |
| Web Push | Existing encrypted payload plus `act`, `inc`, `q` | Browsers / PWA | WS-5 service worker; WS-9 sends |
| Live Activity, if its state can't be encrypted | `coarseGlance(g)` = `{m, ms, sl?.p, al?.st}` — no names, no ids | iPhone Lock Screen, watch Smart Stack | Phase 1 |
| WatchConnectivity / Wear Data Layer | The phone forwards the glance it holds | Watch next to its phone | Phase 2 / 3 |

**ETag** = `"<q>.<can>[.d]"` (`glanceEtag`): `q` alone isn't enough, because the same `q` composes
differently for a device whose role changed or that just went on duty. Weak (`W/`) and `*` match too.

`act` needs the same `can` bit the glance shows (`ACT_NEEDS`: ack/resolve → 1, soothe → 2, duty →
32), so a button never lies about what it can do.

## Privacy

- The nursery name never travels in a push (`forPush`): devices cache it from an authenticated read.
- A push's clear fields (`s` severity letter, `i` incident id, `q`) name no one; Apple and Google see
  only that an alert arrived.
- `al.by` and `du.nm` are a member's chosen label ("Dad"), never an email or an account id.
- Nothing in a glance is stored by Apple, Google or a watch maker beyond the notification itself.

## Changing the contract

Frozen for Phase 0. A new optional field is additive (decoders ignore unknown fields); anything
else — a renamed field, a new mood, a different `can` bit, a bigger budget — is **Glance v2**: a new
`v`, a new fixture set, and every port updated before the server sends it. Record the change in
ADR 0006 and in this file.
