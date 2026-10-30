/**
 * `@dreamstream/platform-core/gates`: `decideGate` and its floors, consent (`DraftAction`, `ConsentRecord`,
 * `executeExternalWrite`), the host ports, and the content-free audit events (also here because package.json has no
 * `./audit` entry yet).
 */
export * from './gates.js';
export * from './consent.js';
export * from './ports.js';
export * from '../audit/index.js';
