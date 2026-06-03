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
};

export type ChatToolEvent = { tool: string; query?: string; ok: boolean; summary?: string };
export type ChatToolImage = { url: string; title?: string; thumbnail?: string; source?: string };

// --- Rich output artifacts (generative UI) ---
// Tools can emit typed artifacts that the client renders as real components
// (weather cards, maps, video grids…) instead of plain text. `type` keys the
// client-side renderer; new artifact types are added without touching the loop.
export type ChatArtifact = { type: string; data: unknown };

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
  current: {
    tempC: number;
    tempF: number;
    /** Apparent ("feels like") temperature in Celsius. */
    feelsLikeC?: number;
    code: number;
    description: string;
    windKph: number;
    humidity?: number;
    /** Current UV index. */
    uvIndex?: number;
    /** Current chance of precipitation (%). */
    precipProb?: number;
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
  /** Best-effort photo (OpenGraph image from the place's website). */
  image?: string;
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
  /** ISO date (YYYY-MM-DD). */
  date: string;
  close: number;
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
  /** ~30 sessions of closing prices for a sparkline. */
  series?: StockPoint[];
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
}
export interface SwarmTraceArtifact {
  goal: string;
  agents: SwarmAgentRun[];
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
  usage?: ApiUsage;
  billing?: ApiBillingInfo;
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
