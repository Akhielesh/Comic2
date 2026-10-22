// One display name for the whole account — DreamStream, Stream Studio, the baby
// monitor and calls all show the same one. Shared by the server (PATCH /api/account/name,
// GET /api/account/studios) and both apps, so cleaning and splitting never disagree.
//
// Where it lives: auth user_metadata.display_name (canonical; what live__default_name and
// a future live_join pick up), mirrored into live_profiles.display_name and
// profile_private.first_name/last_name. profiles.username stays the @handle.

/** live_profiles.display_name is checked to 1–40 characters. */
export const NAME_MAX = 40;

/** Trimmed, single-spaced, no control characters, at most NAME_MAX. Null when nothing is left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return s || null;
}

/** First word / the rest — the same split Stream Studio's sign-up uses for first/last name. */
export function splitName(name: string): { first: string; last: string | null } {
  const [first, ...rest] = name.split(' ');
  return { first, last: rest.join(' ') || null };
}

/** The name to show: the Stream Studio name (what family already sees), else first + last, else the @handle. */
export function resolveName(s: { live?: string | null; first?: string | null; last?: string | null; username?: string | null }): string | null {
  const joined = [s.first, s.last].map((v) => v?.trim()).filter(Boolean).join(' ');
  return s.live?.trim() || joined || s.username?.trim() || null;
}
