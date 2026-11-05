// Dialogue understanding: who a name means (agent-editor plan §3 B2 speakers.ts). Pure and free.
//
// A speaker resolves only on ONE candidate; otherwise the candidates come back so the studio can ask ("Which Leo?").
// Match order (the first step with any hit decides): exact id → exact name (case-insensitive) → unique first or last
// name token ("Mira" → "Mira Patel") → unique 3+ letter prefix → a cast kind or species word ("the robot") → a role word
// ("her mom" → the cast member whose role says mom). A pronoun ("her", "he", "them") resolves only to
// `ctx.pronounOf`: the speaker of the selected line, or of the last line the sentence named.

import { castKindOf, type CastKind, type Character, type ComicDoc } from '../doc.js';
import type { SpeakerMatch } from './types.js';

/** Pronouns that never fuzzy-match a name ("her" must not become "Herbert"). */
export const SPEAKER_PRONOUNS: ReadonlySet<string> = new Set(['he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs', 'it', 'its', 'himself', 'herself', 'themself']);

/** Cast kind words: "the robot", "the droid", "the creature". */
const KIND_WORDS: Readonly<Record<string, CastKind>> = {
  robot: 'robot', bot: 'robot', android: 'robot', droid: 'robot', machine: 'robot', cyborg: 'robot',
  animal: 'animal', pet: 'animal', beast: 'animal',
  creature: 'creature', monster: 'creature', alien: 'creature',
  toy: 'toy', doll: 'toy', puppet: 'toy', figure: 'toy',
  vehicle: 'vehicle', car: 'vehicle', truck: 'vehicle', ship: 'vehicle', train: 'vehicle',
  object: 'object', thing: 'object'
};

/** Family and role words, each with the spellings a role or name might use. */
const ROLE_WORDS: Readonly<Record<string, readonly string[]>> = {
  mom: ['mom', 'mother', 'mum', 'mama', 'mommy', 'mummy', 'amma', 'maa', 'ma'],
  dad: ['dad', 'father', 'papa', 'daddy', 'pa', 'appa', 'baba'],
  grandma: ['grandma', 'grandmother', 'granny', 'nani', 'dadi', 'paati'],
  grandpa: ['grandpa', 'grandfather', 'nana', 'dada', 'thatha'],
  sister: ['sister', 'sis'],
  brother: ['brother', 'bro'],
  teacher: ['teacher', 'professor', 'tutor'],
  friend: ['friend', 'buddy', 'pal'],
  boss: ['boss', 'chief', 'captain'],
  villain: ['villain', 'bad guy', 'antagonist'],
  hero: ['hero', 'heroine', 'protagonist']
};
const ROLE_OF: ReadonlyMap<string, string> = new Map(Object.entries(ROLE_WORDS).flatMap(([k, list]) => list.map((w) => [w, k] as [string, string])));

/**
 * A name as typed → its bare form: lower case, curly quotes straightened, a possessive dropped ("Mira's" → "mira"),
 * punctuation and a leading article or possessive pronoun dropped ("the robot" → "robot", "her mom" → "mom").
 */
export const normalizeSpeakerName = (raw: string): string => {
  let s = (raw || '').normalize('NFC').toLowerCase().replace(/[’‘`]/g, "'").trim();
  s = s.replace(/'s\b|s'(?=\s|$)/g, (m) => (m === "'s" ? '' : 's'));
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) s = s.replace(/^(?:the|a|an|my|our|your|her|his|their|its|that|this)\s+/, '');
  return s;
};

const tokensOf = (name: string): string[] => normalizeSpeakerName(name).split(/[\s-]+/).filter(Boolean);

const decide = (hits: readonly Character[]): SpeakerMatch | undefined => {
  const ids = [...new Set(hits.map((c) => c.id))];
  if (ids.length === 1) return { status: 'one', characterId: ids[0] };
  if (ids.length > 1) return { status: 'many', characterIds: ids };
  return undefined;
};

const singular = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/**
 * Name / kind word / pronoun → cast id (B2 speakers.ts): exact id, exact name, unique first or last name, unique 3+ letter
 * prefix, cast kind word ("the robot"), pronoun → the selected line's speaker. Resolves only on ONE candidate.
 */
export function matchSpeaker(doc: ComicDoc, name: string, ctx: { pronounOf?: string } = {}): SpeakerMatch {
  const cast = Array.isArray(doc?.cast) ? doc.cast : [];
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw || !cast.length) return { status: 'none' };
  // 1. Exact id.
  const byId = cast.find((c) => c.id === raw);
  if (byId) return { status: 'one', characterId: byId.id };
  const key = normalizeSpeakerName(raw);
  if (!key) return { status: 'none' };
  // 2. Exact name, case-insensitive (two characters called "Mira" → both).
  const exact = decide(cast.filter((c) => normalizeSpeakerName(c.name) === key));
  if (exact) return exact;
  // A pronoun names the speaker in focus, never a name that happens to start with it.
  const words = key.split(' ');
  if (SPEAKER_PRONOUNS.has(key) || (words.length === 1 && SPEAKER_PRONOUNS.has(raw.toLowerCase().replace(/[^a-z]/g, '')))) {
    return ctx.pronounOf && cast.some((c) => c.id === ctx.pronounOf) ? { status: 'one', characterId: ctx.pronounOf } : { status: 'none' };
  }
  if (words.length === 1) {
    // 3. A first or last name token ("Mira" → "Mira Patel"; "Patel" → both Patels).
    const token = decide(
      cast.filter((c) => {
        const t = tokensOf(c.name);
        return t.length > 1 && (t[0] === key || t[t.length - 1] === key);
      })
    );
    if (token) return token;
    // 4. A unique prefix of 3+ letters ("Mir" → "Mira Patel").
    if (key.length >= 3) {
      const prefix = decide(cast.filter((c) => normalizeSpeakerName(c.name).startsWith(key) || tokensOf(c.name).some((t) => t.startsWith(key))));
      if (prefix) return prefix;
    }
  }
  // 5. A cast kind word or a species word ("the robot", "the duckling").
  const last = singular(words[words.length - 1]);
  const kind = KIND_WORDS[last];
  if (kind) {
    const byKind = decide(cast.filter((c) => castKindOf(c) === kind));
    if (byKind) return byKind;
  }
  const bySpecies = decide(cast.filter((c) => !!c.look?.species && tokensOf(c.look.species).map(singular).includes(last)));
  if (bySpecies) return bySpecies;
  // 6. A role word ("her mom", "the teacher").
  const role = ROLE_OF.get(key) ?? ROLE_OF.get(last);
  if (role) {
    const spellings = new Set(ROLE_WORDS[role]);
    const byRole = decide(cast.filter((c) => !!c.role && tokensOf(c.role).some((t) => spellings.has(t))));
    if (byRole) return byRole;
  }
  return { status: 'none' };
}

/** The cast member's display name, or undefined. */
export const speakerName = (doc: ComicDoc, id: string | undefined): string | undefined => (id ? doc.cast.find((c) => c.id === id)?.name : undefined);

/** "Mira Patel, Leo and Bolt" (the honest list a "no such character" reply quotes). */
export const castList = (doc: ComicDoc, ids?: readonly string[]): string => {
  const names = (ids ? ids.map((id) => speakerName(doc, id)) : doc.cast.map((c) => c.name)).filter((n): n is string => !!n && !!n.trim());
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/** The plain sentence for a speaker that matched nobody. */
export const noSuchSpeaker = (doc: ComicDoc, name: string): string => {
  const cast = castList(doc);
  return `There's no character called “${name.trim().slice(0, 40)}”${cast ? `. The cast is ${cast}.` : ': the cast is empty.'}`;
};
