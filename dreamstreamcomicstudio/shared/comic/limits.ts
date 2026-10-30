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
  /** Named saves that write a new row, per hour per comic (automatic captures are never throttled). */
  savesPerHour: 30,
  /** Name / note / label lengths (comic_versions checks). */
  nameChars: 80,
  noteChars: 280,
  labelChars: 160
} as const;
export type HistoryLimitKey = keyof typeof HISTORY_LIMITS;

// --- Ship 2 (K2a; pro plan §5.5): one constant each, so a change is a one-line edit ---

/** The editor's caps (pro plan §5.5). Boxes are page fractions; rotations are degrees. */
export const EDITOR_LIMITS = {
  /** Overlays (image or shape layers) per page. */
  layersPerPage: 24,
  /** Extra image sources a page's frames may show besides its own drawing (another take, an uploaded image). */
  sourcesPerPage: 2,
  /** Shortest side of a panel frame. */
  frameMin: 0.04,
  /** Largest crop zoom inside a frame (fit.s is 1..fitZoomMax). */
  fitZoomMax: 4,
  /** Panel cuts kept per drawing. */
  maxCuts: 12,
  /** Balloon rotation, ± degrees. */
  balloonRot: 45,
  /** Overlay rotation, ± degrees. */
  layerRot: 180,
  /** Tallest a balloon's minimum height may be (page fraction). */
  minHMax: 0.6,
  /** Unsent edits kept on the device (C3). */
  outboxOpsMax: 2000,
  outboxDays: 7,
  undoPersistMax: 100,
  /** Detection confidence at or above which a cut is trusted. */
  detectConfOk: 0.85,
  /** A panel enlarged past this reads soft; past upscaleBad it reads blurry. */
  upscaleSoft: 1.5,
  upscaleBad: 2.0
} as const;
export type EditorLimitKey = keyof typeof EDITOR_LIMITS;

/** Consistency caps (pro plan §5.5). */
export const CONSISTENCY_LIMITS = {
  scenes: 60,
  /** Characters whose state a page's continuity changes. */
  castChanges: 12,
  propChanges: 8,
  notes: 3,
  directionBackground: 4,
  findings: 16,
  /** Keys a VersionParts record holds (panels + places + props). */
  partsKeys: 80,
  anchorKeys: 16,
  /** Place sheets one page attaches, then prop sheets (pro plan §4.2: "≤ 2 place sheets → ≤ 2 prop sheets");
   *  anchors.ts ANCHOR_CAPS.placesPerPage / propsPerPage read them. */
  placeAnchors: 2,
  propAnchors: 2,
  maxRefsDefault: 9,
  promptChars: 9000,
  recurringPages: 2,
  recurringPanels: 3
} as const;
export type ConsistencyLimitKey = keyof typeof CONSISTENCY_LIMITS;

/** Ranges and text lengths of the Ship 2 fields (pro plan §5.2). The normalizers and the server sanitizers share them. */
export const PRO_PAGE_LIMITS = {
  frameGutterMax: 0.06,
  frameMarginMax: 0.08,
  frameBorderMax: 0.02,
  frameRadiusMax: 0.04,
  /** Smallest side of an overlay, a source crop or a cut box. */
  boxMin: 0.01,
  /** Stacking order range for frames and overlays. */
  zMax: 100,
  layerNameChars: 60,
  layerStrokeMax: 0.05,
  layerRadiusMax: 0.5,
  cutNoteChars: 160,
  sceneNameChars: 60,
  sceneTextChars: 120,
  continuityTextChars: 120,
  continuityListItems: 6,
  continuityNoteChars: 160,
  directionTextChars: 160,
  directionCastTextChars: 80,
  directionListItems: 6,
  findingNoteChars: 160,
  fixInstructionChars: 400,
  anchorKeyChars: 80,
  /** consistency.skip entries (anchor keys the user unticked). */
  skipItems: 60,
  /** consistency.maxRefs ceiling: at least the largest reference count any registered model takes (models.ts
   *  IMAGE_MODELS refs.total; a contract test holds it). The comic's model lock caps the real call. */
  maxRefsMax: 16
} as const;
