// Register your interest: the optional questions, their caps, the text cleaning and the one stored shape,
// in one place for the server route (server/src/routes/newsletter.ts, which validates and refuses
// oversize) and the form's direct save (services/waitlist.ts, used when the server cannot answer), so a
// row reads the same whichever path wrote it. Pure module: no imports, safe in the browser, the server and
// tests.
//
// Storage needs no schema change: the answers ride in the existing `metadata` jsonb column of
// public.waitlist_signups as `metadata.answers` (see interestMetadata). The server also copies the comment
// into the existing `feedback` column and the studio picks into `product_interests`.

/** "What would you use?": Comic Studio abilities and what is close behind them. */
export const INTEREST_FEATURES = [
  { id: 'chat', label: 'Making a comic by chatting' },
  { id: 'translations', label: 'Translations into other languages' },
  { id: 'series', label: 'Series and collections' },
  { id: 'library', label: 'Publishing to the public Library' },
  { id: 'print', label: 'Printing and export' }
] as const;
export type InterestFeature = (typeof INTEREST_FEATURES)[number]['id'];

/**
 * The other studios the form already offered before this change (as "first access" picks). Still offered
 * and still stored in `product_interests`; `comic_studio` stays accepted from older open tabs but is not
 * asked any more (the whole form is about Comic Studio).
 */
export const INTEREST_STUDIOS = [
  { id: 'chat_studio', label: 'Chat Studio' },
  { id: 'code_studio', label: 'Code Studio' },
  { id: 'stream_studio', label: 'Stream Studio' },
  { id: 'dashboards', label: 'Dashboards' }
] as const;
export type InterestStudio = (typeof INTEREST_STUDIOS)[number]['id'] | 'comic_studio';
const STUDIO_IDS: readonly string[] = ['comic_studio', ...INTEREST_STUDIOS.map((s) => s.id)];
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

// C0 and C1 controls, DEL, the line and paragraph separators, the bidi embedding, override and isolate
// controls, and the byte order mark. Zero-width joiners stay: scripts and emoji need them.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const CONTROLS_BUT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** One line of text: every control becomes a space, runs of spaces become one, ends trimmed. */
export const cleanLine = (value: string): string => value.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();

/** A short note: line breaks kept (as \n, at most one blank line in a row), tabs as spaces, other controls dropped. */
export const cleanBlock = (value: string): string =>
  value
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

/** The one thank-you every saved address gets, per kind, whichever path saved it. It promises no email. */
export const INTEREST_THANKS = {
  access: 'Thank you, you are on the list. Your answers help shape what we build next.',
  updates: 'Thank you, you are on the list.'
} as const;
