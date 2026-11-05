/**
 * Which classes in a class string are unvariant text COLOURS (shared by the status ink guard's class-list
 * analysis, tests/config/classLists.ts, and the rendered tone-button test). Dependency-free, so a jsdom
 * component test can import it without loading the TypeScript parser.
 * Not a test file (no `.test.` in the name), so vitest does not collect it; the typecheck covers it.
 */

/** The readable tone inks (index.css `--ds-*-text`). */
export const TONE_INK = /^text-\[var\(--ds-(?:success|warning|danger|info)-text\)\]$/;
/** `text-*` utilities that are not a colour: size, alignment, wrapping, overflow, an arbitrary length. */
const NOT_A_COLOUR =
  /^text-(?:(?:xs|sm|base|lg|[2-9]?xl|\[(?:length:|\d|\.|calc\(|clamp\()[^\s\]]*\])(?:\/\S+)?|left|center|right|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/;

/** The unvariant (no `dark:` / `hover:` prefix) text colour classes in a class string. */
export function textColours(classes: string): string[] {
  return classes.split(/\s+/).filter((c) => c.startsWith('text-') && !NOT_A_COLOUR.test(c));
}

