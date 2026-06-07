// Live data-driven artifacts — the `html_template_v1` engine (onboarded from open-design's
// live-artifacts). A template is HTML with `{{ dot.path }}` bindings; rendering interpolates
// HTML-escaped values from a data object. It is DATA-ONLY: <script>/<iframe>/<object>/<embed>,
// inline on*= handlers, javascript: URLs and srcdoc are rejected, so a rendered artifact is safe
// to display and can be re-rendered against fresh data ("live dashboard"). Pure + dependency-free
// → fully unit-testable, zero network egress.

export const LIVE_TEMPLATE_FORMAT = 'html_template_v1';

const BLOCKED: { re: RegExp; name: string }[] = [
  { re: /<script[\s>]/i, name: '<script>' },
  { re: /<\/script>/i, name: '</script>' },
  { re: /<iframe[\s>]/i, name: '<iframe>' },
  { re: /<object[\s>]/i, name: '<object>' },
  { re: /<embed[\s>]/i, name: '<embed>' },
  { re: /\son\w+\s*=/i, name: 'inline event handler (on*=)' },
  { re: /javascript:/i, name: 'javascript: URL' },
  { re: /srcdoc\s*=/i, name: 'srcdoc attribute' },
];

/** Reject anything that could execute script — live templates are data-only HTML. */
export const validateLiveTemplate = (html: string): { ok: boolean; reason?: string } => {
  if (typeof html !== 'string' || !html.trim()) return { ok: false, reason: 'empty template' };
  for (const b of BLOCKED) if (b.re.test(html)) return { ok: false, reason: `disallowed ${b.name} — live templates are data-only (no JS)` };
  return { ok: true };
};

const escapeHtml = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Resolve a dot-path (e.g. "users.0.name") against an object; undefined if any segment is missing. */
export const readTemplatePath = (data: unknown, path: string): unknown => {
  const parts = path.split('.').map((s) => s.trim()).filter(Boolean);
  let cur: unknown = data;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

const BINDING = /\{\{\s*([\w.$-]+)\s*\}\}/g;

/** Render `{{ path }}` bindings to HTML-escaped values from `data` (validates security first). */
export const renderLiveTemplate = (html: string, data: unknown): string => {
  const safe = validateLiveTemplate(html);
  if (!safe.ok) throw new Error(safe.reason);
  return html.replace(BINDING, (_m, path: string) => {
    const v = readTemplatePath(data, path);
    if (v == null) return '';
    if (typeof v === 'string') return escapeHtml(v);
    if (typeof v === 'number' || typeof v === 'boolean') return escapeHtml(String(v));
    return escapeHtml(JSON.stringify(v));
  });
};
