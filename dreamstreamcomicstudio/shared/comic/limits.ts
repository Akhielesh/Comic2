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
  docBytesWarn: 2_000_000, // session logs comic_doc_bytes above this
  docBytesMax: 6_000_000 // session refuses commits that would exceed this (409 LIMIT)
} as const;
export type DocLimitKey = keyof typeof DOC_LIMITS;
