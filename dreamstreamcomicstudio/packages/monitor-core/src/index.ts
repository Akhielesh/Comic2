/**
 * @dreamstream/monitor-core — the baby monitor's shared contracts (ADR 0006 D2).
 *
 * Phase 0 seeds new files only: Glance v1 and its bump rules, end-to-end sealing, event ids
 * and the protocol v2 wire types. Phase 1 moves the browser-free monitor files in
 * (protocol, sound brain, tracker science, …) and the live Worker imports them from here,
 * ending the hand-kept mirror at the top of live/monitor/protocol.ts.
 *
 * Rules: pure TypeScript against the ECMAScript library only (tsconfig.json checks it) — no
 * DOM, no Node, no dependencies; WebCrypto through sealed.ts's provider; every contract has
 * golden fixtures that vitest, XCTest and JUnit all run.
 */
export * from './bytes';
export * from './glance';
export * from './glanceBump';
export * from './sealed';
export * from './eid';
export * from './wire';
