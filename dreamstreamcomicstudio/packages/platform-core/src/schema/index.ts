/**
 * `@dreamstream/platform-core/schema`: the DSL (`s`), the validator (`check`), the JSON Schema projection
 * (`toJsonSchema`) and their contract types.
 */
export * from '../contract/schema.js';
export { s, assertSchema } from './s.js';
export type { ArrayOptions, AssetRefOptions, IdOptions, InferObject, InferTuple, RangeOptions, TextOptions } from './s.js';
export { check, formatPath, isSafeHref } from './check.js';
export { toJsonSchema } from './jsonSchema.js';
