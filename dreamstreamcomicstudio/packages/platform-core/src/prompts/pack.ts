/**
 * Prompt packs (plan §4.5, §7): versioned by name (`emailDraft.v1`), pure data plus pure builders. A host's
 * `LlmPort.complete({promptPack, input, schema, maxTokens})` sends `system` and `user`; the platform never calls a
 * model itself.
 *
 * - `system` is STATIC: it never contains input, so a host can cache it as a prompt prefix.
 * - Everything from the input goes in `user`, inside tags, with `&`, `<`, `>` (and `"` in attributes) written as
 *   entities: untrusted text (a mail thread, a pasted document) can never close its tag or open a new one, so it is
 *   always data, never instructions (spotlighting).
 * - The input is checked against the pack's schema before any text is built; output is checked by the host
 *   (`check()` against the model's schema) with one repair turn built by `repairMessage`.
 */
import type { CheckError, ObjectSchema } from '../contract/schema.js';
import { check } from '../schema/check.js';

export interface PromptPack<I = unknown> {
  /** `emailDraft` */
  id: string;
  version: number;
  /** `<id>.v<version>`: how hosts, audits and caches name it. */
  name: string;
  description: string;
  /** What the host must pass; checked before anything is built. */
  input: ObjectSchema<I>;
  /** Static and cacheable: no input-dependent text. */
  system: string;
  /** The output budget the pack needs (EmailDoc JSON is truncated at the 500 some hosts default to). */
  maxTokens: number;
  /** Checks the schema cannot express (aggregate caps); `[]` when the input is fine. */
  validate?: (input: I) => CheckError[];
  /** The user message for checked input. */
  user: (input: I) => string;
}

export interface BuiltPrompt {
  pack: string;
  system: string;
  user: string;
  maxTokens: number;
}

export type BuildPromptResult = { ok: true; prompt: BuiltPrompt; errors?: undefined } | { ok: false; errors: CheckError[]; prompt?: undefined };

/** Check the input, then build the messages. Never throws on bad input. */
export const buildPrompt = <I>(pack: PromptPack<I>, input: unknown): BuildPromptResult => {
  const r = check(pack.input, input);
  if (r.ok === false) return { ok: false, errors: r.errors };
  const value = r.value as I;
  const extra = pack.validate ? pack.validate(value) : [];
  if (extra.length) return { ok: false, errors: extra };
  return { ok: true, prompt: { pack: pack.name, system: pack.system, user: pack.user(value), maxTokens: pack.maxTokens } };
};

/** Text as data inside a tag: `&`, `<` and `>` become entities, so it cannot close or open a tag. */
export const asData = (text: string): string => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An attribute value: also `"`. */
export const asAttr = (text: string): string => asData(text).replace(/"/g, '&quot;');

/** `<tag a="x">\n…data…\n</tag>`; attributes with an undefined value are left out. */
export const dataBlock = (tag: string, attrs: { [name: string]: string | number | undefined }, body: string): string => {
  const a = Object.keys(attrs)
    .filter((k) => attrs[k] !== undefined && attrs[k] !== '')
    .map((k) => ` ${k}="${asAttr(String(attrs[k]))}"`)
    .join('');
  return `<${tag}${a}>\n${asData(body)}\n</${tag}>`;
};

/** At most this many errors go back to the model in one repair turn. */
export const REPAIR_ERRORS_MAX = 20;

/** The one repair turn after the model's JSON failed `check()`: the paths and what is wrong, nothing else. */
export const repairMessage = (errors: readonly CheckError[]): string => {
  const lines = errors.slice(0, REPAIR_ERRORS_MAX).map((e) => `- ${e.path || '(the whole object)'}: ${e.message}`);
  const more = errors.length > REPAIR_ERRORS_MAX ? `\n- …and ${errors.length - REPAIR_ERRORS_MAX} more of the same kind` : '';
  return `Your last answer did not pass validation. Fix exactly these problems, change nothing else, and answer with the whole corrected JSON object only:\n${lines.join('\n')}${more}`;
};

/** Model output longer than this is refused unparsed. */
export const MODEL_OUTPUT_MAX = 200000;

export type ParsedModelJson = { ok: true; value: unknown; error?: undefined } | { ok: false; error: 'empty' | 'too-long' | 'no-json' | 'bad-json'; value?: undefined };

/**
 * The JSON object in a model's answer: the whole text, or the first `{` to the last `}` (models sometimes wrap it in
 * a code fence or a sentence). The value is NOT trusted: run `check()` on it.
 */
export const parseModelJson = (text: unknown): ParsedModelJson => {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'empty' };
  if (text.length > MODEL_OUTPUT_MAX) return { ok: false, error: 'too-long' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'no-json' };
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'no-json' };
    return { ok: true, value };
  } catch (_err) {
    return { ok: false, error: 'bad-json' };
  }
};
