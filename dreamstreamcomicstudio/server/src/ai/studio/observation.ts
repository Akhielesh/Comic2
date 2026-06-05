// Phase 4 — agentic build loop: the OBSERVE stage.
//
// Turns the raw, noisy signals from a container run (npm install stderr, the Vite/TS dev
// compile output, runtime console errors, and the preview's HTTP status) into a single
// structured `BuildObservation` the FIX stage can act on and the guard logic can reason
// about. Pure + deterministic — no I/O — so it is fully unit-testable without a live worker.
//
// Inputs map to the control plane (server/src/routes/studio.ts):
//   - launch error  → { phase:'install', log }   (npm install / boot failure)
//   - logs action   → { stdout, stderr }          (dev server compile errors / crashes)
//   - preview probe → httpStatus of GET /          (did the app actually come up?)
//   - iframe        → consoleErrors[]              (runtime errors collected from the preview)

export type ObservationPhase = 'install' | 'dev' | 'runtime' | 'http' | 'unknown';

export type ObservedErrorKind =
  | 'missing_dependency' // an npm package isn't installed / doesn't exist
  | 'import_error' // a relative/aliased import path doesn't resolve
  | 'type_error' // TypeScript / tsc diagnostic
  | 'syntax_error' // parse error (esbuild/SWC/Babel)
  | 'runtime_error' // threw at runtime (ReferenceError/TypeError/…)
  | 'dev_crash' // the dev server itself died (port in use, lifecycle abort)
  | 'http_error' // preview responded non-2xx (or didn't respond)
  | 'unknown';

export interface ObservedError {
  kind: ObservedErrorKind;
  message: string; // concise, normalized one-liner
  module?: string; // for missing_dependency / import_error — the unresolved specifier
  file?: string;
  line?: number;
  col?: number;
  raw?: string; // the originating log line, for debugging
}

export interface BuildObservation {
  phase: ObservationPhase;
  ok: boolean; // true when no errors were detected at all
  errors: ObservedError[];
  summary: string; // one-line human summary
  signature: string; // stable id of the dominant problem — drives the stuck-detector
}

export interface ObservationInput {
  /** npm install / boot stderr from a failed launch (worker `phase:'install'`). */
  installLog?: string;
  /** dev process stdout (Vite/Next banner + compile output). */
  stdout?: string;
  /** dev process stderr (compile errors, crashes). */
  stderr?: string;
  /** runtime console errors collected from the preview iframe. */
  consoleErrors?: string[];
  /** HTTP status of GET / on the preview URL (200 = up). */
  httpStatus?: number;
}

// --- line-level pattern rules ---------------------------------------------------------
// Ordered by specificity. The first rule that matches a line wins for that line.

interface Rule {
  kind: ObservedErrorKind;
  re: RegExp;
  build: (m: RegExpMatchArray, raw: string) => ObservedError;
}

const clip = (s: string, n = 200): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// A specifier is an npm package if it doesn't start with '.', '/', or '@/' (alias).
const isBarePackage = (spec: string): boolean => !/^[./]/.test(spec) && !spec.startsWith('@/');

const resolveSpec = (spec: string, raw: string): ObservedError => {
  const bare = isBarePackage(spec);
  return {
    kind: bare ? 'missing_dependency' : 'import_error',
    module: spec,
    message: bare ? `Missing dependency "${spec}"` : `Cannot resolve import "${spec}"`,
    raw: clip(raw)
  };
};

const RULES: Rule[] = [
  // TypeScript diagnostic with file(line,col): error TSxxxx: message
  {
    kind: 'type_error',
    re: /([^\s()]+\.[cm]?tsx?)\((\d+),(\d+)\):\s*error TS\d+:\s*(.+)/i,
    build: (m, raw) => ({
      kind: 'type_error',
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      message: clip(m[4]),
      raw: clip(raw)
    })
  },
  // Bare TS diagnostic without location.
  {
    kind: 'type_error',
    re: /error TS\d+:\s*(.+)/i,
    build: (m, raw) => ({ kind: 'type_error', message: clip(m[1]), raw: clip(raw) })
  },
  // Vite: Failed to resolve import "X" from "Y"
  {
    kind: 'missing_dependency',
    re: /Failed to resolve import ["']([^"']+)["']/i,
    build: (m, raw) => resolveSpec(m[1], raw)
  },
  // esbuild: Could not resolve "X"
  {
    kind: 'missing_dependency',
    re: /Could not resolve ["']([^"']+)["']/i,
    build: (m, raw) => resolveSpec(m[1], raw)
  },
  // webpack/CRA: Module not found: ... Can't resolve 'X'
  {
    kind: 'missing_dependency',
    re: /Can(?:'|no)t resolve ["']([^"']+)["']/i,
    build: (m, raw) => resolveSpec(m[1], raw)
  },
  // Node: Cannot find module 'X'
  {
    kind: 'missing_dependency',
    re: /Cannot find module ["']([^"']+)["']/i,
    build: (m, raw) => resolveSpec(m[1], raw)
  },
  // npm registry 404 — package name doesn't exist.
  {
    kind: 'missing_dependency',
    re: /404 Not Found.*registry\.npmjs\.org\/(@?[^/\s]+(?:\/[^/\s]+)?)/i,
    build: (m, raw) => ({
      kind: 'missing_dependency',
      module: m[1],
      message: `Package "${m[1]}" not found on npm (404)`,
      raw: clip(raw)
    })
  },
  // npm dependency resolution conflict.
  {
    kind: 'missing_dependency',
    re: /ERESOLVE (?:unable to resolve|could not resolve)/i,
    build: (_m, raw) => ({ kind: 'missing_dependency', message: 'npm dependency conflict (ERESOLVE)', raw: clip(raw) })
  },
  // Dev server crash — port already in use.
  {
    kind: 'dev_crash',
    re: /(EADDRINUSE|address already in use)/i,
    build: (_m, raw) => ({ kind: 'dev_crash', message: 'Dev server port already in use (EADDRINUSE)', raw: clip(raw) })
  },
  // Syntax / parse errors.
  {
    kind: 'syntax_error',
    re: /(SyntaxError:[^\n]+|Unexpected token[^\n]*|Unterminated [^\n]+|Unexpected end of [^\n]+)/i,
    build: (m, raw) => ({ kind: 'syntax_error', message: clip(m[1]), raw: clip(raw) })
  },
  // Runtime errors (also used for console errors).
  {
    kind: 'runtime_error',
    re: /\b(ReferenceError|TypeError|RangeError|URIError|EvalError):\s*([^\n]+)/,
    build: (m, raw) => ({ kind: 'runtime_error', message: clip(`${m[1]}: ${m[2]}`), raw: clip(raw) })
  }
];

const dedupe = (errors: ObservedError[]): ObservedError[] => {
  const seen = new Set<string>();
  const out: ObservedError[] = [];
  for (const e of errors) {
    const key = `${e.kind}|${e.module || ''}|${e.file || ''}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

/** Scan free-form log text line-by-line and extract every recognized error. */
export const parseErrors = (text: string | undefined, maxErrors = 12): ObservedError[] => {
  if (!text) return [];
  const errors: ObservedError[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) {
        errors.push(rule.build(m, line));
        break; // one error per line
      }
    }
  }
  return dedupe(errors).slice(0, maxErrors);
};

const phaseForKind = (kind: ObservedErrorKind): ObservationPhase => {
  if (kind === 'missing_dependency') return 'install';
  if (kind === 'runtime_error') return 'runtime';
  if (kind === 'http_error') return 'http';
  return 'dev';
};

const summarize = (errors: ObservedError[]): string => {
  if (!errors.length) return 'Build is clean — the app started with no detected errors.';
  const head = errors[0];
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `${head.message}${more}`;
};

/** Stable id of the dominant problem, so repeats are detectable across iterations. */
export const errorSignature = (errors: ObservedError[]): string => {
  if (!errors.length) return 'ok';
  const e = errors[0];
  const detail = e.module || e.file || e.message.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
  return `${e.kind}:${detail}`;
};

/**
 * Combine all signals from one container run into a single structured observation.
 * Errors are prioritized install → dev/compile → runtime → http, and the dominant
 * (first) error sets the phase + signature.
 */
export const buildObservation = (input: ObservationInput): BuildObservation => {
  const installErrors = parseErrors(input.installLog).map((e) => ({ ...e }));
  const devErrors = parseErrors([input.stdout, input.stderr].filter(Boolean).join('\n'));
  const consoleErrors = parseErrors((input.consoleErrors || []).join('\n')).map(
    (e): ObservedError => (e.kind === 'unknown' ? { ...e, kind: 'runtime_error' } : e)
  );
  // Raw console lines that didn't match a rule still count as runtime errors.
  const rawConsole: ObservedError[] = (input.consoleErrors || [])
    .filter((c) => c.trim() && !consoleErrors.some((e) => e.raw && c.includes(e.raw.replace(/…$/, '').trim())))
    .map((c) => ({ kind: 'runtime_error' as const, message: clip(c), raw: clip(c) }));

  const httpErrors: ObservedError[] =
    typeof input.httpStatus === 'number' && (input.httpStatus < 200 || input.httpStatus >= 400)
      ? [
          {
            kind: 'http_error',
            message:
              input.httpStatus === 0
                ? 'Preview did not respond (no HTTP status)'
                : `Preview responded HTTP ${input.httpStatus}`
          }
        ]
      : [];

  // Priority order — the first non-empty bucket is the dominant cause.
  const errors = dedupe([...installErrors, ...devErrors, ...consoleErrors, ...rawConsole, ...httpErrors]);
  const ok = errors.length === 0;
  const phase: ObservationPhase = ok ? 'unknown' : phaseForKind(errors[0].kind);

  return { phase, ok, errors, summary: summarize(errors), signature: errorSignature(errors) };
};
