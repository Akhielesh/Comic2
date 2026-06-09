import {
  AspectRatio,
  ImageResolution,
  Scene,
  Character,
  Item,
  Location,
  DialogueBlock,
  ContinuityBible,
  SceneContinuityBinding,
  ComicForgeAmbiguityFlag,
  ComicForgeAssetCard,
  ComicForgeBalloonZone,
  ComicForgeExportPreset,
  ComicForgeFormatSpec,
  ComicForgeJobSummary,
  ComicForgeLayoutTemplate,
  ComicForgePreviewPack,
  ComicForgeQCReport,
  ComicForgeStage,
  ComicForgeStoryArchitecture,
  ComicForgeStoryboardValidation,
  ComicForgeStructuredScriptAnalysis,
  ComicForgeStyleBible,
  ComicForgeStyleRecommendation,
  ComicForgeCostTracker
} from './types.js';
import type {
  BillingSummaryResponse,
  LimitExceededDetails,
  ReservationState,
  TokenEstimateResponse
} from './shared/types/billing.js';

export type ApiBillingInfo = {
  reservationId?: string;
  byokBypass?: boolean;
  estimated?: TokenEstimateResponse;
  settled?: {
    actualCt: number;
    billableUsd: number;
    providerCostUsd: number;
    reservationReleased?: boolean;
    autoReload?: {
      paymentIntentId: string;
      addedCt: number;
      chargedUsd: number;
    };
    overageCapture?: {
      paymentIntentId: string;
      capturedUsd: number;
    };
  };
};

export type ApiUsage = {
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
  promptChars?: number;
  estimatedTokens?: number;
  /** Real provider cost in USD when reported (e.g. OpenRouter usage.cost). Drives exact billing. */
  providerCostUsd?: number;
};

export type ApiTimings = {
  apiMs?: number;
  saveMs?: number;
  totalMs?: number;
};

export type AnalyzeScriptRequest = { script: string; creativeDirection?: string };
export type AnalyzeScriptResponse = {
  scenes: Scene[];
  diagnostics?: {
    ungroundedCharactersDropped?: number;
    rawExcerptFallbackCount?: number;
    segmentCount?: number;
    fallbackSceneCount?: number;
    coreEntityDrops?: number;
    plotDriftCorrections?: number;
    sceneCount?: number;
  };
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type StoryOutlineRequest = {
  genre?: string;
  tone?: string;
  setting?: string;
  characters?: string;
  conflict?: string;
  ending?: string;
  length?: string;
};
export type StoryOutlineResponse = {
  outline: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type StoryDraftRequest = {
  outline?: string;
  genre?: string;
  tone?: string;
  setting?: string;
  characters?: string;
  length?: string;
};
export type StoryDraftResponse = {
  script: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type StoryToolRequest = {
  script: string;
  instruction: string;
  history?: Array<{ role: 'user' | 'model'; text: string }>;
};
export type StoryToolResponse = {
  text: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type ExtractWorldRequest = { scenes: Scene[]; script: string; creativeDirection?: string };
export type ExtractWorldResponse = {
  characters: Character[];
  items: Item[];
  locations: Location[];
  diagnostics?: {
    input_scene_count: number;
    entity_counts: {
      characters: number;
      items: number;
      locations: number;
    };
    filtered_entity_count: number;
    dropped_entities?: Array<{
      name: string;
      kind: 'character' | 'item' | 'location';
      reason: 'NOT_IN_SCRIPT' | 'LOW_DESCRIPTION_QUALITY' | 'DUPLICATE_NORMALIZED_NAME';
    }>;
    ungrounded_characters_dropped?: number;
  };
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type ComicForgeApiEnvelope<T> = {
  ok: boolean;
  stage?: ComicForgeStage;
  data: T;
};

export type ComicForgeFormatLockRequest = {
  readingFormat: ComicForgeFormatSpec['readingFormat'];
  platform: ComicForgeFormatSpec['platform'];
  resolutionTarget: ComicForgeFormatSpec['resolutionTarget'];
  rtlReading?: boolean;
};

export type ComicForgeFormatLockResponse = ComicForgeApiEnvelope<{
  formatSpec: ComicForgeFormatSpec;
}>;

export type ComicForgeAnalyzeScriptRequest = {
  rawScriptText: string;
};

export type ComicForgeAnalyzeScriptResponse = ComicForgeApiEnvelope<{
  analysis: ComicForgeStructuredScriptAnalysis;
  unresolvedFlags: ComicForgeAmbiguityFlag[];
}>;

export type ComicForgeResolveAmbiguityRequest = {
  flagId: string;
  resolution: string;
};

export type ComicForgeResolveAmbiguityResponse = ComicForgeApiEnvelope<{
  analysis: ComicForgeStructuredScriptAnalysis;
  unresolvedFlags: ComicForgeAmbiguityFlag[];
}>;

export type ComicForgeBuildArchitectureRequest = {
  pacingPreference: 'fast_action' | 'balanced' | 'slow_emotional';
  targetPageCountOverride?: number;
};

export type ComicForgeBuildArchitectureResponse = ComicForgeApiEnvelope<{
  architecture: ComicForgeStoryArchitecture;
}>;

export type ComicForgeSuggestStylesRequest = {
  customStyleHint?: string;
};

export type ComicForgeSuggestStylesResponse = ComicForgeApiEnvelope<{
  recommendations: ComicForgeStyleRecommendation[];
}>;

export type ComicForgeBuildStyleBibleRequest = {
  selectedStyle: string;
  customPromptOverride?: string;
};

export type ComicForgeBuildStyleBibleResponse = ComicForgeApiEnvelope<{
  styleBible: ComicForgeStyleBible;
}>;

export type ComicForgeAssetCardsListResponse = ComicForgeApiEnvelope<{
  cards: ComicForgeAssetCard[];
}>;

export type ComicForgeCreateAssetCardRequest = {
  cardType: ComicForgeAssetCard['cardType'];
  name: string;
  canonicalDescription: string;
  doNotChange?: string[];
  negativeConstraints?: string[];
  allowedVariants?: string[];
};

export type ComicForgeCreateAssetCardResponse = ComicForgeApiEnvelope<{
  card: ComicForgeAssetCard;
}>;

export type ComicForgePatchAssetCardRequest = Partial<ComicForgeCreateAssetCardRequest> & {
  status?: ComicForgeAssetCard['status'];
};

export type ComicForgePatchAssetCardResponse = ComicForgeApiEnvelope<{
  card: ComicForgeAssetCard;
}>;

export type ComicForgeGenerateRefsRequest = {
  angles?: string[];
};

export type ComicForgeGenerateRefsResponse = ComicForgeApiEnvelope<{
  card: ComicForgeAssetCard;
}>;

export type ComicForgeExtractLayoutRequest = {
  referenceImageUrl?: string;
  layoutHint?: string;
};

export type ComicForgeExtractLayoutResponse = ComicForgeApiEnvelope<{
  layoutTemplate: ComicForgeLayoutTemplate;
}>;

export type ComicForgeBuildLetteringRulesRequest = {
  captionStyle?: 'box' | 'borderless';
  balloonStyle?: 'round' | 'spiky' | 'cloud' | 'rectangular';
  sfxStyle?: string;
};

export type ComicForgeBuildLetteringRulesResponse = ComicForgeApiEnvelope<{
  letteringRules: Record<string, unknown>;
}>;

export type ComicForgeGenerateBalloonZonesRequest = {
  pageId: string;
};

export type ComicForgeGenerateBalloonZonesResponse = ComicForgeApiEnvelope<{
  balloonZones: ComicForgeBalloonZone[];
}>;

export type ComicForgeGenerateThumbnailsRequest = {
  quality?: 'thumbnail';
};

export type ComicForgeGenerateThumbnailsResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeValidateStoryboardResponse = ComicForgeApiEnvelope<{
  validation: ComicForgeStoryboardValidation;
}>;

export type ComicForgePreviewPackResponse = ComicForgeApiEnvelope<{
  preview: ComicForgePreviewPack;
}>;

export type ComicForgeGenerateRequest = {
  quality: 'draft' | 'final';
};

export type ComicForgeGenerateResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeRegeneratePanelRequest = {
  quality: 'draft' | 'final';
  reason?: string;
};

export type ComicForgeRegeneratePanelResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeAssemblePageRequest = {
  pageId: string;
};

export type ComicForgeAssemblePageResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeRenderLetteringRequest = {
  pageId: string;
};

export type ComicForgeRenderLetteringResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeRunQcRequest = {
  pageId: string;
  projectId: string;
};

export type ComicForgeRunQcResponse = ComicForgeApiEnvelope<{
  report: ComicForgeQCReport;
  job?: ComicForgeJobSummary;
}>;

export type ComicForgePatchPanelLetteringRequest = {
  elements: Array<Record<string, unknown>>;
};

export type ComicForgePatchPanelLetteringResponse = ComicForgeApiEnvelope<{
  letteringId: string;
  elements: Array<Record<string, unknown>>;
}>;

export type ComicForgeExportRequest = {
  preset: ComicForgeExportPreset;
  pageRange?: { from: number; to: number };
  upscaleIfNeeded?: boolean;
};

export type ComicForgeExportResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeJobStatusResponse = ComicForgeApiEnvelope<{
  job: ComicForgeJobSummary;
}>;

export type ComicForgeJobEvent = {
  id: string;
  jobId: string;
  type: 'queued' | 'running' | 'progress' | 'done' | 'failed';
  message: string;
  timestamp: number;
  progress?: number;
  payload?: Record<string, unknown>;
};

export type ComicForgeJobEventsResponse = ComicForgeApiEnvelope<{
  events: ComicForgeJobEvent[];
}>;

export type ComicForgeCostTrackerResponse = ComicForgeApiEnvelope<{
  cost: ComicForgeCostTracker;
}>;

export type PanelBreakdownRequest = {
  scene: Scene;
  style: string;
  layoutType: string;
  panelCount?: number;
  stage?: string;
  /** Author's creative direction — honour tone/genre/intent without inventing plot. */
  creativeDirection?: string;
  /** Rolling "story so far" summary of earlier scenes, for narrative carryover. */
  continuitySummary?: string;
  continuityBible?: ContinuityBible;
  sceneBindings?: SceneContinuityBinding[];
  previousPanelContext?: Array<{
    panelId?: string;
    sceneId?: number;
    description: string;
    dialogue?: string;
  }>;
};
export type PanelBreakdownResponse = {
  panels: Array<{
    title?: string;
    focalSubject?: string;
    description: string;
    shotType?: string;
    cameraAngle?: string;
    composition?: string;
    dialogue: string;
    dialogueBlocks?: DialogueBlock[];
    requiredEntityIds?: string[];
    locationId?: string;
    continuityNotes?: string;
  }>;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type ContinuityAuditRequest = {
  script?: string;
  continuityBible?: ContinuityBible;
  sceneBindings?: SceneContinuityBinding[];
  panels: Array<{
    id?: string;
    sceneId: number;
    description: string;
    dialogue?: string;
    requiredEntityIds?: string[];
    locationId?: string;
  }>;
};

export type ContinuityAuditResponse = {
  panelScores: Array<{
    panelId?: string;
    sceneId: number;
    driftScore: number;
    issues: string[];
    suggestedFix?: string;
    requiredEntityIds?: string[];
    locationId?: string;
  }>;
  overallScore: number;
  summary: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type ContinuitySummaryRequest = {
  currentSummary?: string;
  scene: Scene;
  panels: Array<{ description: string; dialogue: string }>;
};
export type ContinuitySummaryResponse = {
  summary: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type LayoutAnalysisRequest = { images: string[] };
export type LayoutAnalysisResponse = {
  description: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type StyleAnalysisResponse = {
  brief: string;
  tags: string[];
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type ImageGenerateRequest = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  referenceImages?: string[]; // dataUrls
  stage?: string;
  projectId?: string;
  storage?: 'project' | 'test';
  cropToRatio?: string;
  model?: string;
};
export type ImageGenerateResponse = {
  imageId?: string;
  imageUrl?: string;
  dataUrl?: string;
  mimeType: string;
  prompt: string;
  usage?: ApiUsage;
  model: string;
  timings?: ApiTimings;
  billing?: ApiBillingInfo;
  /** Present when the server overrode the requested model (e.g. it lacked image output). */
  modelDowngrade?: { from: string; to: string; reason?: string };
};

export type FluxGenerateRequest = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  negativePrompt?: string;
  seed?: number;
  steps?: number;
  stage?: string;
  projectId?: string;
  storage?: 'project' | 'test';
  cropToRatio?: string;
};
export type FluxGenerateResponse = {
  imageId?: string;
  imageUrl?: string;
  dataUrl?: string;
  mimeType: string;
  prompt: string;
  usage?: ApiUsage;
  timings?: ApiTimings;
  model: string;
  billing?: ApiBillingInfo;
};

export type IdeogramGenerateRequest = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  negativePrompt?: string;
  seed?: number;
  modelId?: string;
  stage?: string;
  projectId?: string;
  storage?: 'project' | 'test';
  cropToRatio?: string;
};
export type IdeogramGenerateResponse = {
  imageId?: string;
  imageUrl?: string;
  dataUrl?: string;
  mimeType: string;
  prompt: string;
  usage?: ApiUsage;
  timings?: ApiTimings;
  model: string;
  billing?: ApiBillingInfo;
};

export type AssistantMessage = { role: 'user' | 'model'; text: string };

export type AssistantMap = Record<string, unknown>;

export type AssistantSystemStatusSummary = {
  status?: string;
  geminiKeyPresent?: boolean;
  pixazoKeyPresent?: boolean;
  message?: string;
};

export type AssistantReportSummary = {
  cost?: { currency?: string; totalCost?: number; estimatedArtifacts?: number };
  storage?: {
    imageCount?: number;
    imageBytes?: number;
    panelsCount?: number;
    artifactsCount?: number;
    indexedDb?: AssistantMap;
  };
  aiUsage?: { totalTokens?: number; totalArtifacts?: number };
};

export type AssistantArtifactSummary = {
  total?: number;
  byStage?: Record<string, number>;
  byType?: Record<string, number>;
  lastPrompts?: Array<{ stage?: string; model?: string; prompt?: string }>;
};

export type AssistantPanelPlanSummary = {
  plannedPanels?: number;
  generatedPanels?: number;
  textLayout?: string;
};

export type AssistantProjectSummary = {
  id?: string;
  name?: string;
  updatedAt?: number;
  step?: number;
  panelCount?: number;
  generatedPanels?: number;
  hasCover?: boolean;
};

export type AssistantAppSnapshot = {
  view?: string;
  totalProjects?: number;
  generatingProjects?: Array<AssistantMap>;
  lastUpdatedProject?: AssistantMap;
};

export type AssistantAccountSummary = {
  isAuthenticated: boolean;
  username?: string;
  maskedEmail?: string;
  isAdmin?: boolean;
  planTier?: 'free' | 'creator' | 'pro' | 'studio' | 'custom' | 'admin';
  usage?: {
    imagesGenerated?: number;
    maxImagesAllowed?: number;
    hasByok?: boolean;
    isPremium?: boolean;
    dailyRemainingCt?: number;
    availableCt?: number;
  };
  billing?: BillingSummaryResponse;
};

export type UniversalAssistantContext = {
  view?: string;
  account?: AssistantAccountSummary;
  systemStatus?: AssistantSystemStatusSummary;
  reportSummary?: AssistantReportSummary;
  artifactSummary?: AssistantArtifactSummary;
  panelPlanSummary?: AssistantPanelPlanSummary;
  allProjectsSummary?: AssistantProjectSummary[];
  projectSnapshot?: AssistantMap;
  appSnapshot?: AssistantAppSnapshot;
  testLabSummary?: AssistantMap;
  testLabRecentRuns?: AssistantMap[];
  publicHints?: string[];
};

export type UniversalAssistantRequest = {
  message: string;
  history: AssistantMessage[];
  context?: UniversalAssistantContext;
};

export type AssistantLimitInfo = {
  scope: 'guest' | 'free' | 'bypass';
  by?: 'ip' | 'user';
  limit?: number;
  remaining?: number;
  resetAt?: number;
  windowMs?: number;
};

export type AssistantPolicyInfo = {
  scope: 'platform_only';
  offTopicBlocked: boolean;
  reason?: 'NON_PLATFORM' | 'SENSITIVE_CONTEXT_REDACTED';
};

export type UniversalAssistantResponse = {
  text: string;
  usage?: ApiUsage;
  model: string;
  limitInfo?: AssistantLimitInfo;
  policy: AssistantPolicyInfo;
  billing?: ApiBillingInfo;
};

// Backwards-compatible aliases for legacy references.
export type MasterAssistantContext = UniversalAssistantContext;
export type MasterAssistantRequest = UniversalAssistantRequest;
export type MasterAssistantResponse = UniversalAssistantResponse;

// --- AI Chat Platform ---
export type ChatReasoningLevel = 'none' | 'low' | 'medium' | 'high';
export type ChatTextPart = { type: 'text'; text: string };
export type ChatImagePart = { type: 'image_url'; image_url: { url: string } };
export type ChatMessagePart = ChatTextPart | ChatImagePart;

export type ChatRequestMessage = {
  role: 'user' | 'assistant';
  content: string | ChatMessagePart[];
};

/** A user-configured remote MCP server (Streamable HTTP / JSON-RPC). */
export type McpServerConfig = {
  id: string;
  name: string;
  /** Endpoint URL (https). */
  url: string;
  /** Optional auth/extra headers (e.g. { Authorization: 'Bearer …' }). */
  headers?: Record<string, string>;
};

/**
 * Lightweight, privacy-conscious runtime context about the user's situation,
 * gathered client-side and sent every turn so the model has basic situational
 * awareness (date, timezone, locale, units, optional coarse location). Without
 * this, "today", "latest news", "weather", and "near me" have no anchor.
 *
 * Location is only ever populated when the browser already has geolocation
 * permission — it never triggers a prompt — and is treated as approximate.
 */
export type ChatClientContext = {
  /** Client wall-clock time as an ISO string (authoritative for "now"/"today"). */
  now?: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /** BCP-47 locale, e.g. "en-US". */
  locale?: string;
  /** Preferred measurement system, derived from locale (US/LR/MM ⇒ imperial). */
  units?: 'metric' | 'imperial';
  /** Coarse, opt-in location. Present only when geolocation is already granted. */
  location?: {
    city?: string;
    region?: string;
    /** ISO country code, e.g. "US". */
    country?: string;
    lat?: number;
    lng?: number;
    /** Always true today — coordinates are coarse, never exact street level. */
    approximate?: boolean;
  };
};

/** A user-defined specialized agent the swarm can deploy (stored client-side). */
export type CustomAgentDef = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names this agent may use (validated against the server allowlist). */
  toolNames: string[];
};

export type ChatRequest = {
  messages: ChatRequestMessage[];
  /** Explicit catalog model id; falls back to the X-Text-Model header, then an auto pick. */
  model?: string;
  /** Provider for the chosen model. Falls back to the X-Text-Source header, then OpenRouter. */
  source?: 'openrouter' | 'nvidia';
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
  /** Optional custom persona/system prompt for this conversation. */
  systemPrompt?: string;
  /**
   * Sanitized DreamStream workspace context, sent ONLY when the user enables the
   * "DreamStream" connector toggle for the session. The server re-sanitizes it
   * through the same allowlist as the in-app assistant before the model sees it.
   * Omitted (and ignored) when the toggle is off, so chat has no app reach by default.
   */
  dreamstreamContext?: UniversalAssistantContext;
  /** Enabled agentic tool names (e.g. 'web_search', 'image_search'). OpenRouter models only. */
  tools?: string[];
  /** Enabled custom MCP servers whose tools the model may call (OpenRouter only). */
  mcpServers?: McpServerConfig[];
  /** Runtime situational context (date/timezone/locale/units/location). */
  clientContext?: ChatClientContext;
  /**
   * Route this turn through the multi-agent swarm orchestrator: a planner
   * decomposes the goal, specialized agents work in parallel, and a lead agent
   * synthesizes the result. OpenRouter only.
   */
  swarm?: boolean;
  /** User-defined agents the swarm may deploy in addition to the built-ins. */
  customAgents?: CustomAgentDef[];
};

export type ChatToolEvent = { tool: string; query?: string; ok: boolean; summary?: string };
export type ChatToolImage = { url: string; title?: string; thumbnail?: string; source?: string };

/**
 * A capability gap surfaced to the user/dashboard: something the AI tried to do but
 * couldn't fully deliver — a tool failed, returned nothing, ran in a degraded mode
 * (e.g. open-data fallback because a key is missing), or wasn't enabled. This is how
 * the platform is honest about *why* an answer was thin.
 */
export type CapabilityNotice = {
  /** Tool/capability id this is about, e.g. "find_places". */
  tool?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Optional hint on how to fix it (e.g. "Set FOURSQUARE_API_KEY"). */
  fix?: string;
  /** ISO timestamp (set server-side when logged). */
  at?: string;
};

// --- Rich output artifacts (generative UI) ---
// Tools can emit typed artifacts that the client renders as real components
// (weather cards, maps, video grids…) instead of plain text. `type` keys the
// client-side renderer; new artifact types are added without touching the loop.
export type ChatArtifact = { type: string; data: unknown };

// --- Quiz / assessment artifact (on-demand learning components) ---
// Emitted by the `generate_quiz` tool so the AI can build interactive practice
// questions when a user is learning a topic. The client self-grades — no round-trip.
export type QuizQuestionType = 'single' | 'multi' | 'short' | 'true_false';
export interface QuizChoice {
  id: string;
  text: string;
}
export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  prompt: string;
  /** Choices for single / multi / true_false questions. */
  choices?: QuizChoice[];
  /** Correct answer(s): choice id(s) for single/multi/true_false; accepted answer strings for short. */
  correct: string[];
  explanation?: string;
  hint?: string;
}
export interface QuizArtifact {
  title: string;
  topic?: string;
  description?: string;
  questions: QuizQuestion[];
}

// --- Flashcards artifact (study/memorization mode for guided learning) ---
// Emitted by the `generate_flashcards` tool. A flip-card deck the user studies,
// marking each card known/review, with shuffle + progress.
export interface Flashcard {
  front: string;
  back: string;
}
export interface FlashcardsArtifact {
  title?: string;
  topic?: string;
  cards: Flashcard[];
}

// --- SQL exercise / playground artifact (run real SQL while learning) ---
// Emitted by the `sql_exercise` tool. The AI provides a schema (CREATE + seed) and a
// task; the user writes SQL and runs it against a sandboxed in-memory DB (server-side
// sql.js) to see real results / errors.
export interface SqlExerciseArtifact {
  title?: string;
  instructions?: string;
  /** SQL that sets up the practice database (CREATE TABLE … + INSERT …). */
  schema: string;
  task?: string;
  /** Optional starter query to prefill the editor. */
  starterSql?: string;
}

// --- Downloadable document artifact ---
// Emitted by the `generate_document` tool so the AI can author a custom resource
// (study guide, cheat sheet, notes, report, plan) the user can read inline and
// download as Markdown / HTML or print to PDF.
export interface DocumentArtifact {
  title: string;
  subtitle?: string;
  /** Markdown body of the document. */
  content: string;
  /** Suggested base filename (no extension). */
  filename?: string;
}

// --- Downloadable resource bundle artifact (.zip of custom-built resources) ---
// Emitted by the `generate_bundle` tool. Packages several generated files (e.g. a study
// guide, practice questions, a data CSV, starter code) into one card the user can
// download individually or all at once as a .zip — "custom-built resources" they keep.
export interface BundleFile {
  /** Filename WITH extension, e.g. "study-guide.md", "data.csv", "starter.py". */
  name: string;
  /** Text content of the file. */
  content: string;
  /** Optional human-friendly label shown next to the file. */
  label?: string;
}
export interface ResourceBundleArtifact {
  title: string;
  description?: string;
  files: BundleFile[];
}

// --- Code Studio artifact ---
// Emitted by the `generate_app` tool. Carries a complete multi-file project
// that the client renders in the live, editable Code Studio side panel.
export type CodeStudioTemplate = 'react-ts' | 'react' | 'vanilla-ts' | 'vanilla' | 'static';

export interface CodeStudioFile {
  /** Absolute path from project root, e.g. "/App.tsx" or "/styles/main.css". */
  path: string;
  content: string;
  /** Language hint for the editor (typescript, javascript, html, css, …). */
  language?: string;
}

export interface CodeStudioArtifact {
  title: string;
  description?: string;
  files: CodeStudioFile[];
  template: CodeStudioTemplate;
}

// --- Code Studio "engineering team" build flow (clarify → plan → build) ---------------
// The studio doesn't one-shot a prompt into a single file anymore. It first asks smart
// clarifying questions (the user picks options or types a custom answer), drafts a concrete
// build plan the user can review, then builds the full multi-file app to that plan — and a
// team of specialist agents reviews it. These types are the shared contract for that flow.

export type StudioQuestionKind = 'single' | 'multi';

export interface StudioClarifyOption {
  label: string;
  value: string;
  /** Optional one-liner explaining the option. */
  hint?: string;
}

export interface StudioClarifyQuestion {
  id: string;
  question: string;
  /** single = pick one, multi = pick several. The user may also type a custom answer when allowed. */
  kind: StudioQuestionKind;
  options: StudioClarifyOption[];
  /** Whether the user can type their own answer instead of (or in addition to) the options. */
  allowCustom: boolean;
}

export interface StudioClarifyResult {
  /** 0–4 high-signal questions the AI wants answered before building. Empty = build straight away. */
  questions: StudioClarifyQuestion[];
  /** Assumptions the AI will make for anything it did not ask about. */
  assumptions: string[];
}

export interface StudioAnswer {
  question: string;
  answer: string;
}

export interface StudioPlanFile {
  path: string;
  purpose: string;
}

export interface StudioBuildPlan {
  title: string;
  summary: string;
  /** e.g. "React dashboard", "Express API", "Python CLI". */
  appType: string;
  stack: string[];
  /** Concrete features the build will implement. */
  features: string[];
  /** Planned file tree with each file's purpose. */
  files: StudioPlanFile[];
  /** Real data sources / APIs the app will use (when relevant). */
  dataSources?: string[];
  /** Notes, risks, or decisions worth surfacing to the user. */
  notes?: string[];
}


export interface WeatherDaily {
  date: string;
  minC: number;
  maxC: number;
  code: number;
  description: string;
  /** Max UV index for the day. */
  uvMax?: number;
  /** Chance of precipitation (%). */
  precipProb?: number;
  /** ISO sunrise/sunset times. */
  sunrise?: string;
  sunset?: string;
}
/** One hour of the short-range forecast. */
export interface WeatherHourly {
  /** ISO timestamp. */
  time: string;
  tempC: number;
  code: number;
  /** Chance of precipitation (%). */
  precipProb?: number;
  isDay?: boolean;
}
/** Air quality snapshot (Open-Meteo CAMS). */
export interface WeatherAirQuality {
  usAqi?: number;
  euAqi?: number;
  pm25?: number;
  /** Human band derived from US AQI, e.g. "Good", "Moderate". */
  category?: string;
}
/** Pollen levels (grains/m³, Europe coverage). Bucketed for display. */
export interface WeatherPollen {
  grass?: number;
  tree?: number;
  weed?: number;
  /** Overall band, e.g. "Low", "Moderate", "High". */
  level?: string;
}
export interface WeatherArtifact {
  location: string;
  /** Coordinates for the inline map view. */
  coords?: { lat: number; lng: number };
  current: {
    tempC: number;
    tempF: number;
    /** Apparent ("feels like") temperature in Celsius. */
    feelsLikeC?: number;
    code: number;
    description: string;
    windKph: number;
    /** Wind direction in meteorological degrees (0 = from N). */
    windDir?: number;
    /** Wind gust speed (km/h). */
    windGustKph?: number;
    humidity?: number;
    /** Current UV index. */
    uvIndex?: number;
    /** Current chance of precipitation (%). */
    precipProb?: number;
    /** Surface pressure (hPa). */
    pressureHpa?: number;
    /** Dew point (°C). */
    dewPointC?: number;
    /** Horizontal visibility (km). */
    visibilityKm?: number;
    /** Cloud cover (%). */
    cloudCover?: number;
    isDay: boolean;
  };
  /** Next ~24 hours, hour by hour. */
  hourly?: WeatherHourly[];
  daily: WeatherDaily[];
  airQuality?: WeatherAirQuality;
  pollen?: WeatherPollen;
}

export interface VideoResult {
  title: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  publisher?: string;
  views?: string;
}
export interface VideoResultsArtifact {
  query: string;
  results: VideoResult[];
}

export interface NewsItem {
  title: string;
  url: string;
  /** Publication / outlet name, when known. */
  source?: string;
  /** ISO timestamp of publication, when known. */
  publishedAt?: string;
  snippet?: string;
  /** Lead image / thumbnail, when available (best-effort). */
  image?: string;
  /** Coarse sentiment for an optional badge. */
  sentiment?: 'positive' | 'neutral' | 'negative';
  /** Estimated read time in minutes. */
  readMinutes?: number;
}
export interface NewsResultsArtifact {
  /** The query used (empty for a topical/top-headlines feed). */
  query: string;
  /** Topical section when not a free-text query (e.g. "world", "technology"). */
  topic?: string;
  items: NewsItem[];
}

// A nearby place / point of interest (local search). Sourced from OpenStreetMap
// (keyless), enriched best-effort with a photo from the place's website.
export interface PlaceResult {
  name: string;
  /** OSM category, e.g. "restaurant", "cafe", "hotel". */
  category?: string;
  /** Cuisine/type tag when present, e.g. "italian; pizza". */
  cuisine?: string;
  lat: number;
  lng: number;
  /** Straight-line distance from the search anchor, in km. */
  distanceKm?: number;
  address?: string;
  /** Raw opening-hours string (OSM format). */
  openingHours?: string;
  website?: string;
  phone?: string;
  /** Photo (Foursquare when available, else best-effort OpenGraph from the website). */
  image?: string;
  /** Rating normalized to a 0–5 scale (Foursquare only). */
  rating?: number;
  /** Price level 1–4 ($–$$$$) (Foursquare only). */
  price?: number;
  /** A maps/directions link for this place. */
  mapUrl?: string;
}
export interface PlacesResultsArtifact {
  /** What was searched, e.g. "restaurants" / "coffee". */
  query: string;
  /** Human label for the anchor, e.g. "your location" or "Eiffel Tower". */
  near: string;
  /** Anchor coordinates used for distances + the map. */
  anchor?: { lat: number; lng: number };
  results: PlaceResult[];
}

export interface MapMarker {
  lat: number;
  lng: number;
  label: string;
  description?: string;
}
export interface MapArtifact {
  title?: string;
  markers: MapMarker[];
  /** Ordered points for a drawn route/path between places, if any. */
  route?: { lat: number; lng: number }[];
}

export interface StockPoint {
  /** ISO date (YYYY-MM-DD) or intraday timestamp. */
  date: string;
  close: number;
}
/** One OHLC session for candlestick rendering. */
export interface StockCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
/** Selectable history windows for the MarketCard range timeline. */
export type StockRange = '1D' | '5D' | '1M' | '6M' | '1Y' | '5Y' | 'MAX';
/** Whether the listing venue is currently trading. */
export type MarketState = 'open' | 'closed' | 'pre' | 'after';
/** Fundamentals shown in the expanded MarketCard. All optional/best-effort. */
export interface StockStats {
  /** Market capitalization (absolute, e.g. 3.1e12). */
  marketCap?: number;
  peRatio?: number;
  /** Trailing 52-week high/low for the range track. */
  week52High?: number;
  week52Low?: number;
  /** Dividend yield as a percent (e.g. 0.52 for 0.52%). */
  dividendYield?: number;
  /** Average daily volume. */
  avgVolume?: number;
  /** Earnings-per-share (trailing). */
  eps?: number;
  /** Beta vs. the market. */
  beta?: number;
}
/** A related/peer company shown beside the quote (like a "Related" panel). */
export interface StockPeer {
  symbol: string;
  name?: string;
  price?: number;
  changePercent?: number;
  currency?: string;
}
export interface StockQuoteArtifact {
  symbol: string;
  name?: string;
  price: number;
  /** Absolute change vs. previous close. */
  change: number;
  /** Percent change vs. previous close. */
  changePercent: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  previousClose?: number;
  /** Quote date (as reported by the source). */
  asOf?: string;
  /** ISO 4217 currency the price is quoted in (default USD). */
  currency?: string;
  /** Trading venue label, e.g. "NASDAQ". */
  exchange?: string;
  /** Current trading session state for the status pill. */
  marketState?: MarketState;
  /** ~30 sessions of closing prices for the default sparkline / fallback chart. */
  series?: StockPoint[];
  /** Pre-bucketed history per range. When present the timeline switches between them; otherwise sub-ranges are derived from `series`. */
  ranges?: Partial<Record<StockRange, StockPoint[]>>;
  /** OHLC sessions enabling the candlestick chart variant. */
  candles?: StockCandle[];
  /** Fundamentals for the expanded view. */
  stats?: StockStats;
  /** A few recent headlines about this ticker for the expanded view. */
  headlines?: NewsItem[];
  /** Related / peer companies with their own quotes. */
  related?: StockPeer[];
}

// --- Generic data visualization ---
// A schema-driven chart the model can populate with arbitrary data, so it isn't
// tied to one domain (markets, polls, metrics, comparisons all flow through this).
export type DataChartVariant = 'line' | 'area' | 'bar' | 'grouped-bar' | 'stacked-bar' | 'pie' | 'donut' | 'scatter';
export interface DataChartPoint {
  /** Category (bar/pie) or numeric/temporal x (line/scatter). */
  x: number | string;
  y: number;
}
export interface DataChartSeries {
  name?: string;
  /** Explicit color override; otherwise drawn from the palette ramp. */
  color?: string;
  points: DataChartPoint[];
}
export interface ChartArtifact {
  variant: DataChartVariant;
  title?: string;
  subtitle?: string;
  series: DataChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /** Unit suffix appended to values in tooltips/axis (e.g. "%", "ms", "$"). */
  unit?: string;
  /** A named kit palette ("brand" | "ocean" | "sunset" | "violet" | "bull" | "bear" | "mono"). */
  palette?: string;
}

// A board of KPI tiles (stat + delta + sparkline/progress). The "at a glance"
// surface; tiles can also embed a full ChartArtifact.
export interface MetricTile {
  label: string;
  value: string | number;
  unit?: string;
  /** Signed change for a trend pill (absolute). */
  delta?: number;
  /** Percent change for the trend pill. */
  deltaPercent?: number;
  /** Inline sparkline values. */
  spark?: number[];
  /** Progress ring as value/max. */
  progress?: { value: number; max: number };
  /** Status accent: tints the tile. */
  status?: 'good' | 'warn' | 'bad' | 'neutral';
  /** A full chart embedded in the tile. */
  chart?: ChartArtifact;
}
export interface MetricBoardArtifact {
  title?: string;
  /** Grid columns (1–4); defaults to an automatic fit. */
  columns?: 1 | 2 | 3 | 4;
  tiles: MetricTile[];
}

// --- Generic data table ---
// A schema-driven, sortable, typed table — the workhorse for any tabular/financial
// data (watchlists, holdings, fundamentals, comparisons, screeners). Each column
// declares how its cells render (currency, percent, signed delta, sparkline, badge),
// so the same artifact powers everything from a peer comparison to a portfolio book.
export type DataTableCellKind =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'delta'
  | 'deltaPercent'
  | 'spark'
  | 'badge';
export interface DataTableColumn {
  /** Header label. */
  label: string;
  /** How cells in this column render. Defaults to 'text'. */
  kind?: DataTableCellKind;
  align?: 'left' | 'right' | 'center';
  /** ISO 4217 currency for 'currency' cells (column default; a cell may override). */
  currency?: string;
  /** Whether this column can be sorted (defaults true for numeric kinds). */
  sortable?: boolean;
}
/** A single primitive value, or a richer cell with adornments. */
export type DataTableValue = string | number | null;
export interface DataTableCell {
  value?: DataTableValue;
  /** Recent values for a 'spark' cell (inline sparkline). */
  spark?: number[];
  /** Explicit color (badge background / text tint), overrides the kind default. */
  color?: string;
  /** A small secondary line under the value (e.g. a ticker under a name). */
  sub?: string;
  /** Make the cell a link. */
  href?: string;
  /** Per-cell currency override for 'currency' kind. */
  currency?: string;
}
/** One row: an array of cells aligned to `columns` (primitive or rich cell). */
export type DataTableRowCell = DataTableValue | DataTableCell;
export interface DataTableArtifact {
  title?: string;
  subtitle?: string;
  columns: DataTableColumn[];
  rows: DataTableRowCell[][];
  /** Initial sort. */
  sort?: { column: number; dir: 'asc' | 'desc' };
  /** A named kit palette for the accent strip. */
  palette?: string;
  /** A footnote under the table (source, as-of, methodology). */
  caption?: string;
}

// --- Market heatmap ---
// A colored grid of tickers/sectors, tinted green→red by their change. Optional
// `weight` (e.g. market cap) sizes the tiles, giving a treemap-like market map.
export interface HeatmapCell {
  label: string;
  /** Value that drives the color (a change %, by default). */
  value?: number;
  /** Secondary text (price, market cap, etc.). */
  sub?: string;
  /** Relative tile size (e.g. market cap). */
  weight?: number;
  href?: string;
}
export interface HeatmapGroup {
  name?: string;
  cells: HeatmapCell[];
}
export interface HeatmapArtifact {
  title?: string;
  subtitle?: string;
  /** Grouped tiles (e.g. by sector). Use this OR `cells`. */
  groups?: HeatmapGroup[];
  /** Flat tiles when no grouping is needed. */
  cells?: HeatmapCell[];
  /** Unit appended to the value in tiles (default '%'). */
  unit?: string;
  caption?: string;
}

// --- Finance terminal ---
// The flagship composite: a single artifact that assembles a focus quote, a KPI
// ribbon, a watchlist/movers table, a sector heatmap, supporting charts and a news
// rail into one Bloomberg-style terminal panel. Every section is optional and reuses
// the existing artifact shapes, so the model can compose a partial terminal cheaply.
export interface TerminalNewsItem {
  title: string;
  url?: string;
  source?: string;
  publishedAt?: string;
}
export interface FinanceTerminalArtifact {
  title?: string;
  subtitle?: string;
  /** As-of label for the whole panel. */
  asOf?: string;
  /** A named kit palette for the terminal accent. */
  palette?: string;
  /** The featured instrument — renders the full interactive MarketCard. */
  focus?: StockQuoteArtifact;
  /** A KPI ribbon (indices, breadth, totals). */
  metrics?: MetricBoardArtifact;
  /** Watchlist / movers / holdings as a typed table. */
  table?: DataTableArtifact;
  /** Sector / market heatmap. */
  heatmap?: HeatmapArtifact;
  /** Supporting charts (allocation, performance, correlation, …). */
  charts?: ChartArtifact[];
  /** A compact news rail relevant to the terminal's focus. */
  news?: TerminalNewsItem[];
}

// --- Agent swarm ---
// One specialized agent's run within a swarm. Streamed to the client so the user
// watches the plan execute (which agents, doing what, with what status).
export type SwarmAgentStatus = 'pending' | 'running' | 'done' | 'error';
export interface SwarmAgentRun {
  /** Agent id from the registry (e.g. "news", "finance"). */
  id: string;
  name: string;
  /** The specific subtask assigned to this agent. */
  task: string;
  status: SwarmAgentStatus;
  /** Short summary of what the agent found (filled when done). */
  summary?: string;
  /** Tools the agent ran. */
  toolEvents?: ChatToolEvent[];
  /** Verifier confidence in this finding, 0–1 (Phase 9). Filled after the verify stage. */
  confidence?: number;
  /** Verifier flags, e.g. "no_sources", "unverified_figures", "hedged" (Phase 9). */
  flags?: string[];
}
export interface SwarmTraceArtifact {
  goal: string;
  agents: SwarmAgentRun[];
}

/** A premium deep-research report header — summarizes the investigation behind the brief. */
export interface ResearchReportArtifact {
  topic: string;
  depth: 'quick' | 'standard' | 'exhaustive';
  audience?: string;
  /** The sub-questions the engine investigated. */
  questions: string[];
  /** Distinct sources gathered. */
  sourceCount: number;
  /** How many sources were fetched & read in full (vs. snippet only). */
  readCount: number;
  sources: { title: string; url: string }[];
}

// ── Recipes ─────────────────────────────────────────────────────────────────
// A reusable, parameterized agent workflow (native port of goose recipes). These
// mirror the server schema in server/src/ai/recipes/schema.ts.

export type RecipeParameterType = 'string' | 'number' | 'boolean' | 'select';
export type RecipeRequirement = 'required' | 'optional' | 'user_prompt';

export interface RecipeParameterView {
  key: string;
  input_type: RecipeParameterType;
  requirement: RecipeRequirement;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
}

/** A recipe summary card (browse / save confirmation). */
export interface RecipeCardArtifact {
  id?: string;
  slug?: string;
  title: string;
  description: string;
  instructions?: string;
  prompt?: string;
  parameters?: RecipeParameterView[];
  tools?: string[];
  agents?: string[];
  swarm?: boolean;
  activities?: string[];
  builtin?: boolean;
}

/** A record of a recipe run: which recipe, with which parameters, and the outcome. */
export interface RecipeRunArtifact {
  recipeId?: string;
  title: string;
  description?: string;
  params: { key: string; value: string }[];
  mode: 'swarm' | 'agent';
  status: 'done' | 'error';
  /** Structured output when the recipe declared a response schema. */
  structured?: unknown;
  activities?: string[];
}

export type ChatCitation = { url: string; title?: string };

export type ChatResponse = {
  text: string;
  /** The actual model that produced the answer (may differ from requested — see requestedModel). */
  model: string;
  /** The model the user/app asked for, before any plan coercion or rate-limit fallback. */
  requestedModel?: string;
  source: 'openrouter' | 'nvidia';
  reasoningLevel: ChatReasoningLevel;
  webSearch: boolean;
  /** Step-by-step reasoning trace, when the model exposed one. */
  reasoning?: string;
  /** Web citations gathered when web search or DuckDuckGo search ran. */
  citations?: ChatCitation[];
  /** Tools the agent ran this turn (DuckDuckGo etc.). */
  toolEvents?: ChatToolEvent[];
  /** Images surfaced by an image-search tool. */
  images?: ChatToolImage[];
  /** Typed rich-output artifacts (weather, etc.) for the component renderer. */
  artifacts?: ChatArtifact[];
  /** Capability gaps this turn (degraded/failed/missing tools or data). */
  notices?: CapabilityNotice[];
  usage?: ApiUsage;
  billing?: ApiBillingInfo;
};

/** A platform capability and its current status (for the system dashboard). */
export type CapabilityStatus = {
  id: string;
  label: string;
  status: 'ok' | 'degraded' | 'unavailable';
  detail: string;
  /** Env var that would enable/upgrade it, when applicable. */
  envVar?: string;
};
export type CapabilityReport = {
  capabilities: CapabilityStatus[];
  /** Most recent capability-gap notices observed at runtime. */
  recentNotices: CapabilityNotice[];
};

// --- System dashboard (admin) ---
/** Live health of an upstream tool API. */
export type ToolHealth = {
  id: string;
  label: string;
  ok: boolean;
  /** Round-trip latency in ms (when reachable). */
  latencyMs?: number;
  status?: number;
  error?: string;
};
/** A platform dependency, its documented free-tier limit, and live status when known. */
export type DependencyInfo = {
  id: string;
  label: string;
  /** Human description of the free-tier / documented limit. */
  freeTier: string;
  /** True when we have a token/config to read live usage from this vendor. */
  connected: boolean;
  /** Env var that connects live metrics, when applicable. */
  envVar?: string;
  /** Live usage summary when connected (else undefined). */
  live?: { label: string; used?: number; limit?: number; detail?: string };
  docsUrl?: string;
};
export type SystemDashboard = {
  generatedAt: string;
  version: { appVersion: string; gitSha: string; buildTimestamp: string };
  capabilities: CapabilityStatus[];
  recentNotices: CapabilityNotice[];
  toolHealth: ToolHealth[];
  dependencies: DependencyInfo[];
  rateLimits: { scope: string; perWindow: number; windowMs: number }[];
};

export type TestLabReportRequest = { report: Record<string, unknown> };
export type TestLabReportResponse = {
  text: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
  billing?: ApiBillingInfo;
};

export type BillingReserveResponse =
  | { allowed: true; reservation: ReservationState }
  | { allowed: false; details: LimitExceededDetails };

export type SystemStatusResponse = {
  status: 'ok' | 'error';
  message?: string;
  supabaseConfigured?: boolean;
  storagePersistenceEnabled?: boolean;
};

export type SystemDiagnosticsResponse = {
  status: 'ok' | 'error';
  geminiKeyPresent: boolean;
  pixazoKeyPresent: boolean;
  message?: string;
  supabaseConfigured?: boolean;
  storagePersistenceEnabled?: boolean;
};

export type SystemVersionResponse = {
  appVersion: string;
  gitSha: string;
  buildTimestamp: string;
  worldExtractionContractVersion: number;
};

// ── Telemetry & Feedback ─────────────────────────────────────────────────────
// Captured client → server (POST /api/telemetry/{events,feedback}) to power
// product observability — failed chats, errors, app crashes, informative logs —
// and the feedback loop: like/dislike on responses & errors plus general platform
// feedback (category + sentiment + comment). Persisted to Supabase by the service
// role; see server/sql/telemetry_feedback.sql.

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

/** Product surface a signal came from, so analytics can be sliced by system. */
export type TelemetrySource =
  | 'ai_chat'
  | 'code_studio'
  | 'universal_assistant'
  | 'comic_studio'
  | 'comicforge'
  | 'test_lab'
  | 'client'
  | 'server'
  | 'unknown';

export interface TelemetryEventInput {
  /** Coarse category: 'error' | 'chat_failed' | 'app_crash' | 'unhandled_rejection' | 'log' | … */
  eventType: string;
  severity?: TelemetrySeverity;
  source?: TelemetrySource;
  /** App view / route the event happened on. */
  surface?: string;
  /** Short human-readable summary. */
  message?: string;
  /** Client session id (chat session id or per-tab id) that groups a flow. */
  sessionId?: string;
  /** ISO timestamp captured on the client when the event occurred. */
  clientTs?: string;
  /** Extra structured context (model, status, stack, url, …). */
  metadata?: Record<string, unknown>;
}

export interface TelemetryIngestRequest {
  events: TelemetryEventInput[];
}

export interface TelemetryIngestResponse {
  ok: boolean;
  accepted: number;
  persisted: boolean;
}

export type FeedbackVoteValue = 'like' | 'dislike';
export type FeedbackSentiment = 'positive' | 'neutral' | 'negative' | 'frustrated';

export type FeedbackTargetType =
  | 'chat_response'
  | 'universal_assistant'
  | 'error'
  | 'app_crash'
  | 'studio'
  | 'platform';

export interface FeedbackInput {
  targetType: FeedbackTargetType;
  /** Id of the thing being rated (message id, error id, …) when applicable. */
  targetId?: string;
  vote?: FeedbackVoteValue;
  /** General-feedback category, e.g. 'AI response quality'. */
  category?: string;
  sentiment?: FeedbackSentiment;
  /** Free-text note (dislike reason / general comment). */
  comment?: string;
  source?: TelemetrySource;
  surface?: string;
  sessionId?: string;
  clientTs?: string;
  metadata?: Record<string, unknown>;
}

export interface FeedbackResponse {
  ok: boolean;
  persisted: boolean;
}

/** General-feedback categories surfaced in the feedback widget. */
export const FEEDBACK_CATEGORIES = [
  'AI response quality',
  'Bug or error',
  'Speed / performance',
  'Confusing UI',
  'Missing feature',
  'Billing or credits',
  'Other'
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
