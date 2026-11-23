import { normalizePageContinuity, type CastStateChange, type Character, type PageContinuity } from '../../../shared/comic/doc.js';

export const OUTLINE_CHANGE_FIELDS = ['outfit', 'holding', 'marks', 'prop'] as const;
type Field = typeof OUTLINE_CHANGE_FIELDS[number];
export interface OutlineChange { subject: string; field: Field; values: string[]; evidence: string }

const clean = (text: unknown) => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
const canonical = (text: string) => clean(text).toLowerCase();
const fields: readonly string[] = OUTLINE_CHANGE_FIELDS;

/** A durable plan detail needs an actual passage from this page's outline or the author's script. */
export function readOutlineChanges(raw: unknown, summary: string, normalizedSource: string): OutlineChange[] {
  if (!Array.isArray(raw)) return [];
  const accepted: OutlineChange[] = [];
  const beat = canonical(summary);
  for (const change of raw.slice(0, 8)) {
    if (!change || typeof change !== 'object') continue;
    const subject = clean(change.subject);
    const field = change.field;
    const evidence = clean(change.evidence);
    if (!subject || subject.length > 80 || !fields.includes(field) || !Array.isArray(change.values) ||
        change.values.length > 4 || evidence.length < 6 || evidence.length > 180) continue;
    const quote = canonical(evidence);
    if (!beat.includes(quote) && !normalizedSource.includes(quote)) continue;
    if (change.values.some((value: unknown) => !clean(value) || clean(value).length > 140)) continue;
    const values = [...new Set<string>(change.values.map(clean))];
    if ((field === 'outfit' || field === 'prop') && values.length > 1) continue;
    accepted.push({ subject, field, values, evidence });
    if (accepted.length >= 4) break;
  }
  return accepted;
}

/** Describe only states already introduced before this group. Later changes are addressed on their own page. */
export function writerHandoff(outline: ReadonlyArray<{ n: number; characters: string[]; place: string; changes?: OutlineChange[] }>, first: number, last: number): string {
  const carried = new Map<string, { n: number; change: OutlineChange }>();
  const during: Array<{ n: number; change: OutlineChange }> = [];
  let location = '';
  for (const page of outline) {
    if (page.n > last) break;
    const place = canonical(page.place);
    if (page.n <= first && place && location && place !== location) {
      for (const [key, entry] of carried) if (entry.change.field === 'holding') carried.delete(key);
    }
    if (place) location = place;
    for (const change of page.changes || []) {
      const key = canonical(change.subject) + '\n' + change.field;
      if (page.n < first) {
        carried.delete(key);
        if (change.values.length || change.field === 'prop') carried.set(key, { n: page.n, change });
      } else {
        during.push({ n: page.n, change });
      }
    }
  }
  const line = ({ n, change }: { n: number; change: OutlineChange }) =>
    `Page ${n} · ${change.subject} · ${change.field} · ${change.values.join(', ') || (change.field === 'prop' ? 'gone' : 'reset to original')}`;
  const currentCast = new Set(outline.filter(p => p.n >= first && p.n <= last).flatMap(p => p.characters.map(canonical)));
  const priority = (change: OutlineChange) => currentCast.has(canonical(change.subject)) ? 2 : change.field === 'prop' ? 1 : 0;
  const before = [...carried.values()].sort((a, b) => priority(b.change) - priority(a.change) || b.n - a.n)
    .slice(0, 20).sort((a, b) => a.n - b.n);
  return [
    before.length ? 'At the start of this section, carry these visual details forward. Held objects apply within their scene:\n' + before.map(line).join('\n') : '',
    during.length ? 'Apply these changes on the indicated pages:\n' + during.map(line).join('\n') : ''
  ].filter(Boolean).join('\n');
}

/** Resolve the outline's names against the final cast after every writing group is combined. */
export function outlinePageContinuity(changes: OutlineChange[], cast: readonly Character[]): PageContinuity | undefined {
  const characters: Record<string, CastStateChange> = Object.create(null);
  const props: Record<string, string | null> = Object.create(null);
  for (const { subject, field, values } of changes) {
    if (field === 'prop') {
      props[canonical(subject)] = values[0] ?? null;
      continue;
    }
    const exact = cast.find(c => c.id === subject);
    const matches = exact ? [exact] : cast.filter(c => canonical(c.name) === canonical(subject));
    if (matches.length !== 1) continue;
    const state = characters[matches[0].id] ??= {};
    if (field === 'outfit') state.outfit = values[0] ?? null;
    else state[field] = values.length ? values : null;
  }
  if (!Object.keys(characters).length && !Object.keys(props).length) return undefined;
  return normalizePageContinuity({ cast: characters, props, by: 'writer' });
}
