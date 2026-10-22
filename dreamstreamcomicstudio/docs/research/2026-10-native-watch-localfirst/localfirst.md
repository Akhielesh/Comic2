# Local-first monitor at near-zero cloud cost: study for DreamStream (repo read-only, 2026-10-22)

## 0. Recommendations

1. **The biggest current cost is SQLite rows written, not video.** A MonitorRoom with one camera running writes about **12,000 rows a day**. Most of them come from a 15 s alarm loop that calls `setAlarm` (1 row) and rewrites the whole 7-day `tl` blob every time it fires. The rest are minute rows with two indexes, sleep keys put every minute, and the purge deletes. At $1 per million rows over the 50M included, that is roughly **$315/mo at 1k nurseries and $36k/mo at 100k**. Fix this first. It is all worker code.
2. **TURN is the second cost and the one that scales worst.** Cloudflare gives 1 TB free, then $0.05/GB. Cut it with: audio only when the viewer's screen is hidden, an SD cap on relayed paths, and a self-hosted coturn fleet once usage passes about 5k nurseries.
3. **Requests: alarms are 70% of DO requests.** The 2 s camera status is 80% of the WebSocket messages, even though every viewer at home already gets that status straight from the camera over the WebRTC data channel (`CameraHub.direct`).
4. **Architecture: make the camera phone the "Nursery Hub".** It already runs all detection. In Phase 1 it also takes over alerts, local signaling, history and sleep. The cloud keeps only rendezvous, push, an encrypted backup, the watchdog and accounts. Local-first and private turn out to be the same design: less data in the cloud means less cost and less to leak.
5. **The toggle should have two user-facing choices**, not three: **Automatic** (default) and **Home Wi-Fi only**. "Force internet/relay" goes under Advanced → Troubleshooting as a diagnostic. Nobody should ever have to choose a network.
6. **Expected result**, as $/nursery-month for 1k / 10k / 100k nurseries:
   - Today: $0.44 / $0.50 / $0.51.
   - After the Phase 0 web/worker changes: $0.11 / $0.17 / $0.18.
   - After Phase 1 (native hub): $0.03 / $0.07 / $0.08.
   - With coturn added: about **$0.03 / $0.04 / $0.04**.

---

## 1. What hits Cloudflare today, per active nursery-day

Assumptions: one camera running 12 h/day, 2 parent devices, about 55 socket connects a day (mobile reconnects plus call lines), TURN configured.

| Source | Code | Volume/day | How it is billed |
|---|---|---|---|
| Camera `status` heartbeat every 2 s | `live/views/MonitorCamera.tsx:695-731` → `monitorRoom.ts onStatus:925` | 21,600 msgs | 1,080 DO requests (20:1 ratio). Outgoing fan-out to viewers is free. |
| Watchdog alarm every 15 s while a camera is connected | `ALARM_MS=15_000` (`monitorRoom.ts:292`), `alarm():2275`, re-armed at `:2355` | 2,880 alarms | **2,880 requests (1:1) + 2,880 rows** (`setAlarm` = 1 row) |
| `saveBucket` in **every** alarm, plus on state change | `monitorRoom.ts:2351`, `trackBucket:972` | ~3,240 KV puts | ~3,240 rows. Each put also parses and stringifies a 2,016-entry array (CPU). |
| `stats` once a minute → `mon_minutes` `INSERT OR REPLACE` | `MonitorCamera.tsx:807-813`, `monitorStore.ts:280`; PK (dev,m) + `mon_minutes_m` index (`:114`) | 720 msgs | 36 requests. ~2,160 rows (table + PK autoindex + index). |
| `sleepDev` + `sleepSm` KV puts on every stats message | `monitorRoom.ts:1242,1248` | 1,440 | 1,440 rows |
| Retention deletes on minutes (31 days, steady state) | `monitorStore.ts:375-379` | ~720 rows deleted | ~2,160 rows (deletes are billed as writes, index rows included) |
| Events/incidents (2 indexes each) | `addLog:2022` | ~100 | ~300 rows |
| ICE trickle, acks, queries | `rtc.ts:495,711` | ~800 msgs | ~40 requests |
| Socket connects, each doing a Supabase `monitor_my_role` RPC plus the 150-event `hello` | `onAuth:771`, `admit:827` | ~55 | 55 DO requests + 55 Worker requests + 55 Postgres RPCs |
| VAPID fetch from the singleton `KEY_HOLDER` DO when the in-memory cache is cold | `vapidKeys():497` | per wake | Extra DO request, cross-colo hop, one global hot object |
| Viewer and line pings | `client.ts:144` (25 s), auto-response at `monitorRoom.ts:457` | ~7k | **Free**: auto-responses are not charged and do not add duration ([DO pricing][do-price]) |
| JPEG relay (only when P2P and TURN both fail) | `setRelay` in `MonitorCamera.tsx:977` | 0 most nights | 20:1, about $0.03/nursery-month when used (existing doc) |
| D1 | none in `wrangler.jsonc` | none | — |

**Per nursery-day totals:** about **4,140 DO requests** and about **12,180 rows written**.

**Duration** is about 120 s/day of active time. That holds only if the object stays hibernation-eligible between messages: idle, hibernation-eligible objects are not billed for duration ([DO pricing][do-price]). If anything keeps it non-eligible (pending I/O, a timer, an outbound socket), the worst case is 5,400 GB-s/day, which is **$20k/mo at 10k nurseries**. Measure it rather than assume it. The cost centre (`server/src/services/costCentre.ts:883`) queries only Workers and R2 today. Add `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups` and `durableObjectsStorageGroups` ([DO analytics][do-metrics]).

### Cost model ($/month)

Prices: Workers Paid $5 base. DO requests: 1M included, then $0.15/M. Duration: 400k GB-s included, then $12.50/M GB-s. Rows written: 50M included, then $1/M. Storage: 5 GB-mo included, then $0.20/GB-mo ([DO pricing][do-price], [Workers pricing][w-price]). TURN: 1 TB/mo free, then $0.05/GB egress, ingress free ([TURN FAQ][turn-faq], [Realtime pricing][rt-price]). Supabase Pro: $25 with 100k MAU, then $0.00325/MAU ([Supabase][sb-price]).

TURN assumption: 25% of nurseries have someone watching over cellular about 1 h/day at ≤650 kbps, which averages ≈ 2.25 GB per nursery-month. **This is the least certain input. Measure it.**

| | 1k nurseries | 10k | 100k |
|---|---|---|---|
| **Today:** DO requests / duration / rows written | $19 / $12 / **$315** | $186 / $62 / **$3,604** | $1,863 / $550 / **$36,490** |
| Today: TURN / storage / Supabase | $62 / $0 / $25 | $1,075 / $13 / $25 | $11,200 / $136 / $513 |
| **Today: total** | **$439** | **$4,974** | **$50,822** |
| **Phase 0** (ship-now list, §4) | $112 | $1,724 | $18,387 |
| **Phase 1** (native hub owns history and sleep, §2) | $33 | $704 | $8,135 |
| **Phase 2** (coturn above the CF free tier) | $33 | ~$364 | ~$4,035 |

The model script is at `/tmp/claude-0/-home-user-Comic2/7c7ed324-282b-5f8f-b019-b77832618750/scratchpad/cost.py`.

---

## 2. LAN mode: the camera phone as Nursery Hub

### 2.1 Split of responsibilities

| Hub (camera phone, on-device) | Cloud (only what needs a server) |
|---|---|
| Sound and vision detection (already), **alert engine** (incidents, escalation, duty routing), **local signaling**, live status, minute history, **sleep tracker**, device roster cache, outbox | Accounts and membership, remote rendezvous (DO, mostly hibernated), push fan-out to locked or away phones, dead-camera watchdog, encrypted nightly backup, roster distribution |

- **Extract the alert engine** (the `SOUND`/`HAZARD` tables plus raise/escalate/ack from `monitorRoom.ts`) and `sleepTracker.ts` into pure modules with **golden JSON test vectors**. The worker, the web camera and the Swift/Kotlin hubs all run against the same vectors.
- **The hub mints event IDs** (`<dev>:<seq>`). Every path (data channel, LAN socket, cloud) inserts idempotently (`INSERT … ON CONFLICT DO NOTHING`), and viewers dedupe by `eid`. The fastest path raises the alert and the others are no-ops.
- **Outbox and sync:** the hub keeps an append-only outbox (events, incidents, acks, sessions) and syncs with a `since` cursor whenever the cloud is reachable. This already works this way for minute rows (`stats_ok`); extend it to everything.
- **Phase 1 cost and privacy move:** minute rows stay on the hub and upload **once a night as an end-to-end-encrypted blob to R2**. That is 1 Class A operation a night and about 50 KB, instead of about 2,900 DO rows. Remote history charts decrypt on the client. The DO keeps only incidents, sleep sessions and the morning-report summary.

### 2.2 Native discovery and transport (iOS/Android)

- **Discovery order:** cached last address → Bonjour/NSD `_dsnursery._tcp` → a LAN-address hint the hub publishes to the DO, encrypted with the nursery key. The hint covers mesh or AP-isolated networks that drop multicast.
  - iOS: NWListener/NWBrowser. Requires `NSBonjourServices` and the local network privacy prompt ([TN3179][tn3179]).
  - Android 17: apps targeting it need `ACCESS_LOCAL_NETWORK` (NEARBY_DEVICES group). Request it during pairing with a one-line explanation ([Android LNP][android-lnp]).
- **mDNS TXT reveals nothing.** The instance name is `HMAC(nurseryLanKey,"hub")[0:8]`. No baby name and no nursery ID, which matters in apartments and hotels.
- **Transport:** TLS 1.3 with **mutual authentication pinned to the nursery device roster**.
  - Each device generates a P-256 key in Secure Enclave or StrongBox and registers the public key when it joins (through the DO, authenticated by account).
  - The hub caches the roster and enforces revocation.
  - No unauthenticated endpoint at all. Bind to RFC1918/ULA addresses only and refuse non-private source addresses.
  - Never treat "same Wi-Fi" as trust.
- **Same protocol, two transports.** The LAN socket speaks the existing MonitorRoom JSON protocol (`hello`, `status`, `event`, `rtc`, `ack`…). Clients implement a single `RoomTransport` interface with `LanHub` and `CloudRoom` implementations and merge the two streams. WebRTC signaling over the LAN socket yields host candidates, so media never leaves the house.
- **Alerts on a locked iPhone with the internet down:** use **Local Push Connectivity** (`NEAppPushProvider`). iOS launches the extension when the phone joins the matching home SSID, and it keeps a persistent connection to a local server. Apple calls it a local replacement for APNs. It requires the `app-push-provider` entitlement, which has to be requested from Apple ([Apple docs][lpc]). File that request early.
  - Fallback is UIBackgroundModes audio ("Keep listening").
  - Android uses a foreground service holding the hub socket.
- **Watch** (pointer for the watch team): watchOS forbids low-level networking except for **audio-streaming apps while streaming**, VoIP via CallKit, and a tvOS case ([TN3135][tn3135]).
  - Glances come through the iPhone (WatchConnectivity) or HTTPS.
  - A "listen on watch" mode may connect straight to the hub over the LAN.
  - Always test with the iPhone's Wi-Fi and Bluetooth off.

### 2.3 Browsers: what is possible

- **Already working:** host candidates keep media on the LAN. The `mon` data channel carries status and events, and an established call survives an internet outage (`rtc.ts` header, `docs/features/baby-monitor.md` §"When the internet drops").
- **Not possible:** mDNS discovery, listening sockets, or connecting from an HTTPS page to `ws://192.168…`.
  - Mixed content blocks it.
  - Chrome's Local Network Access prompt now gates fetch to private addresses ([Chrome LNA][lna]).
  - The Plex-style approach (a per-device public certificate for a LAN IP) would need a CA deal. Let's Encrypt's per-domain weekly limit rules it out for 100k hubs ([LE limits][le]).
- **Conclusion:** browsers are **LAN-resilient** (they survive an outage once connected) but not **LAN-native** (they cannot connect from scratch with the internet down). Native apps are LAN-native. Say this honestly in the UI.
- **Browser improvements that can ship now:**
  - Raise alerts from whichever path arrives first, deduped by `eid`.
  - Send ICE restarts and quality changes over the open data channel instead of the DO.
  - Viewers that granted the mic expose real host IPs instead of mDNS-obfuscated ones. That improves LAN pairing on networks that block multicast and avoids "same house but relayed" TURN bytes.

---

## 3. Toggle UX ("never think about networks")

**Settings → Nursery → Connection** (parents only, stored on the hub and mirrored in the DO's `settings`):

- **Automatic (recommended)**: "Uses your home Wi-Fi when you're home and the internet when you're away."
- **Home Wi-Fi only**: "Nothing leaves your home. Watch and get alerts only on this Wi-Fi."
  - The confirm sheet gives the two consequences: phones away from home can't watch or get alerts, and history stays on the camera phone.
  - Before disconnecting, the hub sends one final push: "Monitoring set to Home Wi-Fi only by Mom."
  - Remote devices then show that same sentence, not an error. Guests can't join.
  - With no cloud watchdog in this mode, viewers raise "Camera stopped" locally after about 6 s without data-channel status, which is faster than the cloud watchdog anyway.
- **Advanced → Troubleshooting:** "Force internet path" and "Force relay" (`?relay=1` already exists for calls). These are diagnostics, not modes.

**Automatic behaviour, all silent:**
- LAN and cloud connect in parallel. ICE picks host, then srflx, then relay.
- The hub uploads only summaries while every viewer is on the LAN.
- One status pill: 🏠 Home Wi-Fi / 🌐 Internet / Relay / "Internet down: still monitoring at home."
- One toast when the internet comes back: "Back online, synced 42 min of history."
- No dialogs, no network names.

**Web today:** ship the Automatic behaviour only. The "Home Wi-Fi only" toggle arrives with the native hub, because a browser camera cannot sign viewers in locally.

---

## 4. Cost cuts to ship now (web and worker), ranked

Savings are per nursery-day against the §1 baseline.

| # | Change | Files | Saves |
|---|---|---|---|
| 1 | **Watchdog alarm from 15 s to 60 s.** Liveness = `max(lastStatusAt, state.getWebSocketAutoResponseTimestamp(cameraWs))`; the camera's free 25 s pings feed it. Stale after 75 s. **Remove `saveBucket` from `alarm()`.** Keep `AUTH_TIMEOUT` and incident timers exact. | `monitorRoom.ts:292-293, 2275-2357 (esp. 2351, 2355), 891, 920` | −2,160 requests, **−5,040 rows** |
| 2 | **Drop the `tl` KV blob.** Compute the timeline from `mon_minutes.state` and `sounds.cry` with a GROUP BY over 5-min buckets. Live updates already reach viewers through status. | `monitorRoom.ts:968-1004` (`trackBucket/saveBucket/timeline`) | −360 rows, CPU |
| 3 | **Status only on change, or when someone needs live meters.** Viewers send `{t:'view', dc, vis}` on change. The room computes `live_want` per camera (a visible viewer without an open data channel, or a relay viewer) the same way as `updateRelayWant`. Otherwise the camera sends status on a material change (state, sound, model, paused, awake, talk/call, soothing, 5% battery steps, visit, scene posture, `enc.lim`), with a 60 s keepalive. The data-channel `st` every 2 s stays (free, local). | `MonitorCamera.tsx:695-731`, `MonitorViewer.tsx` (visibility handler ~`:388`), `monitorRoom.ts onStatus:925` + new `onView` | −20,800 msgs ≈ **−1,040 requests**, most of the duration |
| 4 | **Batch `stats` every 5 min**, flushing immediately on hello or reconnect. Write `sleepDev`/`sleepSm` once per batch. | `MonitorCamera.tsx:794-813`, `monitorRoom.ts:1236-1250` | −576 msgs, −1,152 rows |
| 5 | **Minute-row write amplification:** `INSERT … ON CONFLICT(dev,m) DO UPDATE` instead of `INSERT OR REPLACE` (no delete plus insert on resend). Drop `mon_minutes_m` and query all devices via `dev IN (…)` (at most 4 cameras). Later, migrate to `WITHOUT ROWID`. | `monitorStore.ts:109-114, 280, 375-379` | −1,440 rows (another −1,440 with WITHOUT ROWID) |
| 6 | **Hidden viewer → audio only, and relay off.** On `visibilitychange` hidden: send `cmd quality 'audio'` (`replaceTrack(null)`, no renegotiation) and `relay off`; restore on visible. **TURN path cap 650 → 400 kbps, 15 fps.** | `MonitorViewer.tsx:388`, `rtc.ts:110` (`RELAY_CAP`) | **TURN −50–70%**, camera battery and CPU |
| 7 | **Hibernation hygiene.** After #1 and #3 the object really will hibernate, so: keep `beats`/`lastStatus` in the camera socket's `serializeAttachment` (2 KB limit, about 700 B needed); gate `migrate()` behind a schema version (`PRAGMA user_version`); no floating `void` storage promises (`:968`). | `monitorRoom.ts:420-470, 925-970` | Correctness after hibernation; cheaper wake-ups |
| 8 | **VAPID keys as Worker secrets** (`VAPID_PRIVATE_JWK` and a public var), keeping `KEY_HOLDER` only as a migration fallback. Removes a cross-DO request on every cold wake and the global single-DO hot spot (about 64 req/s at 100k). | `monitorRoom.ts:488-507`, `userLine.ts` (shares keys), `wrangler.jsonc` | Latency and requests; removes a scaling bottleneck |
| 9 | **Verify Supabase JWTs locally** with ES256 from `/auth/v1/.well-known/jwks.json`, cached 10–20 min ([signing keys][sb-keys]). Cache `{uid → role, label}` in DO SQLite, invalidated on `members_changed`. Still call the RPC for `admin` mode and re-check every 6 h. | `supabaseAuth.ts`, `monitorRoom.ts onAuth:771` (Supabase dashboard: switch to asymmetric keys) | −55 Postgres RPCs/day, −150–300 ms per reconnect, works when Supabase is slow |
| 10 | **Event IDs minted on the camera** (`eid`) with idempotent insert; viewers dedupe data-channel vs room events and alert on first arrival. | `MonitorCamera.tsx sendSound/sendVision:746-790`, `monitorRoom.ts onCamEvent:1007, addLog:2022`, `MonitorViewer.tsx onDirect:636` | Foundation for LAN and outbox; faster alerts at home |
| 11 | **Batch ICE candidates** (50–100 ms windows). | `rtc.ts:495, 711` | −450 msgs, fewer wake-ups |
| 12 | **TURN credentials minted per socket with short TTLs** (guests 2 h, members 6 h, plus an `ice_refresh` message). Today one isolate-wide credential with a 24 h TTL is shared by every nursery, guests included: a guest can relay arbitrary traffic on our bill, and usage can't be attributed. | `ice.ts:24-62`, `admit:851` | Abuse and cost guard |
| 13 | **R2 lifecycle backstop:** expire `events/` objects after 9 days and abort incomplete multipart uploads after 1 day (`wrangler r2 bucket lifecycle add`). | `wrangler.jsonc` comment + runbook; `eventRoom.ts:476-505` keeps doing the precise purge | Orphan safety |
| 14 | **Cost telemetry:** DO datasets in the cost centre, a per-active-nursery KPI, and the share of viewer minutes on relay paths. | `server/src/services/costCentre.ts:883+` | Turns the model's assumptions into measurements |

**Phase 0 effect, per nursery-day:** requests 4,140 → ~870 (**−79%**), rows 12,180 → ~4,300 (**−65%**), TURN bytes about −60%.

---

## 5. What stays in the cloud, and how to keep it cheap

- **Accounts and membership (Supabase).** Stay on **Pro** in production; Free pauses after a week of inactivity ([Supabase][sb-price]). With #9, Postgres is touched only on membership changes. At 100k nurseries (≈250k MAU) it costs about $513/mo, about $0.005 per nursery. A Workers-native auth migration isn't worth it before roughly 500k MAU.
- **Remote rendezvous.** The DO should hibernate between connects. Native clients should use protocol-level WebSocket pings (`URLSessionWebSocketTask.sendPing`, OkHttp `pingInterval`); those don't interrupt hibernation either ([DO WebSockets][do-ws]). Native apps should **not** hold cloud sockets in the background: use push.
- **Push fan-out.** Send from the DO only on incident open, escalate or resolve, with collapse IDs (cooldowns already exist in `PUSH_COOLDOWN_MS`).
  - FCM is no-cost ([Firebase][fcm]).
  - **APNs requires HTTP/2, and Workers' outbound HTTP/2 to APNs is unverified.** A Workers-specific APNs client exists ([JSR apns2][apns2]). Spike it; if it fails, route iOS through FCM with `apns` overrides.
  - **Make payloads end-to-end encrypted.** The hub encrypts for each device (Web Push RFC 8291 already encrypts per subscription; on iOS a Notification Service Extension decrypts; on Android, FCM data messages). The server then sees only "an urgent push for device Y".
- **Watchdog.** One alarm every 60 s only while a camera is connected and not in Home-only mode. That costs about $0.02/nursery-month. In Phase 1, relax it to 5 min while a LAN viewer is actively listening, since that viewer is a faster watchdog.
- **TURN.**
  - Stay on Cloudflare TURN while under or near the 1 TB free tier.
  - Above about 5k nurseries, add **coturn** on flat-rate hosts as the primary, with Cloudflare as fallback. Hetzner EU includes about 20 TB/box and charges about €1/TB beyond; US includes about 1 TB (third-party figures, verify) ([egresscost][hetz]).
  - Hardening: `use-auth-secret` REST credentials, `denied-peer-ip` for every RFC1918, link-local and metadata range, `no-multicast-peers`, `turns:` on 443.
- **Backup.** One end-to-end-encrypted night file to R2. Keys are generated on a parent's device and wrapped to each roster device key, so the server can never read history.

## 6. Security tie-ins (feed never intercepted or leaked)

- **The LAN is hostile.** Use roster-pinned mutual TLS with no open endpoints (§2.2).
- **Bind DTLS fingerprints to device keys.** Sign the SDP `a=fingerprint` with the device key and verify it against the roster. Today the DO relays SDP unsigned, so a compromised room could swap fingerprints and MITM the "end-to-end" stream.
- **Encrypt relay frames end to end** (AES-GCM with the nursery media key, in the WebCodecs path). Today the JPEG relay is plaintext in DO memory (`monitorRoom.ts:13-21`).
- **Per-socket TURN credentials** (#12).

## 7. Overall ranked plan

1. **Phase 0 (web/worker, about 1–2 weeks):** §4 items 1→14 in that order. Items 1–5 are pure cost and roughly 1 day each. Items 6–10 are cost plus foundation. Items 11–14 are hygiene.
2. **Phase 1 (with the native apps):**
   - Extract the alert engine and sleep tracker with golden vectors.
   - Device keys and roster.
   - Hub LAN service (Bonjour/NSD + mutual TLS + same protocol).
   - Outbox/cursor sync.
   - Request the iOS Local Push Connectivity entitlement; Android foreground-service hub.
   - The Automatic / Home-only toggle.
   - Hub-owned minutes and sleep with an encrypted nightly R2 blob.
   - End-to-end-encrypted push payloads and signed DTLS fingerprints.
3. **Phase 2 (above about 5k nurseries):** coturn fleet with Cloudflare fallback; revisit the watchdog cadence and Supabase MAU economics.

## Sources

- [Durable Objects pricing][do-price]
- [Workers pricing][w-price]
- [DO lifecycle][do-life] (hibernates after 10 s idle; non-hibernatable objects evicted after 70–140 s)
- [DO WebSockets best practices][do-ws]
- [DO metrics/analytics][do-metrics]
- [TURN FAQ][turn-faq]
- [Realtime pricing][rt-price]
- [Supabase pricing][sb-price]
- [Supabase JWT signing keys][sb-keys]
- [Apple TN3179 local network privacy][tn3179]
- [Apple TN3135 low-level networking on watchOS][tn3135]
- [Apple Local Push Connectivity][lpc]
- [Android local network permission][android-lnp]
- [Chrome Local Network Access][lna]
- [Let's Encrypt rate limits][le]
- [Firebase pricing][fcm]
- [JSR cloudflare-apns2][apns2]
- [Hetzner traffic (third-party)][hetz]

[do-price]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[w-price]: https://developers.cloudflare.com/workers/platform/pricing/
[do-life]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[do-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-metrics]: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
[turn-faq]: https://developers.cloudflare.com/realtime/turn/faq/
[rt-price]: https://developers.cloudflare.com/realtime/pricing/
[sb-price]: https://supabase.com/pricing
[sb-keys]: https://supabase.com/docs/guides/auth/signing-keys
[tn3179]: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
[tn3135]: https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos
[lpc]: https://developer.apple.com/documentation/networkextension/local-push-connectivity
[android-lnp]: https://developer.android.com/privacy-and-security/local-network-permission
[lna]: https://developer.chrome.com/blog/local-network-access
[le]: https://letsencrypt.org/docs/rate-limits/
[fcm]: https://firebase.google.com/pricing
[apns2]: https://jsr.io/@fivesheepco/cloudflare-apns2
[hetz]: https://egresscost.com/hetzner