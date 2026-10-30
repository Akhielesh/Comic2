/**
 * What the three document models share (plan §5.2): the inline-content schemas (runs, list items, table rows), the op
 * envelope's fields, and the op engine every `apply*Ops` runs on.
 *
 * The op rules (contract/schema.ts `OpBase`), enforced here once for every model:
 * - Pure, immutable and never throws. No clock, no randomness, no I/O: ids and revisions travel inside the ops. The
 *   input is never written to; unchanged parts of the result share references with it, and a call that applies
 *   nothing returns the input document itself.
 * - Every op is checked against its schema (and the model's refinements) first: a malformed op is listed in
 *   `rejected` as `invalid` and changes nothing. The applied op is the checked COPY, so a caller who later edits its
 *   own op object can never reach into the document.
 * - An op applies only while `op.baseRev === (doc.rev ?? 0)` at the start of the call (else `stale`); a call that
 *   applies at least one op bumps `rev` by 1, so a replayed batch is refused as `stale`.
 * - Each op id applies at most once: a second op with the same id in one call, or an id the host lists in
 *   `seenOpIds` (its op log), is refused as `duplicate`.
 * - Every applied op has an exact inverse (`invert*Ops`), computed against the document it was applied to; an
 *   inverse is itself a valid op (it passes the same check), or there is none (null).
 * - "Never throws" is total: an op, a document or an options object whose getters or Proxy traps throw is refused
 *   (`invalid`), never thrown through.
 */
import type {
  CheckError,
  CheckOptions,
  CheckResult,
  OpBase,
  OpId,
  OpRejectCode,
  OpRejection,
  OpResult,
  Schema,
} from '../contract/schema.js';
import { HEX_COLOR_PATTERN, ID_PATTERN, MODEL_LIMITS } from '../contract/schema.js';
import { check, formatPath } from '../schema/check.js';
import { s } from '../schema/s.js';

// ── Inline content ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every op / block / section / slide / element id. */
export const idSchema = s.id();

/** `HexColor`: `#RRGGBB`. */
export const hexColorSchema = s.text({ max: 7, pattern: HEX_COLOR_PATTERN });

/** A slide fraction, 0–1. */
export const unitSchema = s.number({ min: 0, max: 1 });

/** `Run`: text, marks and an `https:` / `mailto:` link. */
export const runSchema = s.object({
  text: s.text({ max: MODEL_LIMITS.runText }),
  marks: s.optional(s.array(s.enum(['b', 'i', 'u', 'code']), { max: MODEL_LIMITS.marks })),
  link: s.optional(s.object({ href: s.link() })),
});

/** At most `max` runs. */
export const runsOf = (max: number) => s.array(runSchema, { max });

/** At most `items` list items of at most `runs` runs each. */
export const listItemsOf = (items: number, runs: number) =>
  s.array(s.object({ runs: runsOf(runs), indent: s.optional(s.int({ min: 0, max: MODEL_LIMITS.listIndentMax })) }), { max: items });

/** At most `rows` rows of at most `cols` cells of at most `runs` runs each. */
export const tableRowsOf = (rows: number, cols: number, runs: number) =>
  s.array(s.object({ cells: s.array(s.object({ runs: runsOf(runs) }), { max: cols }) }), { max: rows });

/** `OpBase`: the op's own id and the revision it was made against. */
export const opBaseFields = { id: idSchema, baseRev: s.int({ min: 0 }) };

/** An insert position (absent appends). */
export const insertIndexSchema = s.optional(s.int({ min: 0 }));

// ── Small pure helpers ─────────────────────────────────────────────────────────────────────────────────────────

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ID = new RegExp(ID_PATTERN);

/** The document's revision: absent (or not a whole number ≥ 0) means 0. */
export const revOf = (doc: unknown): number => {
  const rev = isRecord(doc) ? doc.rev : undefined;
  return typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0 ? rev : 0;
};

/** A copy of `list` with `item` at `index`. */
export const insertAt = <T>(list: readonly T[], index: number, item: T): T[] => {
  const out = list.slice();
  out.splice(index, 0, item);
  return out;
};

/** A copy of `list` without the item at `index`. */
export const removeAt = <T>(list: readonly T[], index: number): T[] => {
  const out = list.slice();
  out.splice(index, 1);
  return out;
};

/** A copy of `list` with `item` in place of the one at `index`. */
export const replaceAt = <T>(list: readonly T[], index: number, item: T): T[] => {
  const out = list.slice();
  out[index] = item;
  return out;
};

/** The position of the first item whose `id` is `id`, or -1. */
export const indexById = (list: readonly { id: string }[], id: string): number => {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return i;
  return -1;
};

/** The first id that occurs twice in `ids`, or null. */
export const firstRepeat = (ids: readonly string[]): string | null => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
};

// ── Refinements (rules the DSL cannot say: sums, cross-field agreement, aggregates) ───────────────────────────

/** Where a refinement found a problem, as path segments (formatted like `check()`'s paths). */
export type RefinePath = (string | number)[];

export const refineError = (path: RefinePath, code: CheckError['code'], message: string): CheckError => ({ path: formatPath(path), code, message });

/**
 * The code a repeated id is refused with. Interim: CHECK_ERROR_CODES has no `duplicate-id` yet (amendment A1, open
 * with the lead); when it lands this one line and the repeated-id cases of fixtures/models/invalid.json change to it.
 */
const REPEATED_ID: CheckError['code'] = 'too-many';

/** One id namespace of a document (its sections, its blocks, a slide's elements…): each id at most once. */
export interface IdScope {
  /** Record the item at `path` (its id is at `path.id`); a repeat is reported at that `id`. */
  add: (id: string, path: RefinePath) => void;
  errors: CheckError[];
}

/** A fresh `IdScope`; `what` names the ids in messages ("block", "slide"…). */
export const idScope = (what: string): IdScope => {
  const first = new Map<string, string>();
  const errors: CheckError[] = [];
  return {
    errors,
    add: (id, path) => {
      const prior = first.get(id);
      if (prior === undefined) first.set(id, formatPath(path) || '(root)');
      else errors.push(refineError(path.concat(['id']), REPEATED_ID, `repeats the ${what} id ${JSON.stringify(id)} of ${prior} (each ${what} id at most once)`));
    },
  };
};

/**
 * Every run's `marks` inside `value` (a checked copy, found at `path`) that names a mark twice, refused as `too-many`
 * at that `marks`: each mark at most once (MODEL_LIMITS.marks). `Run` is the only shape with a `marks` field.
 */
export const repeatedMarks = (value: unknown, path: RefinePath): CheckError[] => {
  const errors: CheckError[] = [];
  const at: RefinePath = path.slice();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        at.push(i);
        walk(v[i]);
        at.pop();
      }
      return;
    }
    if (!isRecord(v)) return;
    for (const key of Object.keys(v)) {
      at.push(key);
      const child = v[key];
      if (key === 'marks' && Array.isArray(child)) {
        const repeat = firstRepeat(child as string[]);
        if (repeat !== null) errors.push(refineError(at, 'too-many', `names the mark ${JSON.stringify(repeat)} more than once (each mark at most once)`));
      } else walk(child);
      at.pop();
    }
  };
  walk(value);
  return errors;
};

/** `check(schema, value)`, then the refinements on the checked copy. */
export const checkRefined = <T>(schema: Schema<T>, value: unknown, refine: (value: T) => CheckError[], options?: CheckOptions): CheckResult<T> => {
  const r = check(schema, value, options);
  if (r.ok === false) return r;
  const errors = refine(r.value as T);
  return errors.length ? { ok: false, errors } : r;
};

/** One line for an op rejection: the first error with its path, and how many more there were. */
export const describeErrors = (errors: readonly CheckError[]): string => {
  const first = errors[0];
  const head = first ? `${first.path || '(op)'}: ${first.message}` : 'is not valid';
  return errors.length > 1 ? `${head} (and ${errors.length - 1} more)` : head;
};

// ── The op engine ──────────────────────────────────────────────────────────────────────────────────────────────

/** The most ops one `apply*Ops` call takes; the rest are refused as `limit`. */
export const MODEL_OPS_MAX = 1000;

export interface ApplyOptions {
  /**
   * Op ids the host already applied (its op log). Such an op is refused as `duplicate`, so a retried op that was
   * re-stamped with a fresh `baseRev` (an accepted suggestion, a resent request) still applies at most once.
   */
  seenOpIds?: readonly OpId[];
}

/** How to stamp an undo batch: the inverse of `applied[index]` gets `id(applied[index], index)` and `baseRev`. */
export interface InverseMeta<O> {
  /** The revision the undo batch is made against: the `rev` of the document AFTER the ops were applied. */
  baseRev: number;
  /** The new op id for the inverse of `op` (the `index`-th applied op). Ids travel in ops; nothing here invents one. */
  id: (op: O, index: number) => OpId;
}

/** One op applied to one document: the next document, or why not. */
export type Step<D> = { ok: true; doc: D } | { ok: false; code: OpRejectCode; message: string };

export const stepOk = <D>(doc: D): Step<D> => ({ ok: true, doc });

export const stepFail = <D>(code: OpRejectCode, message: string): Step<D> => ({ ok: false, code, message });

/** What a model plugs into the engine. */
export interface OpKernel<D, O extends OpBase> {
  /** The document's name in messages: "document", "deck", "email". */
  noun: string;
  /** The op union's schema. */
  schema: Schema<O>;
  /** Refinements on an op that passed `schema` (checked before anything else about the document). */
  refine: (op: O) => CheckError[];
  /** A policy refusal decided before the op's shape (for example: only a person changes recipients). */
  gate?: (raw: Record<string, unknown>) => { code: OpRejectCode; message: string } | null;
  /** Apply one checked op. Never mutates `doc`. */
  step: (doc: D, op: O) => Step<D>;
  /** The exact inverse of `op` as applied to `before`, stamped with `id` and `baseRev`; null when `op` does not apply. */
  invert: (before: D, op: O, id: OpId, baseRev: number) => O | null;
}

/** The op's own id, when it is readable and safe to echo (`ID_PATTERN`). */
const readableId = (raw: unknown): OpId | undefined => {
  const id = isRecord(raw) ? raw.id : undefined;
  return typeof id === 'string' && ID.test(id) ? id : undefined;
};

/** `check(schema)` plus the model's refinements: the op as the engine will apply it, or why not. */
export const checkOp = <D, O extends OpBase>(kernel: OpKernel<D, O>, raw: unknown): CheckResult<O> =>
  checkRefined(kernel.schema, raw, kernel.refine);

/** What a caller-supplied value whose getters or Proxy traps throw is refused with. */
const UNREADABLE = 'could not be read (a getter or a Proxy trap threw)';

/** The engine behind `applyDocOps`, `applyDeckOps` and `applyEmailOps` (see the op rules at the top of this file). */
export const applyOpsWith = <D, O extends OpBase>(
  kernel: OpKernel<D, O>,
  doc: D,
  ops: readonly unknown[],
  options?: ApplyOptions,
): OpResult<D, O> => {
  const applied: O[] = [];
  const rejected: OpRejection[] = [];
  const seen = new Set<string>();
  let count: number;
  let rev: number;
  let docOk: boolean;
  // Everything read from the call's arguments before the first op: the list, the document's revision, the op log.
  try {
    if (!Array.isArray(ops)) {
      rejected.push({ index: 0, code: 'invalid', message: 'ops must be a list' });
      return { doc, applied, rejected };
    }
    count = ops.length;
    rev = revOf(doc);
    docOk = isRecord(doc);
    const log = options && Array.isArray(options.seenOpIds) ? options.seenOpIds : [];
    for (const id of log) if (typeof id === 'string') seen.add(id);
  } catch {
    return { doc, applied, rejected: [{ index: 0, code: 'invalid', message: `the ops, the ${kernel.noun} or the options ${UNREADABLE}` }] };
  }
  /** Op `index` as the engine applies it (a checked copy), or why not. Reads caller data, so it is all in one try. */
  const admit = (index: number): { op: O } | { rejection: OpRejection } => {
    let opId: OpId | undefined;
    const refuse = (code: OpRejectCode, message: string): { rejection: OpRejection } => ({
      rejection: opId === undefined ? { index, code, message } : { index, opId, code, message },
    });
    try {
      const raw: unknown = ops[index];
      opId = readableId(raw);
      if (index >= MODEL_OPS_MAX) return refuse('limit', `one call applies at most ${MODEL_OPS_MAX} ops`);
      if (!docOk) return refuse('invalid', `the ${kernel.noun} is not a ${kernel.noun} object`);
      const denied = kernel.gate && isRecord(raw) ? kernel.gate(raw) : null;
      if (denied) return refuse(denied.code, denied.message);
      const r = checkOp(kernel, raw);
      if (r.ok === false) return refuse('invalid', describeErrors(r.errors));
      return { op: r.value as O };
    } catch {
      return { rejection: { index, code: 'invalid', message: `the op ${UNREADABLE}` } };
    }
  };
  let current = doc;
  for (let index = 0; index < count; index++) {
    const admitted = admit(index);
    if ('rejection' in admitted) {
      rejected.push(admitted.rejection);
      continue;
    }
    // From here on the op is the engine's own checked copy: nothing below reads caller data except `step`.
    const op = admitted.op;
    const refuse = (code: OpRejectCode, message: string): void => {
      rejected.push({ index, opId: op.id, code, message });
    };
    if (seen.has(op.id)) {
      refuse('duplicate', `op ${op.id} was already applied`);
      continue;
    }
    seen.add(op.id);
    if (op.baseRev !== rev) {
      refuse('stale', `the op was made against revision ${op.baseRev}, but the ${kernel.noun} is at revision ${rev}`);
      continue;
    }
    let next: Step<D>;
    try {
      next = kernel.step(current, op);
    } catch {
      next = stepFail('invalid', `the op could not be applied to this ${kernel.noun}`);
    }
    if (next.ok === false) {
      refuse(next.code, next.message);
      continue;
    }
    current = next.doc;
    applied.push(op);
  }
  return { doc: applied.length ? { ...current, rev: rev + 1 } : doc, applied, rejected };
};

/** `inverse` as the engine would apply it (a checked copy), or null when it is not a valid op (an over-long id…). */
const checkedInverse = <D, O extends OpBase>(kernel: OpKernel<D, O>, inverse: O | null): O | null => {
  if (!inverse) return null;
  const r = checkOp(kernel, inverse);
  return r.ok === false ? null : (r.value as O);
};

/**
 * The undo batch for `applied` (the ops one `apply*Ops` call applied to `before`, in order): each op's exact inverse,
 * computed against the document just before that op, newest first, all stamped with `meta.baseRev`. Applying the
 * result to the document after the call gives back `before` (apart from `rev`, which moves forward). Each inverse is
 * checked like any op (checked copies are returned). Null when an op is malformed or does not apply to `before` (it
 * was not applied to this document), or when an inverse is not a valid op (for example `meta.id` gave an id that is
 * not an `OpId`: too long, or not matching `ID_PATTERN`), so an undo batch apply would refuse is never handed out.
 */
export const invertOpsWith = <D, O extends OpBase>(
  kernel: OpKernel<D, O>,
  before: D,
  applied: readonly unknown[],
  meta: InverseMeta<O>,
): O[] | null => {
  const out: O[] = [];
  try {
    if (!Array.isArray(applied) || !isRecord(before) || !isRecord(meta)) return null;
    let current: D = before;
    for (let index = 0; index < applied.length; index++) {
      const r = checkOp(kernel, applied[index]);
      if (r.ok === false) return null;
      const op = r.value as O;
      const inverse = checkedInverse(kernel, kernel.invert(current, op, meta.id(op, index), meta.baseRev));
      const next = kernel.step(current, op);
      if (!inverse || next.ok === false) return null;
      out.push(inverse);
      current = next.doc;
    }
  } catch {
    return null;
  }
  return out.reverse();
};

/**
 * The exact inverse of one op as applied to `before`, or null (malformed, it does not apply to `before`, or the
 * inverse is not a valid op, e.g. `meta.id` is not an `OpId`). A checked copy.
 */
export const invertOpWith = <D, O extends OpBase>(kernel: OpKernel<D, O>, before: D, op: unknown, meta: { id: OpId; baseRev: number }): O | null => {
  try {
    if (!isRecord(before) || !isRecord(meta)) return null;
    const r = checkOp(kernel, op);
    if (r.ok === false) return null;
    const checked = r.value as O;
    return kernel.step(before, checked).ok ? checkedInverse(kernel, kernel.invert(before, checked, meta.id, meta.baseRev)) : null;
  } catch {
    return null;
  }
};

/**
 * `migrate()` for a v1-only model: a v1 value is validated (and copied) by `checkV1`; any other version is refused
 * at `v` with a message a person can act on. Later versions add their upgrade steps here, fixture-tested.
 */
export const migrateV1 = <T>(value: unknown, noun: string, checkV1: (value: unknown) => CheckResult<T>): CheckResult<T> => {
  if (!isRecord(value)) return { ok: false, errors: [{ path: '', code: 'type', message: `must be a ${noun} object` }] };
  if (value.v === undefined) return { ok: false, errors: [{ path: 'v', code: 'required', message: `is required (this build reads ${noun} v1)` }] };
  if (value.v !== 1) {
    const shown = typeof value.v === 'number' && isFinite(value.v) ? `${noun} v${value.v}` : `this ${noun} version`;
    return { ok: false, errors: [{ path: 'v', code: 'literal', message: `${shown} is not supported (this build reads v1)` }] };
  }
  return checkV1(value);
};
