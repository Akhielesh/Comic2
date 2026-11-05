// The studios a visitor can register interest in. ONE list, used by:
//   * the browser form (components/WaitlistForm.tsx, via services/interest.ts),
//   * the API (server/src/routes/interest.ts, server/src/services/emailStore.ts),
//   * the database CHECK in server/sql/register_interest_2026_11.sql (pinned to this list by
//     services/studioInterests.test.ts, so a new studio fails CI until the SQL lists it too).
//
// The backend container bundles this file, so deploy-api-proxy.yml watches it by exact path
// (tests/config/deployPaths.test.ts enforces that). Keep it pure data with no imports: it has to
// bundle for the browser and for Node alike.
//
// Ids are stored in waitlist_signups.product_interests. Never rename or reuse one: stored rows
// keep the old id. To retire a studio, drop it here AND in the SQL CHECK, and move stored values
// aside the way register_interest_2026_11.sql does for code_studio / dashboards.

export const STUDIO_INTERESTS = [
  { id: 'comic_studio', label: 'Comic Studio', blurb: 'Write, draw and publish comics with AI.' },
  { id: 'stream_studio', label: 'Stream Studio', blurb: 'Go live from your browser.' },
  { id: 'chat_studio', label: 'Chat Studio', blurb: 'The assistant, with your connected apps.' },
  { id: 'atlas_studio', label: 'Atlas Studio', blurb: 'Search and preview files across your connected accounts.' },
  { id: 'future_studios', label: 'Future studios', blurb: 'Hear first when we open a new studio.' }
] as const;

export type StudioInterestId = (typeof STUDIO_INTERESTS)[number]['id'];

export const STUDIO_INTEREST_IDS: readonly StudioInterestId[] = STUDIO_INTERESTS.map((s) => s.id);

export const isStudioInterestId = (value: unknown): value is StudioInterestId =>
  typeof value === 'string' && (STUDIO_INTEREST_IDS as readonly string[]).includes(value);

/**
 * Keep only known ids, without duplicates, in the canonical order above (so stored arrays
 * compare equal however the picks arrived). Anything that isn't an array yields [].
 */
export const sanitizeStudioInterests = (raw: unknown): StudioInterestId[] => {
  if (!Array.isArray(raw)) return [];
  const picked = new Set(raw.filter(isStudioInterestId));
  return STUDIO_INTEREST_IDS.filter((id) => picked.has(id));
};

/** Human label for an id ("Comic Studio"); unknown ids come back unchanged. */
export const studioInterestLabel = (id: string): string =>
  STUDIO_INTERESTS.find((s) => s.id === id)?.label ?? id;

/** "Comic Studio", "Comic Studio and Atlas Studio", "Comic Studio, Chat Studio and Atlas Studio". */
export const formatStudioInterestList = (ids: readonly string[]): string => {
  const labels = ids.map(studioInterestLabel);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};
