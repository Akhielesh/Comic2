// A tiny, dependency-free template engine for recipe parameter substitution.
//
// goose templates recipe text with MiniJinja (Jinja2). We don't need the whole of
// Jinja for recipes — just the constructs recipes actually use — so this implements
// a faithful, safe subset with no eval and no external dependency:
//
//   {{ key }}                      variable substitution (whitespace-insensitive)
//   {{ key | default("x") }}       fallback when key is empty/undefined
//   {% if key %}...{% endif %}     conditional block (truthy = non-empty / true / != 0)
//   {% if key %}...{% else %}...{% endif %}
//
// Unknown variables render as empty strings (and log nothing) so a partial param set
// degrades gracefully rather than throwing mid-run. This is deliberately small and
// fully unit-tested (template.test.ts).

export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateVars = Record<string, TemplateValue>;

const truthy = (v: TemplateValue): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v.trim().length > 0;
};

const stringify = (v: TemplateValue): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

// Resolve a `{{ ... }}` expression: a bare variable, optionally piped through a
// `default("…")` / `default('…')` filter. Anything else falls back to the raw key
// lookup so we never throw on an unexpected expression.
const resolveExpression = (expr: string, vars: TemplateVars): string => {
  const parts = expr.split('|').map((p) => p.trim());
  const key = parts[0];
  let value = vars[key];

  for (const filter of parts.slice(1)) {
    const m = filter.match(/^default\(\s*["']([\s\S]*?)["']\s*\)$/);
    if (m && !truthy(value)) value = m[1];
  }
  return stringify(value);
};

// Render {% if %}/{% else %}/{% endif %} blocks. Supports nesting via a small stack
// machine so an inner if inside a taken/!taken branch is handled correctly.
const renderConditionals = (input: string, vars: TemplateVars): string => {
  const tokenRe = /\{%\s*(if\s+[a-zA-Z0-9_]+|else|endif)\s*%\}/g;

  interface Frame {
    /** Whether output is currently being emitted in this frame. */
    emit: boolean;
    /** Whether the parent frame was emitting (to restore on endif). */
    parentEmit: boolean;
    /** Whether the if-condition was true (controls else). */
    condTrue: boolean;
  }

  let out = '';
  let lastIndex = 0;
  let emit = true;
  const stack: Frame[] = [];
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(input)) !== null) {
    if (emit) out += input.slice(lastIndex, m.index);
    lastIndex = tokenRe.lastIndex;
    const tag = m[1];

    if (tag.startsWith('if')) {
      const key = tag.slice(2).trim();
      const condTrue = truthy(vars[key]);
      stack.push({ emit, parentEmit: emit, condTrue });
      emit = emit && condTrue;
    } else if (tag === 'else') {
      const frame = stack[stack.length - 1];
      if (frame) {
        frame.emit = frame.parentEmit && !frame.condTrue;
        emit = frame.emit;
      }
    } else if (tag === 'endif') {
      const frame = stack.pop();
      if (frame) emit = frame.parentEmit;
    }
  }
  if (emit) out += input.slice(lastIndex);
  return out;
};

/**
 * Render a recipe template string against a set of parameter values.
 * Order: resolve conditionals first (so {{vars}} inside a dropped branch are never
 * emitted), then substitute the remaining {{ ... }} expressions.
 */
export const renderTemplate = (template: string | undefined, vars: TemplateVars): string => {
  if (!template) return '';
  const withConditionals = renderConditionals(template, vars);
  return withConditionals.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_full, expr) =>
    resolveExpression(String(expr).trim(), vars)
  );
};

/** The set of `{{ variable }}` keys referenced by a template (for UI hints / validation). */
export const referencedVariables = (template: string | undefined): string[] => {
  if (!template) return [];
  const keys = new Set<string>();
  const varRe = /\{\{\s*([a-zA-Z0-9_]+)/g;
  const ifRe = /\{%\s*if\s+([a-zA-Z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(template)) !== null) keys.add(m[1]);
  while ((m = ifRe.exec(template)) !== null) keys.add(m[1]);
  return [...keys];
};
