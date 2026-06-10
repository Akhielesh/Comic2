// Studio id normalization.
//
// The client tags workspaces with human-scannable ids like `proj_<uuid>` / `sess_<uuid>`
// (services/studioSessions.ts), but the studio tables key on Postgres `uuid` columns.
// Passing the prefixed form straight into an insert/select made Postgres reject the value
// — and because those writes are best-effort, the failure was SILENT: projects didn't
// persist, runs weren't metered, and studio_deployments stayed empty. Every studio route
// runs ids through here instead: strip known prefixes, accept real UUIDs, and map anything
// else (e.g. the non-crypto fallback id) to a STABLE hash-derived UUID so the same client
// id always lands on the same row.

import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize a client-supplied studio project/session id to a stable UUID, or undefined. */
export const normalizeStudioId = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const stripped = trimmed.replace(/^(proj|project|sess|session)_/i, '');
  if (UUID_RE.test(stripped)) return stripped.toLowerCase();
  // Deterministic RFC-4122-shaped (v5-style) UUID from the raw id, so retries/refines from
  // the same workspace keep hitting the same project row.
  const h = createHash('sha1').update(trimmed).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Like normalizeStudioId, but mints a fresh UUID when the input is missing/invalid. */
export const normalizeStudioIdOrNew = (raw: unknown): string =>
  normalizeStudioId(raw) ?? crypto.randomUUID();
