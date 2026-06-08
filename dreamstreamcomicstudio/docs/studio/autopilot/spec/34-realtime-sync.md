# 34 — Real-time & Sync Architecture

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [F-Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (**F4** — real-time & multi-device
> sync; F3 — identity) · [ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md)
> (DO + WebSocket Hibernation) · [Master Plan](../00-MASTER-PLAN.md) (§4 target architecture) ·
> [Cloudflare Topology](./23-cloudflare-topology.md) (§23.2.1 `UserCoordinatorDO`) ·
> [Realtime & Events API](./28-api-realtime-events.md) (the wire contract this section sits on) ·
> [Sessions & Identity](./33-sessions-identity.md) (the session epoch revocation rides).
>
> **What this section owns.** §28 specified the *transport and message contract* (SSE today,
> WebSocket-over-DO target). This section owns the *data-correctness layer above it*: how two
> devices (or two tabs) **converge instead of clobber**, how an offline write survives and lands,
> and what consistency we actually promise. It is the engineering answer to F4's one-line gap —
> *"no real-time at all; sync only on login/debounced; naive last-write-wins clobbers concurrent
> edits"* — graded against the real code, not assumptions.

## 34.1 Scope & the honest stance

Three concerns live here, and only here:

| Concern | The question it answers | Where it is today |
|---|---|---|
| **Convergence** | Two devices edit the same thing — what's the final state, and who loses? | last-write-wins by `updatedAt` (silent clobber) |
| **Liveness** | Device A changed something — when does device B *find out*? | on next login, or never (no realtime) |
| **Durability of writes** | The user edits offline / mid-flap — does the write survive? | no — only reads survive (IndexedDB is read cache) |

Everything below distinguishes **shipped** (✅, file-cited) from **target** (📋, mapped to F4).
We do not pretend the current state is more than it is; we also protect what genuinely works
(encrypted settings sync, the table-optional graceful degradation, the IndexedDB local-first read
path). The migration is **additive and reversible** — the same discipline as §23.7 and §28.

---

## 34.2 Current state — exactly what ships (audited 2026-06)

There are **two independent, unrelated sync mechanisms** in the client today, plus a read-only
local cache. Neither is real-time; both converge only by re-pulling.

### 34.2.1 `cloudSync.ts` — encrypted per-account settings (the good one)

`services/cloudSync.ts` syncs **API keys + model/settings preferences** to the `user_settings`
table. It is the more careful of the two and the pattern to preserve:

- **On login** (`AuthContext.tsx:53` → `syncOnLogin(userId)`): **pull** the cloud snapshot →
  **merge** with local (union of keys deduped by *secret value*, settings/modelKeys spread-merged,
  one-active-key-per-provider invariant enforced) → **apply** locally (with change-listeners
  suspended so it doesn't echo) → **push** the converged snapshot back so every device lands on
  the same union (`cloudSync.ts:128-157`).
- **On any local change** (`AuthContext.tsx:42` → `schedulePush`): a **1.5 s debounced** push of a
  fresh full snapshot (`cloudSync.ts:164-170`).
- **Encryption:** the whole snapshot is AES-GCM encrypted **client-side** (`encryptKey`) before it
  touches `user_settings`; secrets are never stored in plaintext (`cloudSync.ts:111-118`). This is
  a real strength — preserve it.

**Its honest limits:** it is **whole-snapshot, last-writer-wins at the row level**. Two devices
that change *different* settings within the debounce window each push a full snapshot; the second
write wins and silently discards the first device's change (it was never in the second's snapshot).
There is no version check, no field-level merge for settings, no notification to the other device —
the other device only converges on its *next* login.

### 34.2.2 `chatSync.ts` — chat sessions & projects (naive LWW)

`services/chatSync.ts` mirrors **chat sessions and project folders** to a `chat_sync` table:

- **Pull-all** on demand (`pullAll`, `chatSync.ts:26`); **per-row upsert** on change
  (`pushSession`/`pushProject`, `chatSync.ts:62-63`) keyed by `key = "<kind>:<id>"`.
- **Conflict resolution is `updated_at` last-write-wins, full document** (`chatSync.ts:45-60`):
  the row's `data` JSON is replaced wholesale; the stored `updated_at` is the *writer's* clock, and
  whoever upserts last wins. There is **no compare-and-swap, no base version, no merge**.
- **Table-optional + graceful** (`chatSync.ts:12-20`): if `chat_sync` doesn't exist, `available`
  flips false and every call is a safe no-op; the chat keeps working from IndexedDB. Preserve this
  resilience property.

**The clobber, concretely.** Two tabs of the same chat both append a turn. Each persists the
*entire* `ChatSession` document with its own `updatedAt`. The later upsert overwrites the row — the
earlier tab's appended turn is gone, and neither tab is told. This is the F4 "tabs race" gap.

### 34.2.3 IndexedDB — local-first **read** cache, not a write log

`services/chatStorage.ts` keeps chat sessions/projects in an IndexedDB database
(`dreamstream_chat`, v2; `chatStorage.ts:12-15`), isolated from the project cache in `db.ts`. It
makes the app **local-first for reads** — reloads and offline *reading* work without a network.
But it is **not an outbox**: an edit made while offline is written to IndexedDB and *also* fired at
`chatSync`/`cloudSync`; if that network call fails there is **no durable queue and no retry**. The
write is lost on the next pull/login that overwrites the local doc. Reads survive offline; **writes
do not survive a failed sync.**

### 34.2.4 Device registry — present but not authoritative

`services/deviceSessions.ts` upserts a `user_devices` row on login and can list/remove devices —
but `removeDevice` **"does NOT invalidate its Supabase session"** (`deviceSessions.ts:85-88`), and
per the F-series audit `user_devices` **has no migration**. So "sign out this device" deletes a
*row*, not a *session*. Revocation is cosmetic. (F3 makes the registry authoritative; F4 makes
revocation *instant* — §34.6.)

### 34.2.5 What is categorically absent

| Capability | Status today | Grep evidence |
|---|---|---|
| WebSocket / Durable-Object channel | ❌ none | no `new WebSocket` / DO client anywhere |
| Supabase Realtime channels | ❌ none | no `.channel(` / `realtime` client usage |
| Presence | ❌ none | — |
| Cross-tab coordination (BroadcastChannel) | ❌ none | no `BroadcastChannel` in client code |
| Offline write outbox + retry | ❌ none | IndexedDB is read cache only |
| Optimistic concurrency / versioning | ❌ none | LWW by `updatedAt` in both syncers |
| Instant revocation push | ❌ none | `removeDevice` is row-delete only |

> The lone `websocket` string in the client (`server/src/ai/studio/designSystem.ts:292`) is a
> *design-system keyword catalog entry* the studio uses to nudge generated apps — **not** a live
> realtime client. The audit's "zero realtime" verdict is exact.

### 34.2.6 Current-state data flow

```
   Device A                         Supabase                          Device B
 ┌─────────┐                  ┌──────────────────┐               ┌─────────┐
 │ edit ───┼─ schedulePush ──►│ user_settings    │               │         │
 │         │   (1.5s debounce)│  (AES-GCM blob)   │               │         │
 │ IndexedDB│  pushSession ──►│ chat_sync (LWW)  │               │IndexedDB│
 └─────────┘                  └──────────────────┘               └────┬────┘
       ▲                              │                                │
       │  next login: pull+merge      │   ……… B learns NOTHING …………   │
       └──────────────────────────────┘   until B's NEXT login ───────┘
                                          (and the LWW row may have
                                           already clobbered A's edit)
```

The defining property: **change propagates only by a future pull (login)**, and **concurrent
writes silently drop one side**. That is the two-line problem F4 exists to fix.

---

## 34.3 Target architecture (F4) — the four moves

F4 replaces "converge on next login, lose concurrent writes" with "converge in real time, never
lose a write." Four coordinated changes, each independently shippable behind a flag:

| # | Move | Replaces | Owner DO / mechanism |
|---|---|---|---|
| 1 | **Authoritative real-time channel** | "no realtime; converge on login" | `UserCoordinatorDO` over WebSocket Hibernation (§23.2.1, §28.6) |
| 2 | **Optimistic-concurrency versioning** | naive last-write-wins | `version` column + compare-and-swap (§34.4); CRDT path for collaborative text (§34.4.4) |
| 3 | **Cross-tab coordination** | tabs race & double-push | `BroadcastChannel` leader election (§34.5) |
| 4 | **Offline write outbox** | writes lost on failed sync | IndexedDB op-log + retry-on-reconnect (§34.7) |

```
                        ┌──────────────────────────────────────────────────────────┐
   Device A             │             UserCoordinatorDO  (user:<id>)                 │            Device B
   ┌──────────┐   WS    │   • authoritative session/device registry (epoch)         │   WS   ┌──────────┐
   │ tab ─┐   │◄═══════►│   • presence roster (who's online, what view)             │◄══════►│ tab ─┐   │
   │ tab ─┴─leader      │   • instant revocation (close every socket)               │        │ tab ─┴─leader
   │  BroadcastChannel  │   • cross-device UI-state bus (LWW: active venture, theme) │        │  BroadcastChannel
   │  outbox(IndexedDB) │   • doc-change fan-out (versioned ops → §34.4)            │        │  outbox(IndexedDB)
   └────┬─────┘   │     └───────────────────────────┬──────────────────────────────┘        └────┬─────┘
        │ CAS write (version)                        │  durable mirror (epoch, status)             │
        ▼                                            ▼                                             ▼
   ┌──────────────────────── Supabase Postgres (system-of-record, RLS) ───────────────────────────┐
   │  user_settings · chat_sync (now +version) · studio_projects (+version) · venture_*            │
   └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

The DO is authoritative for **liveness**; Postgres stays authoritative for the **record** (§23.2.4)
— the DO never becomes a second source of truth.

---

## 34.4 Sync protocol — ops, versions, conflict rules

The core change is: stop shipping whole documents on a hope, and start shipping **versioned ops the
server can accept or reject**.

### 34.4.1 Optimistic concurrency (the default for documents)

Every syncable record gains a monotonic **`version`** (this aligns with F2's optimistic-concurrency
work on `studio_projects` and the future `ventures`). A write is a **compare-and-swap**: the client
sends *the version it based its edit on*; the server applies the write **only if** the stored
version still matches, bumping it; otherwise it **rejects with the current state** so the client
rebases.

```
WRITE OP (client → server)
{
  "op":        "upsert",                 // upsert | delete | patch
  "entity":    "chat_session",           // chat_session | chat_project | studio_project | settings
  "id":        "sess_018e…",
  "base_version": 41,                    // the version the client edited ON TOP OF
  "op_id":     "01J9…ULID",              // idempotency key (also the outbox row id, §34.7)
  "device_id": "dev_7a2e…",
  "ts":        "2026-06-08T…Z",
  "payload":   { …changed fields… }      // or a field-level patch (§34.4.3)
}

WRITE RESULT (server → client)
  ✓ accepted  → { "op_id", "version": 42 }                      // committed; new version
  ✗ conflict  → { "op_id", "current_version": 43,
                  "current": { …authoritative doc… },
                  "resolution": "rebase" | "merge" | "manual" } // client must reconcile (§34.4.3)
  ✗ rejected  → { "op_id", "error": "forbidden|stale_epoch|…" } // auth/RLS/epoch failure
```

Compared to today: `chatSync.push` upserts blind on `key` with the writer's `updated_at`
(`chatSync.ts:49-58`). The target keeps the same row identity but **gates the upsert on
`base_version`** — a single SQL `UPDATE … WHERE id=? AND version=?` (or RLS-enforced RPC). The
late writer no longer wins by accident; it is told it is stale and reconciles deterministically.

### 34.4.2 Version vectors / cursors (knowing *what to send*)

A device must know which ops it has and which the server has, without re-pulling everything:

- **Per-entity `version`** is the compare-and-swap token (above) — for *write* gating.
- **Per-channel `cursor`** (the monotonic ULID `id` of the last applied change event, exactly as
  §28.8) is the *read* resume point. On reconnect the device sends `since: <cursor>`; the DO replays
  every change-event after it (idempotent by `op_id`), then live-tails. **Push and replay are the
  same data** — the same property §28.8 relies on for `venture_events`, reused here for user docs.
- For the **cross-device UI-state bus** (active venture, draft intake, theme) there is no document
  to version — it is small, ephemeral, and explicitly **last-writer-wins** (§23.2.1, §23.2.4); a
  vector clock would be over-engineering for "which venture is this user looking at."

We deliberately do **not** introduce a full version vector per device for ordinary documents:
single-writer-at-a-time CAS + a replay cursor is sufficient and far simpler. Vectors only earn
their cost under genuine *concurrent multi-writer* editing — which is the CRDT case (§34.4.4).

### 34.4.3 Conflict-resolution rules (deterministic, by entity)

When CAS detects a conflict, resolution is **defined per entity**, never ad-hoc:

| Entity | Strategy | Rule |
|---|---|---|
| **Settings / model prefs** (`user_settings`) | **field-level merge** | Merge changed fields; the *changed* side wins per field; never overwrite a field the local op didn't touch. Upgrades today's whole-snapshot LWW (`cloudSync.ts`) to last-touch-per-field. |
| **API keys** (within settings) | **union, dedupe by secret** | **Keep today's `mergeKeys` logic** (`cloudSync.ts:49-73`) — union, dedupe by secret value, one active key/provider. It is already a correct merge; CAS just makes it conflict-aware instead of login-only. |
| **Chat session** (`chat_sync`) | **append-merge, then rebase** | Turns are append-only: union turns by turn `id` (idempotent), keep the latest variant set per turn; non-turn fields (title, pinned) take last-touch. No turn is ever dropped — directly fixes §34.2.2. |
| **Chat project / folder** | **field LWW** | Small metadata; last-touch wins per field; tolerable. |
| **Studio project files** (`studio_projects`) | **CAS, reject + rebase** | Code must not silent-merge. On conflict the client rebases its diff onto `current`; unresolvable → **manual** (surface a conflict, never auto-clobber). Pairs with F2's versioned, transactional file upsert. |
| **UI-state bus** | **LWW** | Active venture / theme / draft — last write wins, eventually consistent, never used for money/auth. |

The rule of thumb: **append-only data unions, scalar metadata takes last-touch, code/state machines
reject-and-rebase (never silent-merge), ephemeral UI is LWW.** Every entity has a named strategy so
"what happens on conflict" is a lookup, not a surprise.

### 34.4.4 The path to CRDT (collaborative editing later)

CAS + append-merge handles *one writer at a time per document* — the real multi-device case for
chat and settings. **True simultaneous co-editing** of the same text (two people typing in one
field at once) is a different problem, and the explicit F4 note is "path to CRDT for collaborative
editing later." We do not build CRDTs now; we keep the door open:

- The op envelope (§34.4.1) is already op-shaped, not snapshot-shaped — a CRDT just changes
  `payload` from "changed fields" to "CRDT delta" for the entities that opt in.
- The `VentureDO`/`UserCoordinatorDO` fan-out (§28) is the exact substrate a CRDT needs: an
  ordered, authoritative relay with replay-from-cursor.
- When co-editing lands, candidate entities (a shared venture brief, a collaborative goal) switch
  to a CRDT type (e.g. a sequence CRDT for text, an LWW-register map for fields) **behind the same
  op interface**; CAS entities are untouched. Scope is bounded to fields that genuinely need it —
  not a blanket rewrite. This mirrors §23.3's "prefer the simple primitive until the workload truly
  needs the complex one" discipline.

---

## 34.5 Cross-tab coordination (BroadcastChannel)

Today, N tabs of the same app are N independent clients: each runs its own `schedulePush` debounce
and its own `chatSync` upsert, so two tabs **race their own user** (§34.2.2). The fix is
same-origin **BroadcastChannel** leader election — *before* any network sync:

```
 BroadcastChannel("dreamstream-sync")
   ┌─────────────┬─────────────┬─────────────┐
   │   Tab 1     │   Tab 2     │   Tab 3     │
   │  (LEADER)   │  follower   │  follower   │
   └──────┬──────┴──────┬──────┴──────┬──────┘
          │  one WS to UserCoordinatorDO (leader only)
          ▼
   • Leader owns the single WebSocket + the outbox flush + the debounced push.
   • Followers POST their ops to the leader over BroadcastChannel (op envelope §34.4.1).
   • Server change-events the leader receives are re-broadcast to followers in-process
     (no extra sockets, no duplicate pushes).
   • Leader dies/closes → followers elect a new leader (lowest tab-id wins) and it
     reconnects with the persisted cursor (§34.4.2). No window is unmonitored.
```

Properties: **one socket per device** (not per tab) — cheaper and matches the DO's per-device
session model; **no intra-device races** — a single writer serializes the device's ops; **instant
local echo** — a tab's optimistic edit shows in sibling tabs immediately via BroadcastChannel, then
reconciles against the server broadcast. Degrades safely: where `BroadcastChannel` is unavailable,
each tab falls back to being its own (CAS-protected) client — correct, just less efficient.

---

## 34.6 What stays SSE vs what moves to WebSocket

This section inherits §28's two-tier split and states it for the *sync* surfaces specifically.
**The rule (from §28.1): identical message schema over both transports, so the swap is a transport
change, not a rewrite.**

| Surface | Transport | Why | Status |
|---|---|---|---|
| Chat / swarm **token stream** | **SSE** (stays) | One-directional, ends when the answer ends; already shipped (`chat.ts` ↔ `services/sse.ts`). Sync does not touch it. | ✅ keep |
| Studio **build stream** | **SSE** (stays) | One-directional progress until built. | ✅ keep |
| A8 venture **event firehose** (first cut) | **SSE** then **WS** | SSE ships it (§28.5); F4 upgrades to WS for multi-device. | ✅→📋 |
| **Multi-device doc convergence** (settings, chat, projects) | **WebSocket** (new) | Needs client→server ops (`ack`, `subscribe`, presence) SSE structurally cannot do (§28.5.3). | 📋 F4 |
| **Instant revocation** ("sign out everywhere") | **WebSocket** (new) | Server must *push-close* every device socket now, not wait for token expiry. | 📋 F4 |
| **Presence** | **WebSocket** (new) | "You're on 2 devices" / multi-operator — bidirectional, SSE can't (§28.11). | 📋 F4 |

We **do not retire SSE** — it stays where one-directional is sufficient (the token/build streams).
WebSocket is added precisely where bidirectional + multi-device + idle-cheap actually matters — the
same justification as §28.2's hibernation economics.

---

## 34.7 Offline write outbox

The defining gap (§34.2.3): IndexedDB persists *reads*; a write made offline or during a flap is
fired-and-forgotten. F4 turns IndexedDB into a **durable op-log (outbox)**:

```
 user edit
    │
    ▼ optimistic apply to UI + local store (instant, no spinner)
 ┌──────────────────────── IndexedDB outbox (op-log) ────────────────────────┐
 │  op_id (ULID, PK) · entity · id · base_version · payload · state · tries   │
 │  state: pending → inflight → acked  |  conflict  |  failed                 │
 └───────────────────────────────────┬───────────────────────────────────────┘
                                      │ leader tab (§34.5), online
                                      ▼
                        send op (CAS, §34.4.1)  ──►  UserCoordinatorDO / Postgres
                                      │
              ┌───────────────────────┼────────────────────────┐
          ✓ accepted               ✗ conflict                ✗ network
          mark acked,            apply §34.4.3 resolution,   keep pending,
          drop from outbox       enqueue rebased op          exp-backoff retry
                                 (or surface manual)         (1s→30s+jitter, §28.8)
```

Guarantees:
- **No lost write.** An op survives reload, crash, and offline until it is `acked` or explicitly
  resolved. This is the literal F4 acceptance line — *"offline writes sync on reconnect."*
- **Idempotent replay.** `op_id` is the idempotency key end-to-end (outbox row = op id = server
  dedupe key, mirroring §28's `id` dedupe and §23.3.3's Workflow idempotency). Replaying an op the
  server already applied is a no-op.
- **Ordered per entity.** Ops for one `id` flush in order, so `base_version` chains correctly; ops
  for different entities flush in parallel.
- **Retry on reconnect.** On the leader's WS `ready` (§28.6.2) or browser `online`, the outbox
  drains oldest-first with exponential backoff + jitter. The UI shows an honest **`● syncing N`**
  badge — never a silent "saved" lie while writes are queued.

This preserves the shipped strengths: still local-first (`chatStorage.ts` IndexedDB), still
table-optional graceful (`chatSync.ts:12-20` — if the channel/table is absent, the outbox just
holds ops and the app keeps working), now also **write-durable**.

---

## 34.8 Consistency guarantees (what we actually promise)

State the model plainly so callers don't over-trust it (consistent with §23.2.4):

| Property | Guarantee | Scope |
|---|---|---|
| **Within one DO** | Strong, serializable (single-threaded + transactional SQLite, §23.2.4). | One user's coordinator. |
| **Read-your-writes** | Holds — a device's CAS-accepted write is reflected before it sees any newer state. | Per device, per entity. |
| **Monotonic reads** | Holds — cursor only advances; replay is idempotent by `op_id`/`id` (§34.4.2, §28.8). | Per channel. |
| **Multi-device convergence** | **Eventually consistent**, typically sub-second when both devices online; bounded by reconnect/replay when not. | Across a user's devices. |
| **Conflict outcome** | **Deterministic per entity** (§34.4.3) — never a silent clobber; code/state conflicts surface rather than auto-merge. | Per entity. |
| **No-lost-write** | An accepted or queued op is never silently dropped (outbox, §34.7). | Per op. |
| **Revocation** | **Instant push** — `UserCoordinatorDO` closes every socket on epoch bump (§34.6, §33). | Per user. |
| **UI-state bus** (active venture, theme) | LWW, eventually consistent; explicitly *not* used for money/auth/code. | Cross-device UI hint only. |

What we **don't** promise (honest non-goals): cross-entity transactions (none needed — entities are
disjoint, §23.2.4); global total order across all of a user's entities (per-entity order is enough);
and — until the CRDT path lands — conflict-free *simultaneous* co-editing of one text field
(handled by reject-and-rebase, not seamless merge).

---

## 34.9 Failure & reconnect handling

Reconnect/replay reuses §28.8 verbatim — same cursor contract, same backoff — applied to user-scope
channels:

| Failure | Behavior |
|---|---|
| **WS drop / proxy idle-kill** | Leader reconnects with **exp backoff + jitter (1s→30s cap)**; UI shows amber `● reconnecting`; reads keep rendering from IndexedDB (never blank). |
| **Reconnect** | Send `since: <cursor>`; DO replays `id > cursor` (idempotent by `op_id`/`id`), then live-tails. Overlap is harmless. |
| **Missed-past-retention** (gap detected via `seq`, §28.8) | One-shot REST backfill page, then resume live tail. The durable log (Postgres) is the safety net. |
| **Offline** | Outbox accumulates ops (§34.7); on `online`/`ready` it drains oldest-first. |
| **DO cold start (hibernation wake)** | Liveness state (presence, ring buffer) is lossy by design (§23.2.4) and rebuilt from reconnecting sockets + Postgres; **durable facts (epoch, doc versions) are read from Postgres** so the rebuild is correct. |
| **Stale `session_epoch`** (revoked) | Server rejects the op/reconnect (`stale_epoch` / `4401`); client clears local session and re-auths (§33). |
| **Conflict storm** (rapid concurrent edits) | CAS rebase loop is bounded; after K rebases the entity escalates to its resolution strategy (merge or manual) rather than spinning. |
| **Channel/table absent** (flag off, migration not applied) | Graceful no-op — outbox holds ops, app runs from IndexedDB, exactly as `chatSync.ts:12-20` does today. |

Backpressure on the channel itself (coalescing, shed-`info`-only + `lag`/`resume_cursor`,
never-shed `warn`/`error`) is owned by §28.10 and inherited unchanged.

---

## 34.10 ASCII sequence — "two devices edit the same chat, converge, no clobber"

The end-to-end target path: device A edits offline, device B edits the same session online; both
land via CAS; the append-merge rule unions both edits; both devices converge — **the exact scenario
that silently loses a write today (§34.2.2).**

```
 Device A (offline→online)   UserCoordinatorDO (user:<id>)   Postgres(chat_sync,+version)   Device B (online)
        │                            │                              │                            │
   edit turn (optimistic UI)         │                              │                            │
   outbox{op_id:OA, base_version:41} │                              │      edit title (optimistic)│
        │  ……offline, queued……       │                              │  op_id:OB, base_version:41 ├──►
        │                            │◄─────────────────────────────┼─── CAS upsert (B) ─────────┤
        │                            │   UPDATE … WHERE version=41 → ok, version:=42              │
        │                            │── change-event(seq,version42) fan-out ───────────────────►│ B applies v42
        │   ……A comes online……        │                              │                            │
   leader WS connect, since:<cursor> │                              │                            │
        ├───────────────────────────►│ replay id>cursor (B's edit)  │                            │
        │◄── {ready} + change-event(v42: title) ───────────────────┤  A now knows version is 42 │
        │  A rebases OA onto v42 (append-merge: B touched title, A touched a turn → no overlap)   │
        │  outbox OA.base_version := 42                              │                            │
        ├── CAS upsert (A) ─────────►│ UPDATE … WHERE version=42 → ok, version:=43 ──────────────►│ INSERT/UPDATE
        │◄── {accepted, version:43} ─┤── change-event(seq,version43: +turn) fan-out ────────────►│ B applies v43
   A: outbox OA acked, dropped       │                              │                            │
        │                            │                              │                            │
   RESULT: title (B) AND new turn (A) both present on BOTH devices. Zero clobber. ───────────────
```

Key properties the diagram makes concrete: **CAS rejects nothing falsely** (A rebased onto B's
version before committing); **append-merge unions both edits** (§34.4.3) where today's LWW would
keep only the later upsert; the **outbox** carried A's write across the offline window (§34.7); and
the **same change-events are both pushed live and replayable from the cursor** (§34.4.2 / §28.8).

---

## 34.11 Mapping to F4 + relation to §28 / §33 / §23

| Capability | This section | Owner | Status |
|---|---|---|---|
| Authoritative real-time channel (WS over DO) | §34.3, §34.6 | **F4** (`UserCoordinatorDO`, §23.2.1) · wire = §28.6 | 📋 |
| Optimistic-concurrency versioning (CAS) | §34.4.1–.3 | **F4** (+ **F2** `studio_projects`/`ventures` `version`) | 📋 |
| Path to CRDT for collaborative editing | §34.4.4 | **F4** (later) | 📋 future |
| Cross-tab coordination (BroadcastChannel) | §34.5 | **F4** | 📋 |
| Offline write outbox + retry-on-reconnect | §34.7 | **F4** | 📋 |
| Instant revocation push | §34.6, §34.9 | **F3** (epoch, §33) + **F4** (push-close) | 📋 |
| Presence | §34.6 | **F4** (§28.11) | 📋 |
| Encrypted settings sync (preserve) | §34.2.1 | shipped — protect | ✅ |
| Table-optional graceful degradation (preserve) | §34.2.2, §34.7 | shipped — protect | ✅ |
| IndexedDB local-first reads (extend to outbox) | §34.2.3, §34.7 | shipped → extended | ✅→📋 |
| Reconnect/replay/cursor + backpressure | §34.9 | reuses **§28.8 / §28.10** | 📋 |

**The throughline.** §28 is the *pipe* (message envelope + SSE/WS transport + reconnect/replay).
§33 is the *identity* the channel authenticates and revokes (the `session_epoch`). **This section
is the *correctness layer in between*: versioned ops so concurrent writes converge instead of
clobber, a leader-elected single channel per device, and a durable outbox so no write is lost.**
Same Cloudflare substrate as §23 (`UserCoordinatorDO` + WS Hibernation), same anti-lock-in stance
(Supabase stays the system-of-record; the DO is the live mirror), same migration discipline
(additive, flag-guarded, reversible) — turning F4's audited two-line gap into a real-time,
no-lost-write, multi-device convergence guarantee.

## 34.12 Acceptance criteria

- The current state is described **honestly and file-cited**: `cloudSync.ts` (encrypted login-pull/
  merge/push + 1.5s debounce), `chatSync.ts` (full-document LWW by `updated_at`), `chatStorage.ts`
  (IndexedDB read cache), `deviceSessions.ts` (non-authoritative registry) — and the categorical
  absence of realtime/WS/presence/outbox/versioning is stated as audited fact.
- Every syncable document carries a **`version`**; writes are **compare-and-swap** keyed on
  `base_version`; a stale write is **rejected with current state**, never silently clobbered.
- **Conflict resolution is deterministic and named per entity** (§34.4.3): append-merge for chat,
  field-merge/union for settings/keys, reject-and-rebase for code/state, LWW for ephemeral UI; a
  clear **path to CRDT** exists for future collaborative editing without changing the op interface.
- **Cross-tab coordination** elects one leader per device that owns the single WebSocket, the
  outbox, and the debounced push — eliminating same-device tab races.
- An **offline write outbox** (IndexedDB op-log) guarantees no accepted/queued write is lost; it
  retries on reconnect with idempotent `op_id` replay and exponential backoff.
- The **SSE-vs-WS** boundary is explicit: token/build streams stay SSE; multi-device convergence,
  revocation, and presence move to WebSocket-over-DO with the **identical §28 message schema**.
- **Consistency guarantees** and **non-goals** are stated plainly; **failure/reconnect** reuses the
  §28.8 cursor/replay/backoff contract and the §28.10 backpressure rules; **instant revocation**
  closes every device socket on epoch bump.
- Everything maps back to **F4** (and F2/F3) and relates to **§28** (transport), **§33** (identity),
  and **§23** (DO substrate); shipped strengths (encryption, graceful degradation, local-first) are
  explicitly preserved.
