/**
 * @dreamstream/platform-core — the platform contract (plan §5): pure TypeScript against ES2017, no DOM, no Node, no
 * dependencies, every relative import ending in `.js`.
 *
 * This barrel is the kernel: the frozen contract types and caps (`src/contract/**`), the schema DSL (`s`, `check`,
 * `toJsonSchema`), the error vocabulary and the three document models (RichDoc, DeckSpec, EmailDoc: their checks, ops
 * and inverses, and the deck overlap rule). Everything else has its own entry point (package.json `exports`):
 * `./models/*` (the same model barrels), `./email`, `./brand`, `./prompts`, `./capabilities`, `./products`,
 * `./tools`, `./gates`, `./cost`, `./audit`, `./flows`, `./wire`, `./client` and `./testing`.
 */
export * from './contract/schema.js';
export * from './contract/richdoc.js';
export * from './contract/deck.js';
export * from './contract/email.js';
export { s, assertSchema, check, formatPath, isSafeHref, toJsonSchema } from './schema/index.js';
export type { ArrayOptions, AssetRefOptions, IdOptions, InferObject, InferTuple, RangeOptions, TextOptions } from './schema/index.js';
export * from './errors.js';
export * from './models/richdoc/index.js';
export * from './models/deck/index.js';
export * from './models/email/index.js';
