
export type AspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
export type ImageResolution = "1K" | "2K" | "4K";
export type ImageProviderId = "flux" | "gemini" | "ideogram";

export type ImageModelDefinition = {
  id: string;
  label: string;
  provider: ImageProviderId;
  supportsReferences: boolean;
  supportsAspectRatio: boolean;
  defaultSteps?: number;
  isFree?: boolean;
  minimumPlanTier?: 'pro';
};

export interface AppSettings {
  imageProvider: ImageProviderId;
  fluxKeySuffix?: string;
  lockedProvider?: ImageProviderId | null;
}

export type StoryBuilderState = {
  templateId?: string;
  genre?: string;
  tone?: string;
  setting?: string;
  characters?: string;
  conflict?: string;
  ending?: string;
  length?: 'short' | 'medium' | 'long';
  outline?: string;
  draftScript?: string;
  lastUpdatedAt?: number;
};

export type SettingsState = {
  showGeminiKey?: boolean;
  showFluxKey?: boolean;
  modelRouting?: Record<string, string>;
  defaultImageModel?: string;
  defaultTextModel?: string;
  defaultTextModelKey?: string;
};

export type TestLabRunStep = {
  id: string;
  kind: "script" | "style" | "world" | "panel" | "cover" | "regen";
  prompt: string;
  promptChars: number;
  provider?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  startAt: number;
  endAt: number;
  durationMs: number;
  apiMs?: number;
  saveMs?: number;
  totalMs?: number;
  success: boolean;
  error?: string;
  outputImageBytes?: number;
  outputImageId?: string;
};

export type TestLabRun = {
  id: string;
  createdAt: number;
  templateId?: string;
  steps: TestLabRunStep[];
  totalDurationMs: number;
  notes?: string;
  report?: TestLabRunReport;
};

export type TestLabMetrics = {
  totalRuns: number;
  totalSteps: number;
  successRate: number;
  avgDurationMs: Record<string, number>;
  avgPromptChars: Record<string, number>;
  lastErrors: Array<{ id: string; kind: string; error: string; at: number }>;
};

export type TestLabRunReport = {
  generatedAt: number;
  markdown: string;
  json: Record<string, unknown>;
  aiAnalysis?: string;
  model?: string;
};

export type LearnProgress = {
  moduleId: string;
  completedLessons: string[];
  lastLessonId?: string;
  updatedAt: number;
};

export type LearnModuleStatus = {
  moduleId: string;
  completed: number;
  total: number;
  updatedAt?: number;
};

export type ReaderState = {
  projectId: string;
  mode: "scroll" | "flip";
  pageIndex?: number;
  scrollTop?: number;
  updatedAt: number;
};

export type DialogueBlock = {
  id: string;
  kind: 'speech' | 'caption' | 'narration';
  speaker?: string;
  text: string;
  side?: 'left' | 'right' | 'center';
  position?: { x: number; y: number }; // Percentage 0-100
  style?: 'speech' | 'thought' | 'shout' | 'whisper' | 'caption';
};

export type TextLayout = 'caption' | 'speech_bubbles' | 'chat_bubbles' | 'none';

export type ModelPricing = {
  inputPer1k?: number;
  outputPer1k?: number;
  imagePerOutput?: number;
};

export interface PricingConfig {
  currency: string;
  models: Record<string, ModelPricing>;
}

export interface ProjectReport {
  ai_usage: {
    totalArtifacts: number;
    totalTokens: number;
    byModel: Record<string, { tokens: number; cost: number }>;
    byStage: Record<string, { tokens: number; cost: number }>;
    byType: Record<string, { tokens: number; cost: number }>;
    artifacts: Array<{
      id: string;
      stage: string;
      type: string;
      model: string;
      provider?: string;
      promptChars: number;
      promptTokens: number;
      candidatesTokens: number;
      totalTokens: number;
      outputImageId?: string;
      inputImageIds?: string[];
      success?: boolean;
      error?: string;
      aspectRatio?: string;
      resolution?: string;
      timings?: {
        apiMs?: number;
        saveMs?: number;
        totalMs?: number;
        durationMs?: number;
      };
      meta?: Record<string, unknown>;
      cost: { currency: string; value: number; isEstimated: boolean };
    }>;
  };
  cost_summary: {
    currency: string;
    totalCost: number;
    estimatedArtifactCount: number;
    byModel: Record<string, { tokens: number; cost: number }>;
    byStage: Record<string, { tokens: number; cost: number }>;
    byType: Record<string, { tokens: number; cost: number }>;
  };
  storage: {
    imageCount: number;
    imageBytes: number;
    artifactsCount: number;
    panelsCount: number;
    indexedDb?: Record<string, unknown>;
  };
}

export interface Scene {
  id: number;
  rawText: string;
  synopsis: string;
  characters: string[];
  setting: string;
}

export type ComicBookFormFactor =
  | 'us_comic'
  | 'manga_tankobon'
  | 'european_album'
  | 'webtoon_vertical'
  | 'trade_paperback'
  | 'custom';

export interface StoryPlanningState {
  formFactor: ComicBookFormFactor;
  customFormFactorNote?: string;
  recommendedRange: {
    min: number;
    max: number;
  };
  userRange: {
    min: number;
    max: number;
  };
  recommendedPageCount: number;
  approvedPageCount?: number;
  feasibility: {
    status: 'ok' | 'tight' | 'insufficient';
    reason: string;
    estimatedPanels: {
      min: number;
      max: number;
    };
  };
  estimatedCostRange: {
    currency: string;
    minUsd: number;
    maxUsd: number;
  };
  approved: boolean;
  approvedAt?: number;
  resumeStep?: number;
}

export type PipelineMode = 'classic' | 'comicforge' | 'pagestudio';

/**
 * PageStudio — the single-sheet generation engine.
 *
 * Instead of generating N panels and assembling them, PageStudio generates one
 * full comic page (panels, gutters, lettering baked into a single high-res image)
 * from a confirmed style + layout brief, then patches specific regions with
 * image-editing models. This is the new default creation flow.
 */
export interface PageStudioStyle {
  /** How the style was provided. */
  source: 'image' | 'text';
  /** User's raw text style prompt (when source === 'text' or as an addendum). */
  prompt?: string;
  /** Data URL of an uploaded style reference image (kept for re-use as a generation reference). */
  referenceDataUrl?: string;
  /** AI-understood style descriptor produced from the image/text — shown to the user to confirm. */
  brief?: string;
  /** Short descriptive tags extracted from the reference (palette, linework, era, medium…). */
  tags?: string[];
  /** Whether the user has confirmed this is the direction they want. */
  confirmed?: boolean;
  /** Optional sample image (data URL) generated to verify the direction before committing. */
  sampleDataUrl?: string;
}

export interface PageStudioLayout {
  /** How the layout was provided. */
  source: 'reference' | 'preset' | 'auto';
  /** Data URL of an uploaded comic-page layout reference. */
  referenceDataUrl?: string;
  /** AI-extracted layout/caption/font brief describing the page structure exactly. */
  brief?: string;
  /** Built-in preset id when source === 'preset'. */
  presetId?: string;
}

export interface PageStudioEdit {
  id: string;
  instruction: string;
  /** Resulting image after the edit (persisted url and/or data url). */
  imageUrl?: string;
  imageId?: string;
  createdAt: number;
}

export interface PageStudioPage {
  id: string;
  /** The original full-page generation prompt. */
  prompt: string;
  /** Latest image for this page (after any edits). */
  imageUrl?: string;
  imageId?: string;
  /** First-generation image, retained so edits can be undone back to the base. */
  baseImageUrl?: string;
  edits: PageStudioEdit[];
  createdAt: number;
}

export interface PageStudioState {
  brief: string;
  style: PageStudioStyle;
  layout: PageStudioLayout;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  pages: PageStudioPage[];
  activePageId?: string;
  /** Current high-level stage of the studio flow. */
  stage?: 'brief' | 'style' | 'layout' | 'generate' | 'edit';
}

export enum ComicForgeStage {
  FORMAT_SETUP = 'format_setup',
  SCRIPT_ANALYSIS = 'script_analysis',
  STORY_ARCHITECTURE = 'story_architecture',
  STYLE_SELECTION = 'style_selection',
  ASSET_LIBRARY = 'asset_library',
  LAYOUT_SYSTEM = 'layout_system',
  STORYBOARD = 'storyboard',
  PREVIEW_PACK = 'preview_pack',
  GENERATION = 'generation',
  QC_REVIEW = 'qc_review',
  EXPORT = 'export'
}

export type ComicForgeApprovalGate = {
  stage: ComicForgeStage;
  approved: boolean;
  approvedAt?: number;
};

export type ComicForgeFormatSpec = {
  readingFormat: 'print' | 'webtoon_vertical' | 'digital_paged' | 'social_shorts';
  platform: 'webtoon' | 'tapas' | 'print_a4' | 'print_us_letter' | 'pdf_portfolio' | 'instagram';
  resolutionTarget: 'screen_72' | 'print_300' | 'screen_hd_150';
  rtlReading: boolean;
  canvasWidthPx: number;
  canvasHeightPx: number;
  panelDensityMax: number;
  safeTextSizeMinPt: number;
  bleedPx: number;
  trimPx: number;
  safeAreaPx: number;
  gutterMinPx: number;
  exportPresets: string[];
  warnings: string[];
};

export type ComicForgeAmbiguityFlag = {
  id: string;
  type: 'speaker_unclear' | 'location_unclear' | 'timeline_gap';
  page: number;
  panel: number;
  description: string;
  resolved?: boolean;
  resolution?: string;
};

export type ComicForgeStructuredPanel = {
  panelIndex: number;
  description: string;
  dialogue: Array<{ speaker: string; text: string; order: number }>;
  captions: Array<{ text: string; order: number }>;
  sfx: Array<{ text: string; style: string }>;
  cameraShotSuggestion: 'close-up' | 'medium' | 'wide' | 'extreme-close' | 'bird-eye' | 'worm-eye' | 'over-shoulder';
  timeOfDay: string;
  locationName: string;
};

export type ComicForgeStructuredPage = {
  page: number;
  panels: ComicForgeStructuredPanel[];
};

export type ComicForgeStructuredScriptAnalysis = {
  structuredScript: ComicForgeStructuredPage[];
  sceneList: Array<{ sceneId: string; name: string; location: string; time: string; pagesInvolved: number[] }>;
  castList: Array<{ name: string; role?: string; firstAppearancePage: number; descriptionHints?: string }>;
  propList: Array<{ name: string; firstAppearancePage: number; descriptionHints?: string }>;
  ambiguityFlags: ComicForgeAmbiguityFlag[];
  tone: string;
  genre: string;
  estimatedPanelCount: number;
  dialogueDensityScore: number;
  actionDensityScore: number;
};

export type ComicForgeBeat = {
  beatId: string;
  name: string;
  type: 'setup' | 'conflict' | 'escalation' | 'twist' | 'climax' | 'resolution';
  scenesInvolved: string[];
};

export type ComicForgePagePlanRow = {
  pageNumber: number;
  purpose: 'setup' | 'action' | 'dialogue' | 'twist' | 'payoff' | 'transition';
  scenesOnThisPage: string[];
  panelCountSuggestion: number;
  cliffhanger: boolean;
  pacingNote: string;
  dialogueHeavy: boolean;
  warnings: string[];
};

export type ComicForgeStoryArchitecture = {
  beatSheet: ComicForgeBeat[];
  suggestedPageCount: number;
  pagePlan: ComicForgePagePlanRow[];
  globalWarnings: string[];
};

export type ComicForgeStyleRecommendation = {
  styleName: string;
  rationale: string;
  conflictWarnings: string[];
  stylePromptSeed: string;
};

export type ComicForgeStyleBible = {
  baseGenerationPromptFragment: string;
  lineQuality: 'clean' | 'scratchy' | 'bold' | 'minimal';
  shadingMode: 'flat' | 'cel' | 'painterly' | 'crosshatch' | 'none';
  colorPalette: {
    primary: string[];
    accent: string[];
    forbidden: string[];
    moodRules: string;
  };
  backgroundDetail: 'full' | 'suggested' | 'minimal' | 'none';
  cameraLanguage: 'cinematic' | 'flat' | 'dynamic' | 'manga-dynamic';
  sfxTypographyStyle: string;
  negativePromptFragment: string;
  conflictWarnings: string[];
};

export type ComicForgeAssetCardType = 'character' | 'location' | 'prop' | 'vehicle' | 'sfx';

export type ComicForgeAssetReference = {
  angle: string;
  imageId?: string;
  imageUrl?: string;
  label: 'canonical' | 'variant';
};

export type ComicForgeAssetCard = {
  id: string;
  cardType: ComicForgeAssetCardType;
  name: string;
  canonicalDescription: string;
  doNotChange: string[];
  negativeConstraints: string[];
  allowedVariants: string[];
  referenceImages: ComicForgeAssetReference[];
  consistencyMethod: 'reference_injection' | 'lora';
  hash?: string;
  status: 'draft' | 'reference_generated' | 'locked';
};

export type ComicForgeBalloonZone = {
  panelIdx: number;
  zones: Array<{ xPct: number; yPct: number; wPct: number; hPct: number; purpose: 'balloon' | 'caption' | 'sfx' }>;
};

export type ComicForgeLayoutTemplate = {
  id: string;
  name: string;
  panelCount: number;
  gridDefinition: Array<{
    colStart: number;
    colEnd: number;
    rowStart: number;
    rowEnd: number;
    aspectRatio?: number;
  }>;
  gutterPx: number;
  captionStyle: 'box' | 'borderless';
  balloonStyle: 'round' | 'spiky' | 'cloud' | 'rectangular';
  sfxStyle: string;
  source: 'preset' | 'user_upload' | 'extracted';
  previewImageUrl?: string;
};

export type ComicForgeStoryboardValidation = {
  pass: boolean;
  pageLevelWarnings: string[];
  panelLevelWarnings: Array<{ pageNumber: number; panelIndex: number; message: string }>;
};

export type ComicForgePreviewPack = {
  totalPages: number;
  totalPanels: number;
  estimatedDialogueBalloons: number;
  estimatedCosts: {
    thumbnailsUsd: number;
    draftUsd: number;
    finalUsd: number;
    exportUpscaleUsd: number;
    totalUsd: number;
  };
  estimatedDurationSeconds: number;
  pageBreakdown: Array<{
    pageNumber: number;
    title: string;
    purpose: ComicForgePagePlanRow['purpose'];
    panelCount: number;
    warnings: string[];
    estimatedPageCostUsd: number;
  }>;
  globalWarnings: string[];
};

export type ComicForgeQCFlag = {
  panelId: string;
  checkType: 'consistency' | 'continuity' | 'reading_order' | 'legibility' | 'print_safety';
  severity: 'warn' | 'fail';
  message: string;
  suggestion?: string;
};

export type ComicForgeQCReport = {
  pageId: string;
  pagePassed: boolean;
  panelFlags: ComicForgeQCFlag[];
};

export type ComicForgeExportPreset =
  | 'webtoon_episode'
  | 'tapas_episode'
  | 'print_a4_300dpi'
  | 'print_us_letter_300dpi'
  | 'digital_pdf'
  | 'social_cover_crop'
  | 'character_card_export';

export type ComicForgeJobSummary = {
  id: string;
  taskType: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: number;
  createdAt: number;
  completedAt?: number;
  errorMessage?: string;
  result?: Record<string, unknown>;
};

export type ComicForgeCostTracker = {
  currency: string;
  estimatedUsd: number;
  actualUsd: number;
  byTaskType: Record<string, number>;
};

export type ComicForgeState = {
  stage: ComicForgeStage;
  maxStageReached: ComicForgeStage;
  approvals: ComicForgeApprovalGate[];
  lastJobId?: string;
  formatSpec?: ComicForgeFormatSpec;
  scriptInput?: string;
  analysis?: ComicForgeStructuredScriptAnalysis;
  architecture?: ComicForgeStoryArchitecture;
  styleRecommendations?: ComicForgeStyleRecommendation[];
  styleBible?: ComicForgeStyleBible;
  assetCards?: ComicForgeAssetCard[];
  layoutTemplate?: ComicForgeLayoutTemplate;
  balloonZones?: ComicForgeBalloonZone[];
  storyboardValidation?: ComicForgeStoryboardValidation;
  previewPack?: ComicForgePreviewPack;
  qcReports?: ComicForgeQCReport[];
  selectedExportPreset?: ComicForgeExportPreset;
  costTracker?: ComicForgeCostTracker;
  updatedAt: number;
};

export const COMICFORGE_STAGE_ORDER: ComicForgeStage[] = [
  ComicForgeStage.FORMAT_SETUP,
  ComicForgeStage.SCRIPT_ANALYSIS,
  ComicForgeStage.STORY_ARCHITECTURE,
  ComicForgeStage.STYLE_SELECTION,
  ComicForgeStage.ASSET_LIBRARY,
  ComicForgeStage.LAYOUT_SYSTEM,
  ComicForgeStage.STORYBOARD,
  ComicForgeStage.PREVIEW_PACK,
  ComicForgeStage.GENERATION,
  ComicForgeStage.QC_REVIEW,
  ComicForgeStage.EXPORT
];

export const createDefaultComicForgeState = (): ComicForgeState => ({
  stage: ComicForgeStage.FORMAT_SETUP,
  maxStageReached: ComicForgeStage.FORMAT_SETUP,
  approvals: COMICFORGE_STAGE_ORDER.map((stage) => ({
    stage,
    approved: false
  })),
  updatedAt: Date.now()
});

export interface CharacterStructuredDetails {
  role?: string;
  ageBand?: string;
  physicalTraits?: string;
  outfit?: string;
  colorPalette?: string;
  personality?: string;
  constraints?: string;
}

export interface ItemStructuredDetails {
  itemType?: string;
  material?: string;
  condition?: string;
  scale?: string;
  visualMotif?: string;
  constraints?: string;
}

export interface LocationStructuredDetails {
  environmentType?: string;
  eraMood?: string;
  lighting?: string;
  landmarks?: string;
  palette?: string;
  constraints?: string;
}

export interface Character {
  id: string;
  name: string;
  bio: string; // Backstory/Personality
  description: string; // Visual prompt
  structured?: CharacterStructuredDetails;
  imageId?: string;
  imageUrl?: string;
  referenceImageIds: string[];
}

export interface CharacterLibraryItem extends Character {
  userId: string;
  createdAt: string;
}

export interface Item {
  id: string;
  name: string;
  description: string;
  structured?: ItemStructuredDetails;
  imageId?: string;
  imageUrl?: string;
  referenceImageIds: string[];
}

export interface Location {
  id: string;
  name: string;
  description: string;
  structured?: LocationStructuredDetails;
  imageId?: string;
  imageUrl?: string;
  referenceImageIds: string[];
}

export type ContinuityEntityKind = 'character' | 'item' | 'location';

export interface ContinuityEntity {
  id: string;
  kind: ContinuityEntityKind;
  name: string;
  description: string;
  lockedTraits: string[];
  referenceImageIds: string[];
  imageId?: string;
  required: boolean;
}

export interface SceneContinuityBinding {
  sceneId: number;
  characterIds: string[];
  itemIds: string[];
  locationId?: string;
  requiredEntityIds: string[];
}

export interface ContinuityValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  sceneId?: number;
  panelId?: string;
  entityId?: string;
}

export interface ContinuityValidationResult {
  isValid: boolean;
  missingEntityIds: string[];
  issues: ContinuityValidationIssue[];
  updatedAt: number;
}

export interface ContinuityBible {
  version: number;
  entities: ContinuityEntity[];
  sceneBindings: SceneContinuityBinding[];
  createdAt: number;
  updatedAt: number;
}

export interface PanelContinuity {
  requiredEntityIds: string[];
  referenceImageIds: string[];
  locationId?: string;
  continuityNotes?: string;
  driftScore?: number;
  validatedAt?: number;
  flaggedIssues?: string[];
}

export interface ContinuityState {
  bible: ContinuityBible;
  lockLevel: 'strict' | 'guided' | 'flexible';
  fallbackPolicy: 'auto' | 'soft_fail' | 'hard_fail';
  validation?: ContinuityValidationResult;
}

export interface ComicPanel {
  id: string;
  sceneId: number;
  description: string;
  dialogue: string;
  dialogueBlocks?: DialogueBlock[];
  prompt?: string;
  imageId?: string;
  imageUrl?: string;
  imageIdHistory: string[];
  imageUrlHistory?: string[];
  isGenerating?: boolean;
  isPlanned?: boolean;
  continuity?: PanelContinuity;
  /** Short, human-readable caption/title for this panel (e.g. "The Boat Departs"), from
   *  the breakdown. Used as the panel's label/alt instead of the raw prose prompt. */
  title?: string;
  /** Concrete subject of this panel (from the breakdown), so generation stays on-story. */
  focalSubject?: string;
  /** Camera/shot direction from the breakdown. */
  shotType?: string;
  cameraAngle?: string;
  composition?: string;
  /** Set when a panel fails during generation — allows retry */
  failureReason?: string;
  /** Style override for Live Panel Remix (future feature) */
  styleOverride?: string;
}

export interface StyleVariant {
  id: string;
  styleId?: string;
  imageId?: string;
  imageUrl?: string;
  prompt: string;
  category: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  cacheKey?: string;
  generatedAt?: number;
  timings?: {
    apiMs?: number;
    saveMs?: number;
    totalMs?: number;
  };
}

export type LayoutType =
  | 'grid'
  | 'webtoon'
  | 'strip'
  | 'manga'
  | 'cinematic'
  | 'graphic_novel'
  | 'conversation_grid'
  | 'splash_insets'
  | 'golden_ratio'
  | 'diagonal_action'
  | 'storyboard'
  | 'custom';

export interface GenerationLog {
  timestamp: number;
  message: string;
}

export interface GenerationArtifact {
  id: string;
  projectId: string;
  timestamp: number;
  type: 'text' | 'image' | 'system';
  provider?: string;
  model: string;
  prompt: string;
  responseText?: string;
  inputImageIds?: string[];
  outputImageId?: string;
  referenceCount?: number;
  fallbackOccurred?: boolean;
  fallbackFromModel?: string;
  fallbackToModel?: string;
  styleLockUsed?: boolean;
  meta?: Record<string, unknown>;
  stage?: string;
  success?: boolean;
  error?: string;
  aspectRatio?: string;
  resolution?: string;
  timings?: {
    apiMs?: number;
    saveMs?: number;
    totalMs?: number;
    durationMs?: number;
  };
  usage?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
    promptChars?: number;
    estimatedTokens?: number;
  };
  cost?: {
    currency: string;
    value: number;
    isEstimated: boolean;
  };
}

export interface GenerationStatus {
  isActive: boolean;
  progress: number; // 0-100
  startTime: number;
  estimatedTimeRemaining: string; // Formatted string e.g. "2m 30s"
  currentStepDescription: string;
  logs: GenerationLog[];
  completedPanels: number;
  totalPanels: number;
}

export interface Review {
  id: string;
  projectId: string;
  userId: string;
  rating: number; // 0.5 to 5.0
  scores: {
    story: number;
    art: number;
    characters: number;
    pacing: number;
  };
  text: string;
  createdAt: number;
  user?: {
    username: string;
    avatar_url?: string;
  };
}

/** A deterministic read of a story's emotional tone, derived from its text (see
 *  services/storyMood.ts). Used to keep style + image generation faithful to the
 *  story's mood, and logged so we can later analyse the AI's understanding. */
export interface StoryMood {
  key: string;
  label: string;
  brightness: 'dark' | 'neutral' | 'bright';
  energy: 'calm' | 'neutral' | 'high';
  /** Palette hint, e.g. "warm, sunlit, saturated". */
  palette: string;
  /** Lighting hint, e.g. "soft natural daylight". */
  lighting: string;
  /** One-line guardrail injected into image prompts so renders match the tone. */
  promptGuidance: string;
  /** Preset style ids that suit this mood, most-fitting first. */
  recommendedStyleIds: string[];
  /** Short human-readable explanation (UI + logging). */
  summary: string;
  /** 0-1 signal strength of the classification. */
  confidence: number;
}

/** A compact, persisted record of one generation run's "understanding" + outcome — what
 *  mood/style the AI used and how it turned out — so failures like "happy story rendered
 *  dark" can be analysed after the fact. Built by services/contextLog.ts. */
export interface GenerationInsight {
  generatedAt: number;
  mood?: { key: string; label: string; brightness: string; confidence: number; summary: string };
  styleId?: string;
  stylePrompt?: string;
  totals: { panels: number; rendered: number; failed: number; fallbacks: number };
  modelsUsed: string[];
  failedPanelTitles?: string[];
}

/** Immutable copy of the world/style/continuity inputs as they were when a comic was
 *  generated. Single-panel re-rolls prefer this so "patching" a panel stays faithful to the
 *  original even if the user later edits or deletes entities/styles. See generationManager. */
export interface GenerationSnapshot {
  takenAt: number;
  styleImageId?: string;
  stylePrompt?: string;
  selectedStyleId?: string;
  styleAspectRatio?: AspectRatio;
  imageResolution?: ImageResolution;
  gridTemplateId?: string;
  storyMood?: StoryMood;
  characters: Character[];
  items: Item[];
  locations: Location[];
  continuity?: ContinuityState;
}

export interface ComicState {
  pipelineMode?: PipelineMode;
  comicforge?: ComicForgeState;
  step: number;
  maxStepReached: number;
  flowVersion?: number;
  script: string;
  /** The author's free-form story intent / creative direction — what they MEAN by the story.
   *  Captured directly or via the Universal Assistant; injected into analysis, panel, and
   *  image prompts so generation honours the user's voice. */
  creativeDirection?: string;
  storyPlanning?: StoryPlanningState;
  scriptHash?: string;
  sceneHash?: string;
  worldHash?: string;
  lastResetSourceStage?: 'script_analysis' | 'story_planning_confirm' | 'style_confirm' | 'world_confirm' | 'layout_confirm';
  scriptChecklist?: {
    found: string[];
    missing: string[];
    suggestions: string[];
    updatedAt: number;
  };
  scenes: Scene[];
  continuitySummary?: string;
  /** Deterministic mood/tone read of the story (bright/dark, calm/high-energy). Drives
   *  mood-aware style recommendations + image-prompt lighting/palette so a happy story
   *  doesn't render dark & moody. Persisted for later analysis of AI understanding. */
  storyMood?: StoryMood;
  /** Rolling history (most recent last, capped) of generation-run insights for analysis. */
  generationInsights?: GenerationInsight[];
  /** World/style/continuity as captured at the last full generation, for faithful re-rolls. */
  generationSnapshot?: GenerationSnapshot;
  continuity?: ContinuityState;
  overview?: string;
  publishedAt?: number;
  comments?: ProjectComment[];
  storyBuilder?: StoryBuilderState;
  isFeatured?: boolean;
  coverImageId?: string;
  coverImageUrl?: string;
  coverPrompt?: string;
  coverTemplateId?: string;
  coverTemplateImageId?: string;
  coverTemplateImageUrl?: string;

  // Style
  styleVariants: StyleVariant[];
  selectedStyleId?: string;
  stylePrompt: string;
  styleImageId?: string;
  styleImageUrl?: string;
  styleLockStatus?: 'resolved' | 'missing';
  styleLockResolvedAt?: number;
  styleCategory: string;
  styleAspectRatio: AspectRatio;
  customAspectRatioEnabled?: boolean;
  customAspectRatio?: string;
  imageResolution: ImageResolution;

  // References (World Building)
  characters: Character[];
  items: Item[];
  locations: Location[];

  // Layout
  layoutType: LayoutType;
  /** ID of the selected grid template from gridTemplates.ts */
  gridTemplateId?: string;
  /** Snapshot of panel slot positions used at generation time (for versioning) */
  panelSlotsSnapshot?: Array<{
    id: string;
    x: number; y: number;
    width: number; height: number;
    effectiveRatio: AspectRatio;
    label?: string;
  }>;
  customLayoutPrompt?: string;
  textLayout?: TextLayout;
  /** 'universal' applies one dialogue style to all panels; 'per_panel' allows individual overrides */
  dialogueMode?: 'universal' | 'per_panel';
  /** Default dialogue bubble kind when dialogueMode is 'universal' */
  universalDialogueStyle?: 'speech' | 'thought' | 'narration' | 'shout';
  panelPlanVersion?: number;
  pricingConfig?: PricingConfig;
  // Deprecated legacy field retained for backwards compatibility with older project payloads.
  assistantChat?: ChatMessage[];
  imageTags?: Record<string, ImageTag>;
  imageTagCounters?: Record<string, number>;

  // PageStudio (single-sheet engine) — self-contained, independent of the classic panel fields.
  pageStudio?: PageStudioState;

  // Final Output
  panels: ComicPanel[];

  // Background Process
  generationStatus?: GenerationStatus;
  generationArtifacts?: GenerationArtifact[];

  // Versioning
  versions?: ProjectVersion[];
}

export interface ProjectVersion {
  id: string;
  name: string;
  createdAt: number;
  state: ComicState;
  thumbnail?: string;
  reason?: string;
  parentVersionId?: string;
  snapshotHash?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  coverImage?: string;
  state: ComicState;
  isPublic?: boolean;
  userId?: string;
  authorName?: string;
  likesCount?: number;
  viewsCount?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface ProjectComment {
  id: string;
  authorId?: string;
  author?: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
  likes: number;
  dislikes: number;
}

export interface ImageTag {
  imageId: string;
  tag: string;
  category: string;
  label?: string;
  source?: {
    type: string;
    id?: string;
    label?: string;
  };
  createdAt?: number;
}

export interface MasterChatSession {
  messages: ChatMessage[];
  isOpen: boolean;
}

export enum AppStep {
  SCRIPT_INPUT = 0,
  STORY_PLANNING = 1,
  STYLE_SELECTION = 2,
  REFERENCE_BUILDER = 3,
  COVER = 4,
  LAYOUT_SELECTION = 5,
  COMBINED_PREVIEW = 6,
  FULL_GENERATION = 7,
  REVIEW_EXPORT = 8
}

export interface UserProfile {
  id: string; // references auth.users
  username?: string; // UNIQUE
  email: string;
  avatar_url?: string;
  terms_accepted?: boolean;
  marketing_consent?: boolean;
  bio?: string;
  full_name?: string;
  website?: string;
  created_at: string;
  updated_at?: string;
  is_premium?: boolean; // From usage_limits join
  credits?: number; // From usage_limits
}

export interface UserPrivateProfile {
  id: string; // references auth.users
  first_name?: string | null;
  last_name?: string | null;
  phone_number?: string | null;
  dob?: string | null; // YYYY-MM-DD
  email_pref_product_updates?: boolean | null;
  email_pref_marketing?: boolean | null;
  created_at: string;
  updated_at?: string;
}

export interface AccountProfile {
  publicProfile: UserProfile | null;
  privateProfile: UserPrivateProfile | null;
}

export interface Comment {
  id: string;
  project_id: string;
  user_id: string;
  text: string;
  created_at: string;
  updated_at?: string;
  user?: { username?: string; avatar_url?: string };
  likes?: number;
  dislikes?: number; // Optional locally, or logic handles it
  isLiked?: boolean;
}

export interface Follow {
  follower_id: string;
  following_id: string;
  created_at: string;
}

export interface AppNotification {
  id: string;
  user_id: string;
  actor_id?: string;
  type: 'follow' | 'comment' | 'like' | 'generation' | 'system';
  entity_id?: string;
  is_read: boolean;
  created_at: string;
  actor?: { username: string; avatar_url?: string };
  title?: string;
  message?: string;
}

export interface CommentLike {
  id: string;
  user_id: string;
  comment_id: string;
  created_at: string;
}
