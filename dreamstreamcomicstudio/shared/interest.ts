// Register your interest: the optional questions, their caps, the text cleaning and the one stored shape,
// in one place for the server route (server/src/routes/newsletter.ts, which validates and refuses
// oversize) and the form's direct save (services/waitlist.ts, used when the server cannot answer), so a
// row reads the same whichever path wrote it. Pure module: no imports, safe in the browser, the server and
// tests.
//
// The questions are ones a visitor can answer without knowing the product: what they would like to make, how
// they heard about us, anything else, and one unticked box to be kept updated. (Version 1 also asked which
// Comic Studio abilities they wanted and which "other studios" they would try; nothing on the page said what
// those studios were, so the question was dropped. Rows stored then keep their `answers.v: 1` shape.)
//
// Storage needs no schema change: the answers ride in the existing `metadata` jsonb column of
// public.waitlist_signups as `metadata.answers`, the box as `metadata.consent` (see interestMetadata). The
// server also copies the note into the existing `feedback` column.

/** The question above INTEREST_MAKES. */
export const INTEREST_MAKES_QUESTION = 'What would you like to make?';

/** INTEREST_MAKES_QUESTION's quick picks: kinds of comic, in a visitor's words. */
export const INTEREST_MAKES = [
  { id: 'short_story', label: 'A short story' },
  { id: 'kids', label: 'A comic for kids' },
  { id: 'webcomic', label: 'A webcomic series' },
  { id: 'pitch', label: 'A pitch or storyboard' },
  { id: 'work', label: 'Something for work' }
] as const;
export type InterestMake = (typeof INTEREST_MAKES)[number]['id'];

/** The free-text note under the quick picks (stored as `comment`). */
export const INTEREST_OTHER_LABEL = 'Anything else?';

/** The one-choice question. */
export const INTEREST_HEARD_QUESTION = 'How did you hear about us?';
export const INTEREST_HEARD = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'friend', label: 'A friend' },
  { id: 'search', label: 'Search' },
  { id: 'social', label: 'Social media' },
  { id: 'other', label: 'Other' }
] as const;
export type InterestHeard = (typeof INTEREST_HEARD)[number]['id'];

/**
 * The one consent box, unticked by default. Nothing is sent while interest emails are off (the server's
 * INTEREST_EMAILS), and no email path reads this flag; it only records the choice, with its time and these exact
 * words (interestMetadata). A yes here is a request from an address nobody has verified (anyone can type any
 * address, and the form's direct save can write any metadata), so it is never enough to mail news: a later sender
 * first sends a confirm link and mails only the addresses that confirm it (docs/features/register-interest.md).
 */
export const INTEREST_UPDATES = {
  label: 'Keep me updated about Comic Studio news and new DreamStream studios.',
  hint: 'Choose this if you would like to hear about future releases.'
} as const;

const MAKE_IDS: readonly string[] = INTEREST_MAKES.map((m) => m.id);
const HEARD_IDS: readonly string[] = INTEREST_HEARD.map((h) => h.id);

export const INTEREST_LIMITS = {
  /** Most entries the quick-picks list may carry before the server refuses the request. */
  listMax: 16,
  commentMax: 1000,
  firstNameMax: 80,
  /** The surface tag (a path or a name); cut, never refused, since the person never typed it. */
  sourceMax: 200
} as const;

/** The note's counter turns from the plain limit into a running count from here. */
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
export const knownMakes = (list: readonly unknown[]): InterestMake[] =>
  [...new Set(list.filter((v): v is string => typeof v === 'string' && MAKE_IDS.includes(v)))] as InterestMake[];
/** A known "how did you hear" id, or nothing. */
export const knownHeard = (value: unknown): InterestHeard | undefined =>
  typeof value === 'string' && HEARD_IDS.includes(value) ? (value as InterestHeard) : undefined;

/** The optional answers, already cleaned. Every field is optional; the email alone always submits. */
export interface InterestAnswers {
  firstName?: string;
  /** "What would you like to make?" quick picks. */
  makes?: InterestMake[];
  heardFrom?: InterestHeard;
  /** "Anything else?" */
  comment?: string;
  /**
   * The keep-me-updated box. The register-interest form always carries it (false unless ticked: answersForKind); the
   * main site's list card never does. It is a choice, not an answer: it never adds `answers` on its own.
   */
  keepUpdated?: boolean;
}

/** The version stamp inside `metadata.answers`, so a later reader knows which questions were asked (1: the old set). */
export const INTEREST_ANSWERS_VERSION = 2;

/**
 * The answers as a kind sends them: register interest (`access`) always says whether the box was ticked, and only a
 * real `true` counts; the list card (`updates`) has no box, so it never carries one. The form calls this before
 * either save; the server calls it only when the request carried the box (an older tab never showed it, so no
 * choice is recorded for it).
 */
export const answersForKind = (kind: 'access' | 'updates', answers: InterestAnswers): InterestAnswers => {
  const { keepUpdated, ...rest } = answers;
  return kind === 'access' ? { ...rest, keepUpdated: keepUpdated === true } : rest;
};

/**
 * The row's `metadata`: `{ source?, answers?, consent? }`. `answers` only when something was answered;
 * `consent: { updates, at, wording }` whenever the box was part of the form (register interest), false unless it was
 * ticked, with the time the choice was sent and the words the person saw. Both paths store exactly this.
 */
export const interestMetadata = (
  source: string | undefined,
  answers: InterestAnswers,
  at: string = new Date().toISOString()
): Record<string, unknown> => {
  const stored = {
    ...(answers.makes?.length ? { makes: answers.makes } : {}),
    ...(answers.heardFrom ? { heardFrom: answers.heardFrom } : {}),
    ...(answers.comment ? { comment: answers.comment } : {}),
    ...(answers.firstName ? { firstName: answers.firstName } : {})
  };
  return {
    ...(source ? { source } : {}),
    ...(Object.keys(stored).length ? { answers: { v: INTEREST_ANSWERS_VERSION, ...stored } } : {}),
    ...(answers.keepUpdated !== undefined
      ? { consent: { updates: answers.keepUpdated === true, at, wording: INTEREST_UPDATES.label } }
      : {})
  };
};

/**
 * The thank-you a saved address gets, per kind, whichever path saved it. It promises no email. Register interest
 * mentions the answers only when some were given, and adds `keptUpdated` only when the box was ticked: both depend on
 * what was sent, never on the address.
 */
export const INTEREST_THANKS = {
  access: 'Thank you, you are on the list.',
  accessWithAnswers: 'Thank you, you are on the list. Your answers help shape what we build next.',
  updates: 'Thank you, you are on the list.',
  /** Confirms the saved preference, independent of the mailer's current setting. */
  keptUpdated: 'Your preference for updates is saved.'
} as const;

/** True when any optional answer was given (after cleaning). The box is a choice, not an answer. */
export const hasInterestAnswers = (answers: InterestAnswers): boolean =>
  Boolean(answers.firstName || answers.makes?.length || answers.heardFrom || answers.comment);

/** The thank-you for one saved registration: by kind, and for register interest by what was sent. */
export const interestThanks = (kind: 'access' | 'updates', answers: InterestAnswers = {}): string => {
  if (kind === 'updates') return INTEREST_THANKS.updates;
  const base = hasInterestAnswers(answers) ? INTEREST_THANKS.accessWithAnswers : INTEREST_THANKS.access;
  return answers.keepUpdated === true ? `${base} ${INTEREST_THANKS.keptUpdated}` : base;
};

/**
 * The main site's list card (kind 'updates', HomePage "stay-updated"). It describes the
 * registration independently of the server's mail settings.
 */
export const UPDATES_CARD = {
  eyebrow: 'Join the list',
  title: 'Interested in Stream Studio?',
  body: 'Leave your email to join the Stream Studio interest list.',
  button: 'Add me to the list'
} as const;
