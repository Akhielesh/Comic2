// Register your interest: the optional questions, their caps, the text cleaning and the one stored shape,
// in one place for the server route (server/src/routes/newsletter.ts, which validates and refuses
// oversize) and the form's direct save (services/waitlist.ts, used when the server cannot answer), so a
// row reads the same whichever path wrote it. Pure module: no imports, safe in the browser, the server and
// tests.
//
// Storage needs no schema change: the answers ride in the existing `metadata` jsonb column of
// public.waitlist_signups as `metadata.answers` (see interestMetadata). The server also copies the comment
// into the existing `feedback` column and the studio picks into `product_interests`.

/**
 * The question above INTEREST_FEATURES. It asks about wishes as well as use, because some of the abilities (series and
 * collections) are not built yet and must not read as if they were.
 */
export const INTEREST_FEATURES_QUESTION = 'What would you use, or like to see?';

/** INTEREST_FEATURES_QUESTION's answers: Comic Studio abilities and what is close behind them. */
export const INTEREST_FEATURES = [
  { id: 'chat', label: 'Making a comic by chatting' },
  { id: 'translations', label: 'Translations into other languages' },
  { id: 'series', label: 'Series and collections' },
  { id: 'library', label: 'Publishing to the public Library' },
  { id: 'print', label: 'Printing and export' }
] as const;
export type InterestFeature = (typeof INTEREST_FEATURES)[number]['id'];

/**
 * The other studios a person can say they would try (stored in `product_interests`). Only studios that exist are
 * offered: Code Studio was retired on 2026-10-22 (docs/decisions/0005-retire-code-studio.md). `comic_studio` and
 * `code_studio` stay accepted from older open tabs (STUDIO_IDS) but are not asked any more.
 */
export const INTEREST_STUDIOS = [
  { id: 'chat_studio', label: 'Chat Studio' },
  { id: 'stream_studio', label: 'Stream Studio' },
  { id: 'dashboards', label: 'Dashboards' }
] as const;
export type InterestStudio = (typeof INTEREST_STUDIOS)[number]['id'] | 'comic_studio' | 'code_studio';
const STUDIO_IDS: readonly string[] = ['comic_studio', 'code_studio', ...INTEREST_STUDIOS.map((s) => s.id)];
const FEATURE_IDS: readonly string[] = INTEREST_FEATURES.map((f) => f.id);

export const INTEREST_LIMITS = {
  /** Most entries a features or studios list may carry before the server refuses the request. */
  listMax: 16,
  otherMax: 120,
  commentMax: 1000,
  firstNameMax: 80,
  /** The surface tag (a path or a name); cut, never refused, since the person never typed it. */
  sourceMax: 200
} as const;

/** The comment's counter turns from the plain limit into a running count from here. */
export const INTEREST_COUNT_FROM = 800;

// C0 and C1 controls, DEL, the line and paragraph separators, the bidi marks (U+061C, U+200E, U+200F) and the bidi
// embedding, override and isolate controls, the invisible format characters (zero-width space U+200B, word joiner and
// invisible operators U+2060-U+2064, the deprecated format controls U+206A-U+206F, the interlinear annotation marks
// U+FFF9-U+FFFB) and the byte order mark. Zero-width non-joiner and joiner (U+200C, U+200D) stay: scripts and emoji
// need them. Tag characters (U+E0000-U+E007F, invisible but readable by software) are removed in a second pass.
const CONTROLS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
const CONTROLS_BUT_NEWLINE =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

/** One line of text: every control becomes a space, runs of spaces become one, ends trimmed; tag characters go. */
export const cleanLine = (value: string): string =>
  value.replace(TAG_CHARACTERS, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();

/** A short note: line breaks kept (as \n, at most one blank line in a row), tabs as spaces, other controls dropped. */
export const cleanBlock = (value: string): string =>
  value
    .replace(TAG_CHARACTERS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROLS_BUT_NEWLINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Known ids only, each once, in the order given. */
export const knownFeatures = (list: readonly unknown[]): InterestFeature[] =>
  [...new Set(list.filter((v): v is string => typeof v === 'string' && FEATURE_IDS.includes(v)))] as InterestFeature[];
export const knownStudios = (list: readonly unknown[]): InterestStudio[] =>
  [...new Set(list.filter((v): v is string => typeof v === 'string' && STUDIO_IDS.includes(v)))] as InterestStudio[];

/** The optional answers, already cleaned. Every field is optional; the email alone always submits. */
export interface InterestAnswers {
  firstName?: string;
  features?: InterestFeature[];
  /** A short "something else" beside the features. */
  featureOther?: string;
  studios?: InterestStudio[];
  comment?: string;
}

/** The version stamp inside `metadata.answers`, so a later reader knows which questions were asked. */
export const INTEREST_ANSWERS_VERSION = 1;

/**
 * The row's `metadata`: `{ source?, answers? }`, with `answers` only when something was answered.
 * Both paths store exactly this.
 */
export const interestMetadata = (source: string | undefined, answers: InterestAnswers): Record<string, unknown> => {
  const stored = {
    ...(answers.features?.length ? { features: answers.features } : {}),
    ...(answers.featureOther ? { other: answers.featureOther } : {}),
    ...(answers.studios?.length ? { studios: answers.studios } : {}),
    ...(answers.comment ? { comment: answers.comment } : {}),
    ...(answers.firstName ? { firstName: answers.firstName } : {})
  };
  return {
    ...(source ? { source } : {}),
    ...(Object.keys(stored).length ? { answers: { v: INTEREST_ANSWERS_VERSION, ...stored } } : {})
  };
};

/**
 * The thank-you a saved address gets, per kind, whichever path saved it. It promises no email. Register interest
 * mentions the answers only when some were given: that depends on what was sent, never on the address.
 */
export const INTEREST_THANKS = {
  access: 'Thank you, you are on the list.',
  accessWithAnswers: 'Thank you, you are on the list. Your answers help shape what we build next.',
  updates: 'Thank you, you are on the list.'
} as const;

/** True when any optional answer was given (after cleaning). */
export const hasInterestAnswers = (answers: InterestAnswers): boolean =>
  Boolean(answers.firstName || answers.features?.length || answers.featureOther || answers.studios?.length || answers.comment);

/** The thank-you for one saved registration: by kind, and for register interest by whether answers came with it. */
export const interestThanks = (kind: 'access' | 'updates', answers: InterestAnswers = {}): string =>
  kind === 'updates' ? INTEREST_THANKS.updates : hasInterestAnswers(answers) ? INTEREST_THANKS.accessWithAnswers : INTEREST_THANKS.access;

/**
 * The main site's list card (kind 'updates', HomePage "stay-updated"). Nothing is sent while interest emails are off
 * (the server's INTEREST_EMAILS), so the card promises no email, updates or invites; it says plainly that none go out
 * yet. Change it with the switch, if emails are ever turned on.
 */
export const UPDATES_CARD = {
  eyebrow: 'Join the list',
  title: 'Interested in Stream Studio?',
  body: 'Leave your email and it goes on the Stream Studio list. We are not sending any emails yet, so nothing will arrive for now.',
  button: 'Add me to the list'
} as const;
