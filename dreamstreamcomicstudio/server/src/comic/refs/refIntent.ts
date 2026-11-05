// Free deterministic pre-pass over the user's words when images are present (refs.md §6.4).
// Owner: P1-REFS. $0, pure, bounded (the text is clipped and every pattern is linear).
//
// The director is a Flash-class model looking at up to 8 thumbnails; one software line such as
//   (software, may be wrong) images 1–5 → BRUNO (new; "dog" → kind animal); "outfit" mentioned for image 3
// makes it file photos where the user meant, the first time. The hint is advice, never an action.

import type { CastKind, ComicDoc, RefLabel } from '../../../../shared/comic/doc.js';
import { numberRanges, upperName } from './addRefs.js';

const MAX_TEXT = 2000;

const KIND_NOUNS: Record<string, CastKind> = {
  dog: 'animal', dogs: 'animal', puppy: 'animal', pup: 'animal', doggo: 'animal', cat: 'animal', cats: 'animal', kitten: 'animal', kitty: 'animal',
  pet: 'animal', bunny: 'animal', rabbit: 'animal', hamster: 'animal', bird: 'animal', parrot: 'animal', horse: 'animal', pony: 'animal',
  fish: 'animal', turtle: 'animal', tortoise: 'animal', duck: 'animal', guinea: 'animal', goat: 'animal', cow: 'animal',
  son: 'person', daughter: 'person', baby: 'person', kid: 'person', kiddo: 'person', boy: 'person', girl: 'person', wife: 'person',
  husband: 'person', mom: 'person', mum: 'person', mother: 'person', dad: 'person', father: 'person', brother: 'person', sister: 'person',
  friend: 'person', grandma: 'person', grandpa: 'person', granny: 'person', grandmother: 'person', grandfather: 'person', uncle: 'person',
  aunt: 'person', niece: 'person', nephew: 'person', cousin: 'person', partner: 'person', teacher: 'person', boyfriend: 'person', girlfriend: 'person',
  toy: 'toy', teddy: 'toy', doll: 'toy', plush: 'toy', plushie: 'toy', lego: 'toy', figure: 'toy', figurine: 'toy', stuffie: 'toy',
  robot: 'robot', car: 'vehicle', bike: 'vehicle', bicycle: 'vehicle', truck: 'vehicle', bus: 'vehicle', train: 'vehicle', boat: 'vehicle',
  scooter: 'vehicle', tractor: 'vehicle', dragon: 'creature', monster: 'creature', unicorn: 'creature', dinosaur: 'creature', alien: 'creature'
};

/** Words that sit between a trigger and the name ("this is MY LITTLE DOG named Bruno"). */
const FILLERS = new Set([
  'my', 'our', 'the', 'a', 'an', 'his', 'her', 'their', 'your', 'little', 'baby', 'new', 'old', 'best', 'big', 'cute', 'sweet', 'beloved',
  'named', 'called', 'whose', 'name', 'is', 'are', 'pet', 'family', 'of', 'for', 'both', 'all', 'also', 'just', 'actually', 'really'
]);

/** Never a name. */
const STOP = new Set([
  ...FILLERS,
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'him', 'them', 'they', 'we', 'us', 'me', 'i', 'you', 'and', 'or', 'but',
  'with', 'in', 'on', 'at', 'to', 'from', 'as', 'like', 'some', 'any', 'photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image',
  'images', 'shot', 'shots', 'one', 'two', 'three', 'four', 'five', 'here', 'there', 'who', 'what', 'how', 'very', 'so', 'not', 'no',
  'yes', 'please', 'too', 'now', 'then', 'every', 'each', 'page', 'pages', 'comic', 'story', 'character', 'characters', 'main', 'same',
  'was', 'were', 'be', 'been', 'look', 'looks', 'style', 'place', 'background', 'reference', 'references', 'ref', 'refs', 'him', 'hers',
  'going', 'gonna', 'want', 'wants', 'should', 'will', 'can', 'could', 'would', 'outfit', 'face', 'different', 'more', 'other', 'another'
]);

const LABEL_WORDS: Record<string, RefLabel> = {
  outfit: 'outfit', dress: 'outfit', costume: 'outfit', clothes: 'outfit', shirt: 'outfit', uniform: 'outfit', jacket: 'outfit',
  face: 'face', smile: 'expression', expression: 'expression', pose: 'pose', side: 'side', profile: 'side', back: 'back', front: 'front',
  hair: 'detail', collar: 'detail', markings: 'detail', 'full-body': 'full_body'
};

const STYLE_RE = /\b(art ?style|style|look(?:s)? like|draw (?:it|this|them|us|me) like|drawn like|vibe|art like|aesthetic|in the style)\b/i;
const PLACE_RE =
  /\b(?:our|my|the) (house|home|school|street|park|garden|yard|backyard|kitchen|bedroom|room|village|town|city|beach|farm|cabin|classroom|playground)\b|\b(this place|background|setting|location)\b/i;

interface Assignment {
  numbers: number[];
  names: string[];
  /** Per name: typed capitalized, after a kind noun ("my dog bruno") or after "named/called". */
  strong: boolean[];
  kind?: CastKind;
  kindWord?: string;
}

export interface AttachmentAnalysis {
  assignments: Assignment[];
  labels: { image?: number; label: RefLabel; word: string }[];
  style?: string;
  place?: string;
}

const tokenizeRaw = (text: string): string[] => text.match(/[\p{L}\p{N}#][\p{L}\p{N}'’-]*/gu) || [];
const tokenize = (text: string): string[] => tokenizeRaw(text).map((t) => t.toLowerCase());

/** Kind noun for a word, accepting a plain plural ("kids", "dogs"). */
const kindOf = (t: string): CastKind | undefined => KIND_NOUNS[t] ?? (t.length > 3 && t.endsWith('s') ? KIND_NOUNS[t.slice(0, -1)] : undefined);

const isNameToken = (t: string): boolean => /^\p{L}[\p{L}'’-]{1,29}$/u.test(t) && !STOP.has(t) && !kindOf(t);

const clean = (t: string) => t.replace(/['’]s$/u, '').replace(/['’-]+$/u, '');

const levenshtein = (a: string, b: string): number => {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
};

/**
 * Read names after a trigger: skip fillers and kind nouns (recording the kind), then take up to
 * three names joined by "and" / ",". Returns the names and how many tokens were consumed.
 */
const readNames = (
  tokens: string[],
  raw: string[],
  from: number
): { names: string[]; strong: boolean[]; kind?: CastKind; kindWord?: string } => {
  const names: string[] = [];
  const strong: boolean[] = [];
  let kind: CastKind | undefined;
  let kindWord: string | undefined;
  let named = false;
  let i = from;
  for (let guard = 0; i < tokens.length && guard < 6; guard += 1) {
    const t = clean(tokens[i]);
    const k = kindOf(t);
    if (k) {
      kind ??= k;
      kindWord ??= t;
      i += 1;
      continue;
    }
    if (FILLERS.has(t)) {
      if (t === 'named' || t === 'called') named = true;
      i += 1;
      continue;
    }
    break;
  }
  while (i < tokens.length && names.length < 3) {
    const t = clean(tokens[i]);
    if (!isNameToken(t)) break;
    names.push(t);
    strong.push(/^\p{Lu}/u.test(raw[i] || '') || !!kindWord || named);
    if (tokens[i + 1] === 'and' && tokens[i + 2] && isNameToken(clean(tokens[i + 2]))) i += 2;
    else break;
  }
  return { names, strong, ...(kind ? { kind } : {}), ...(kindWord ? { kindWord } : {}) };
};

/** Pure analysis (exported for tests). `count` = images available this turn. */
export function analyzeAttachmentText(text: string, count: number): AttachmentAnalysis | null {
  if (typeof text !== 'string' || !text.trim() || !(count > 0)) return null;
  const body = text.slice(0, MAX_TEXT).replace(/[\u2012-\u2015\u2212]/g, '-').replace(/\s+/g, ' ');
  const raw = tokenizeRaw(body);
  const tokens = raw.map((t) => t.toLowerCase());
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const out: AttachmentAnalysis = { assignments: [], labels: [] };
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= count;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    // 1. Numbered: "#3 is Maya", "1-3 are Maya", "1 to 3 are Maya", "image 2 is her outfit".
    const num = /^#?(\d{1,2})$/.exec(t);
    if (num && (i === 0 || !/^\d/.test(tokens[i - 1]))) {
      const a = Number(num[1]);
      let b = a;
      let j = i + 1;
      if ((tokens[j] === 'to' || tokens[j] === 'through' || tokens[j] === 'thru' || tokens[j] === 'and') && /^#?\d{1,2}$/.test(tokens[j + 1] || '')) {
        b = Number(tokens[j + 1].replace('#', ''));
        j += 2;
      }
      if (['is', 'are', '=', 'shows', 'show', "'s", 'was'].includes(tokens[j] || '')) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const numbers = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).filter(inRange);
        const labelWord = tokens.slice(j + 1, j + 4).map(clean).find((w) => LABEL_WORDS[w]);
        const read = readNames(tokens, raw, j + 1);
        if (numbers.length && read.names.length) out.assignments.push({ numbers, ...read });
        if (numbers.length === 1 && labelWord) out.labels.push({ image: numbers[0], label: LABEL_WORDS[labelWord], word: labelWord });
      }
      continue;
    }
    // "1-3" tokenizes as one token.
    const dashed = /^#?(\d{1,2})[-–]#?(\d{1,2})$/.exec(t);
    if (dashed && ['is', 'are', '=', 'show', 'shows'].includes(next || '')) {
      const lo = Math.min(Number(dashed[1]), Number(dashed[2]));
      const hi = Math.max(Number(dashed[1]), Number(dashed[2]));
      const numbers = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).filter(inRange);
      const read = readNames(tokens, raw, i + 2);
      if (numbers.length && read.names.length) out.assignments.push({ numbers, ...read });
      continue;
    }
    // 2. Identity: "this is my dog Bruno", "these are Maya", "meet Bruno", "here's Maya", "that's Maya".
    const contraction = /^(this|that|here)['’]s$/.exec(t);
    if (
      contraction ||
      t === 'meet' ||
      (['this', 'that', 'these', 'those', 'here'].includes(t) && ['is', 'are', '=', 'was'].includes(next || ''))
    ) {
      const read = readNames(tokens, raw, contraction || t === 'meet' ? i + 1 : i + 2);
      if (read.names.length) out.assignments.push({ numbers: all, ...read });
      continue;
    }
    // 3. "photos of Maya", "pics for Bruno".
    if (/^(photos?|pics?|pictures?|images?|shots?|selfies?)$/.test(t) && (next === 'of' || next === 'for')) {
      const read = readNames(tokens, raw, i + 2);
      if (read.names.length) out.assignments.push({ numbers: all, ...read });
      continue;
    }
    // 4. "Maya's outfit" → a label hint for the images.
    const poss = /^(\p{L}[\p{L}-]{1,29})['’]s$/u.exec(t);
    if (poss && next && LABEL_WORDS[next] && isNameToken(poss[1])) {
      out.labels.push({ label: LABEL_WORDS[next], word: next });
    }
  }
  const style = STYLE_RE.exec(body);
  if (style) out.style = style[1].toLowerCase();
  const place = PLACE_RE.exec(body);
  if (place) out.place = (place[0] || '').toLowerCase();
  if (!out.assignments.length && !out.labels.length && !out.style && !out.place) return null;
  return out;
}

/** A name the user typed → the cast member it means (exact, or 1 typo for names of 4+ letters). */
const matchCast = (doc: ComicDoc | undefined, name: string) => {
  if (!doc) return undefined;
  const n = name.toLowerCase();
  const exact = doc.cast.find((c) => c.name.trim().toLowerCase() === n || c.name.trim().toLowerCase().split(/\s+/)[0] === n);
  if (exact) return exact;
  if (n.length < 3) return undefined;
  return doc.cast.find((c) => {
    const cn = c.name.trim().toLowerCase().split(/\s+/)[0];
    return cn.length >= 4 && cn[0] === n[0] && levenshtein(cn, n) <= 1;
  });
};

const matchPlace = (doc: ComicDoc | undefined, name: string) =>
  doc?.places.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());

/** The one-line hint (refs.md §6.4), or null when nothing useful was found. */
export function attachmentHint(text: string, doc: ComicDoc | undefined, count: number): string | null {
  if (typeof text !== 'string' || !text.trim() || !(count > 0)) return null;
  const a = analyzeAttachmentText(text, count);
  const parts: string[] = [];
  if (a) {
    const seen = new Set<string>();
    for (const as of a.assignments) {
      const key = `${as.numbers.join(',')}:${as.names.join('+')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A word that is not in the cast must look like a name ("Bruno", "my dog bruno", "named bruno").
      const who = as.names
        .map((n, i) => {
          const c = matchCast(doc, n);
          if (c) return `${upperName(c.name)} (existing, ${c.refs.length} ref${c.refs.length === 1 ? '' : 's'})`;
          const p = matchPlace(doc, n);
          if (p) return `the place ${upperName(p.name)} (existing)`;
          if (!as.strong[i]) return '';
          const kind = as.kindWord ? `"${as.kindWord}" → kind ${as.kind}` : '';
          return doc ? `${upperName(n)} (new${kind ? `; ${kind}` : ''})` : `${upperName(n)}${kind ? ` (${kind})` : ''}`;
        })
        .filter(Boolean);
      if (!who.length) continue;
      const span = `${as.numbers.length === 1 ? 'image' : 'images'} ${numberRanges(as.numbers)}`;
      parts.push(`${span} → ${who.join(' and ')}${who.length > 1 ? ' (several names — ask which is which if unclear)' : ''}`);
    }
    for (const l of a.labels) parts.push(`"${l.word}" mentioned${l.image ? ` for image ${l.image}` : ''} (label ${l.label})`);
    if (a.style) parts.push(`style cue ("${a.style}") — these may be a style reference`);
    if (a.place) parts.push(`place cue ("${a.place}") — these may show a place`);
  }
  if (!parts.length && doc) {
    // Weak signal: exactly one cast member named in the message.
    const words = new Set(tokenize(text.slice(0, MAX_TEXT)).map(clean));
    const named = doc.cast.filter((c) => {
      const first = c.name.trim().toLowerCase().split(/\s+/)[0];
      return first.length >= 2 && words.has(first);
    });
    if (named.length === 1) parts.push(`${count === 1 ? 'image 1' : `images 1–${count}`} may show ${upperName(named[0].name)} (named in the message)`);
  }
  return parts.length ? `(software, may be wrong) ${parts.join('; ')}.` : null;
}

/**
 * Seam (contract §12.8): the free pre-pass the director appends as "REF HINT: …". `doc`
 * (optional, additive) lets names resolve against the cast ("Mya" → MAYA, "2 refs").
 */
export function refIntentHint(text: string, imageCount: number, doc?: ComicDoc): string | undefined {
  try {
    return attachmentHint(text, doc, imageCount) ?? undefined;
  } catch {
    return undefined;
  }
}
