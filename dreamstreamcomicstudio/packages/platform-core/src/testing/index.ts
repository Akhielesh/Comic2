/**
 * `@dreamstream/platform-core/testing`: the fake platform (an in-memory `/v1`), fake host ports (a ledger with a
 * "down" switch, identity, audit, approver, clock, a scripted model) and the conformance kit every host runs against
 * its own ports. For tests only; nothing here is wired into a product path.
 */
export * from './fakePlatform.js';
export * from './fakePorts.js';
export * from './conformance.js';
