# @dreamstream/monitor-core

The baby monitor's shared contracts ([ADR 0006](../../docs/decisions/0006-native-apps-watch-local-first-security.md) D2).
One TypeScript core for the web app, the live Worker and, from Phase 1, the Expo apps;
golden fixtures hold the Swift (watchOS, iOS extensions) and Kotlin (Wear OS) code to the
same bytes.

| File | What it is |
|---|---|
| `src/glance.ts` | Glance v1: types, `glanceFacts` (what a room knows — each camera's status, `since`, minute LAeq — → nursery-wide facts), `composeGlance` (facts → one device's glance, ≤ 512 B), the `can` bitmask, ETag / 304, `parseGlance` |
| `src/glanceBump.ts` | `nextBump`: when the sequence `q` bumps (mood, sleep, dB band, alerts, duty, soothing, talk, camera, battery), dating moods it saw begin and moving the dB band only on measurements; `replayObservations` |
| `src/sealed.ts` | The Nursery Media Key: device keys and `devId`, NMK wraps, relay frame seal/open with replay and age checks, sealed signaling, the `dev_hello` signature, the LAN name |
| `src/eid.ts` | Event ids (`<dev>:<seq>`), a minter that never repeats, first-arrival dedupe |
| `src/wire.ts` | The protocol v2 delta: `CAPS`, close codes and what to do after each, re-auth / kick / act / members contracts and validators, key and signaling messages, the push envelope |
| `src/bytes.ts` | UTF-8, base64url, hex, big-endian integers — no TextEncoder or atob needed |

## Rules

- **Pure.** `tsconfig.json` compiles `src/` against the ECMAScript library only: no DOM, no
  Node, no Workers types, no dependencies. WebCrypto is reached through `sealed.ts`
  (`globalThis.crypto`, or `setCryptoProvider(...)` for a React Native polyfill).
- **Consumed by relative path** until Phase 1 makes it a workspace package:
  `import { composeGlance } from '../../packages/monitor-core/src'` from `live-worker/src/`,
  `'../../packages/monitor-core/src'` from `live/monitor/`. `npm run check:consumers` (in this
  folder) compiles it the way each consumer does.
- **Fixtures are the contract.** Changing one changes what every platform must do — note it
  in ADR 0006. Regenerate with `npx tsx packages/monitor-core/scripts/gen-fixtures.ts` from
  the app root; it is deterministic (a re-run is a no-op).

## Fixtures for the native ports

`fixtures/sealed/keys.json` holds **test keys published on purpose**. Never use them for anything else.

| Fixture | A port must |
|---|---|
| `glance/decode.json` | accept every `valid` JSON (absent and null optionals alike; unknown fields ignored) and reject every `invalid` one |
| `glance/compose.json` | decode each `json` into its `glance` (only TypeScript composes) |
| `glance/night-*.json` | (the Phase 4 hub only) replay to exactly `expect.bumps` — a night with two cameras, as the room hears it |
| `sealed/devid.json` | derive each `devId` from its `sigPub` |
| `sealed/wrap.json` | re-wrap with the given ephemeral key and IV to the exact `blob`; unwrap to `nmk`; fail every `reject` |
| `sealed/frame.json` | seal to the exact `sealed` bytes; open them; fail every `reject` with its reason |
| `sealed/signal.json` | encrypt `plaintext` with the IV to the exact `sealed.ct`; open and check from / to / time; fail every `reject` |
| `sealed/hello.json` | verify each signature (ECDSA is randomised, so verify only); fail every `reject` |
| `sealed/lan.json` | derive each mDNS name |

CryptoKit: `P256.KeyAgreement.PrivateKey(rawRepresentation: d)`, `sharedSecretFromKeyAgreement`
then `hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)`,
`AES.GCM.seal(_, using:, nonce:, authenticating:)`; signatures are `rawRepresentation` (r ‖ s).
Tink / JCA: the same, with an empty HKDF salt; convert ECDSA DER signatures to r ‖ s (P1363).

## Tests

`npx vitest run packages/monitor-core` (from the app root) — every fixture, every bump rule,
a 512-byte fuzz, replay and age windows, sticky E2E, close codes, the act contract, and a
purity test that compiles `src/` against the ECMAScript library alone (it runs in CI).
