// Every content cap of a Comic Studio project, in one place.
// The server enforces them (session.ts / patch sanitizers); the client pre-checks for honest UI.

export const MAX_RENDER_HISTORY = 8; // unchanged (doc.ts re-exports)
export const MAX_SPEND_ENTRIES = 200; // unchanged
export const MAX_CONVERSATION = 160; // unchanged
export const MAX_ARCHIVE = 300; // decisions-final #8 (per project)
export const MAX_TRASH = 20;
export const MAX_BALLOON_SNAPSHOT = 40; // RenderVersion.balloons length cap

/** Every content cap. The server enforces (session.ts/sanitizers); the client pre-checks for honest UI. */
export const DOC_LIMITS = {
  pages: 40, // decisions-final #7; StudioCaps.maxPages may only lower it
  cast: 40,
  places: 30,
  panelsPerPage: 9,
  linesPerPanel: 8,
  refsPerCharacter: 12, // was session.ts refsPerEntity (places now 8)
  refsPerPlace: 8,
  refsStyle: 8,
  refInbox: 24,
  refsProject: 150, // style + cast + places + inbox (conversation attachments excluded)
  imagesPerMessage: 12,
  textFilesPerMessage: 6,
  nextSteps: 6,
  editions: 19,
  glossaryTerms: 200,
  lineIdsPerOp: 80,
  reorderIds: 200,
  lineStyleBytes: 2048, // JSON size of one Line.style
  translationChars: 600,
  refNoteChars: 140,
  refNameChars: 80,
  chapterTitleChars: 60,
  readerTextChars: 140, // ReaderSettings.credits / dedication
  bookBlurbChars: 600,
  bookCredits: 8,
  bookCreditChars: 120,
  translateLineIds: 200, // SpendAction 'translate' lineIds (per-line re-translate)
  modelChanges: 20, // ImageModelLock.changes kept (newest first; models.md §3.3)
  docBytesWarn: 2_000_000, // session logs comic_doc_bytes above this
  docBytesMax: 6_000_000 // session refuses commits that would exceed this (409 LIMIT)
} as const;
export type DocLimitKey = keyof typeof DOC_LIMITS;

// --- history (versions plan §3.3; decisions V-1): one constant each, so a change is a one-line edit ---

/** "Try another version": lines per comic including "Original" (V-1: inside one comic, at most 5). */
export const MAX_ALTERNATIVES = 5;

/** Comic History caps (retention §4.4, moments §4.3, abuse §12). */
export const HISTORY_LIMITS = {
  /** Automatic (unpinned) rows kept per comic; thinning beyond it posts a notice. */
  unpinnedRows: 300,
  /** Named versions per comic (kept forever). */
  namedRows: 100,
  alternatives: MAX_ALTERNATIVES,
  /** Per-comic budget of kept `bytes_new`; above it the oldest unpinned rows are thinned, with a notice. */
  bytesPerComic: 25_000_000,
  changesPerRow: 60,
  thumbsPerRow: 8,
  /** Quiet editing: a user-only `edits` row after this many minutes, commits or pages touched. */
  quietEditMinutes: 10,
  quietEditCommits: 25,
  quietEditPages: 3,
  /** The first commit after this long a gap captures the state before it. */
  gapMinutes: 30,
  /** Consecutive AI commits at most this far apart (no user commit between) are one run. */
  aiRunGapMinutes: 10,
  /** A before-restore row is kept at least this long. */
  beforeRestoreDays: 30,
  /** Saves (named + automatic writes) per hour per comic. */
  savesPerHour: 30,
  /** Name / note / label lengths (comic_versions checks). */
  nameChars: 80,
  noteChars: 280,
  labelChars: 160
} as const;
export type HistoryLimitKey = keyof typeof HISTORY_LIMITS;
