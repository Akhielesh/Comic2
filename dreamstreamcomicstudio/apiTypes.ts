import {
  AspectRatio,
  ImageResolution,
  Scene,
  Character,
  Item,
  Location,
  DialogueBlock,
  ContinuityBible,
  SceneContinuityBinding
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

/** A user-attached file sent with a chat turn (image, CSV, JSON, text, …) for tools like run_python to read. */
export type ChatAttachmentInput = { name: string; mimeType: string; dataUri: string };

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
  /** Files attached to the CURRENT user turn, decoded server-side for tools like run_python. */
  attachments?: ChatAttachmentInput[];
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
export type ChatArtifact = {
  type: string;
  data: unknown;
  /**
   * Which tool call produced this artifact (stamped by the server's agentic loop).
   * Lets the client re-execute the same call to refresh the widget with live data.
   */
  origin?: { tool: string; args: Record<string, unknown> };
};

/**
 * Tools whose artifacts are pure live-data snapshots, safe to re-execute on demand
 * from the widget's refresh control. Enforced server-side by /api/chat/tool-refresh
 * and mirrored client-side to decide when to show the refresh button.
 */
export const REFRESHABLE_TOOLS = [
  'get_weather',
  'get_news',
  'get_stock',
  'compare_stocks',
  'find_places',
  'crypto_price',
  'exchange_rate',
  'show_map',
  'get_directions',
  'video_search',
  'get_ticker_tape',
  'get_market_sentiment',
  'get_yield_curve',
  'build_portfolio',
  'convert_currency',
  'get_national_debt',
  'show_macro_tiles',
  'get_econ_calendar',
  'get_earnings_calendar',
  'get_flight_status',
  'get_predictions',
  'get_funding_rates',
  'get_stablecoins',
  'get_cot_positioning'
] as const;

// --- Directions artifact (multi-modal routes on a live map) ----------------
// Emitted by the `get_directions` tool: real drive/walk/bike routes (FOSSGIS
// OSRM) with alternatives, rendered as a Google-Maps-style card with a mode
// toggle and an animated route draw.
export interface DirectionsRoute {
  summary?: string;
  distanceKm: number;
  durationMin: number;
  /** [lat, lng] pairs, downsampled for transport. */
  path: Array<[number, number]>;
}
export interface DirectionsModeResult {
  mode: 'drive' | 'walk' | 'bike';
  routes: DirectionsRoute[];
}
export interface DirectionsArtifact {
  origin: { label: string; lat: number; lng: number };
  destination: { label: string; lat: number; lng: number };
  modes: DirectionsModeResult[];
  defaultMode?: 'drive' | 'walk' | 'bike';
  googleMapsUrl?: string;
  transitUrl?: string;
  density?: 'compact' | 'detailed';
}

// --- Guided learning path artifact (structured multi-module course in chat) ---
// Emitted by the `create_learning_path` tool. Progress is tracked client-side
// (localStorage, keyed by `id`) — no server round-trip.
export type LearningStepKind = 'read' | 'practice' | 'quiz' | 'flashcards' | 'project' | 'checkpoint' | 'resource';
export interface LearningStep {
  id: string;
  kind: LearningStepKind;
  title: string;
  /** Markdown lesson body (for `read` steps) or task description. */
  content?: string;
  /** External resource URL (for `resource` steps). */
  url?: string;
  /** A ready-to-send chat prompt ("Quiz me on…") the user can run with one click. */
  prompt?: string;
  estMinutes?: number;
}
export interface LearningModule {
  id: string;
  title: string;
  summary?: string;
  estMinutes?: number;
  steps: LearningStep[];
}
export interface LearningPathArtifact {
  /** Stable id for progress tracking across sessions. */
  id: string;
  title: string;
  topic?: string;
  description?: string;
  level?: 'beginner' | 'intermediate' | 'advanced';
  estMinutes?: number;
  outcomes?: string[];
  modules: LearningModule[];
  palette?: string;
  density?: 'compact' | 'detailed';
}

// --- Travel itinerary artifact (trip plan with map, budget and live context) ---
// Emitted by the `plan_trip` tool. The server enriches the model-composed plan with
// geocoded stop coordinates and a live weather snapshot for the destination.
export type ItineraryStopKind =
  | 'flight'
  | 'transit'
  | 'train'
  | 'bus'
  | 'car'
  | 'ferry'
  | 'walk'
  | 'hotel'
  | 'food'
  | 'sight'
  | 'activity'
  | 'shopping'
  | 'other';
/** Structured transport detail for a travel leg (flight/train/car/ferry/…). When present
 *  the stop renders as a rich "leg" with from → to, carrier/number and depart/arrive
 *  times instead of a plain timeline row. All fields optional — render what we have. */
export interface ItineraryTransport {
  mode?: 'flight' | 'train' | 'bus' | 'car' | 'ferry' | 'walk' | 'transit';
  /** Origin label (city, station, airport code). */
  from?: string;
  /** Destination label. */
  to?: string;
  /** Operator / airline / rail line. */
  carrier?: string;
  /** Flight number, train number, route code. */
  code?: string;
  /** Departure clock time, e.g. "08:15". */
  depart?: string;
  /** Arrival clock time, e.g. "11:40". */
  arrive?: string;
}
export interface ItineraryStop {
  name: string;
  kind?: ItineraryStopKind;
  time?: string;
  durationMin?: number;
  lat?: number;
  lng?: number;
  address?: string;
  notes?: string;
  cost?: number;
  url?: string;
  /** Present on transport stops — renders the rich leg layout. */
  transport?: ItineraryTransport;
}
export interface ItineraryDay {
  label?: string;
  date?: string;
  summary?: string;
  stops: ItineraryStop[];
}
export interface ItineraryArtifact {
  title: string;
  destination?: string;
  startDate?: string;
  endDate?: string;
  travelers?: number;
  currency?: string;
  budget?: { total?: number; lines?: { label: string; amount: number }[] };
  days: ItineraryDay[];
  tips?: string[];
  packing?: string[];
  /** Live destination weather snapshot, attached server-side at plan time. */
  weather?: { description?: string; tempC?: number; tempF?: number; daily?: { date: string; minC?: number; maxC?: number; description?: string; precipProb?: number }[] };
  palette?: string;
  density?: 'compact' | 'detailed';
}

// --- Interactive clarifying questions (the "ask, don't guess" card) ---
// Emitted by the `ask_user` tool when a request is ambiguous or multi-faceted (trip
// planning, a build spec, a recommendation). Instead of dumping a wall of questions as
// text, the model emits this card; the user picks/answers inline and the answers are
// sent back as their next message, so the conversation stays interactive.
export type ClarifyQuestionType = 'single' | 'multi' | 'text';
export interface ClarifyOption {
  /** The chip label shown to the user. */
  label: string;
  /** Optional short hint under the label. */
  hint?: string;
}
export interface ClarifyQuestion {
  /** Stable id used to label the answer in the reply. */
  id: string;
  /** The question text. */
  prompt: string;
  type: ClarifyQuestionType;
  /** For single/multi: the choices. The user can always add their own ("Other"). */
  options?: ClarifyOption[];
  /** Placeholder for free-text questions. */
  placeholder?: string;
  /** Whether an answer is required before submit. Defaults to false. */
  required?: boolean;
}
export interface ClarifyArtifact {
  /** Optional heading, e.g. "A few quick questions". */
  title?: string;
  /** Optional one-line framing, e.g. "so I can tailor your Tokyo trip". */
  intro?: string;
  questions: ClarifyQuestion[];
  /** Submit button label. Defaults to "Send answers". */
  submitLabel?: string;
}

// --- Live ticker tape (multi-asset market strip) ---
// Emitted by the `get_ticker_tape` tool. The server batch-quotes the symbols
// (Yahoo/Stooq, keyless) so every figure is live; refresh re-runs the same call.
export interface TickerTapeItem {
  symbol: string;
  name?: string;
  price: number;
  change: number;
  changePercent: number;
  currency?: string;
  /** ~30 recent closes for the mini sparkline. */
  spark?: number[];
}
export interface TickerTapeArtifact {
  title?: string;
  items: TickerTapeItem[];
  /** ISO timestamp of the quote snapshot. */
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- Market sentiment (fear & greed gauges) ---
// Emitted by `get_market_sentiment`. Stocks score comes from CNN's Fear & Greed
// index, crypto from alternative.me — both live, keyless, best-effort per market.
export interface SentimentComponent {
  label: string;
  score?: number;
  rating?: string;
}
export interface SentimentGauge {
  market: 'stocks' | 'crypto';
  /** 0–100, fear → greed. */
  score: number;
  /** Human band, e.g. "Greed", "Extreme Fear". */
  rating: string;
  /** Prior readings for context (e.g. "1 week ago" → 61). */
  previous?: { label: string; score: number }[];
  /** Recent daily scores, oldest → newest, for the history sparkline. */
  history?: number[];
  /** Sub-indicators (stocks: momentum, breadth, put/call, …). */
  components?: SentimentComponent[];
}
export interface MarketSentimentArtifact {
  title?: string;
  asOf?: string;
  gauges: SentimentGauge[];
  sources?: { name: string; url: string }[];
  density?: 'compact' | 'detailed';
}

// --- US Treasury yield curve ---
// Emitted by `get_yield_curve` from the daily par-yield XML feed (keyless). Carries
// comparison snapshots so the card can morph between today / 1M ago / 1Y ago.
export interface YieldCurvePoint {
  /** Maturity label, e.g. "3M", "2Y", "10Y". */
  label: string;
  /** Maturity in years (0.25 = 3 months) for the x-axis. */
  years: number;
  yieldPct: number;
}
export interface YieldCurveSnapshot {
  date: string;
  points: YieldCurvePoint[];
}
export interface YieldCurveArtifact {
  title?: string;
  latest: YieldCurveSnapshot;
  monthAgo?: YieldCurveSnapshot;
  yearAgo?: YieldCurveSnapshot;
  /** 10Y − 2Y spread in percentage points; negative = inverted. */
  spread10y2y?: number;
  inverted?: boolean;
  density?: 'compact' | 'detailed';
}

// --- Portfolio (live-priced holdings) ---
// Emitted by `build_portfolio`: the model (or user) supplies holdings, the server
// prices every position live and computes P&L/weights — no model arithmetic.
export interface PortfolioPosition {
  symbol: string;
  name?: string;
  shares?: number;
  /** Per-share cost basis, when provided. */
  costBasis?: number;
  price: number;
  change: number;
  changePercent: number;
  currency?: string;
  /** shares × price. */
  value?: number;
  dayPnl?: number;
  totalPnl?: number;
  totalPnlPercent?: number;
  /** Share of total portfolio value (%). */
  weightPct?: number;
  spark?: number[];
}
export interface PortfolioArtifact {
  title?: string;
  currency?: string;
  positions: PortfolioPosition[];
  totals?: {
    value?: number;
    dayPnl?: number;
    dayPnlPercent?: number;
    totalPnl?: number;
    totalPnlPercent?: number;
  };
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- "What changed" diff card ---
// Emitted by `render_whats_changed` — the agent diffs the world since the user
// last looked (prices, news, calendar) and renders a prioritized changelog.
export interface ChangeItem {
  kind?: 'price' | 'news' | 'event' | 'metric' | 'other';
  title: string;
  detail?: string;
  delta?: number;
  deltaPercent?: number;
  /** Importance 1–3 (3 = headline change). */
  weight?: number;
  url?: string;
}
export interface WhatsChangedArtifact {
  title?: string;
  /** The window covered, e.g. "since yesterday", "this week". */
  since?: string;
  summary?: string;
  changes: ChangeItem[];
  density?: 'compact' | 'detailed';
}

// --- Boarding pass (wallet-style flight card) ---
// Emitted by `render_boarding_pass`. Front = the pass; tap flips (3D) to fare/
// baggage/tips. The QR encodes the confirmation code.
export type BoardingPassStatus = 'on-time' | 'delayed' | 'boarding' | 'departed' | 'cancelled';
export interface BoardingPassEndpoint {
  /** IATA code, e.g. "IAD". */
  code: string;
  city?: string;
  /** Local time, e.g. "10:45". */
  time?: string;
  date?: string;
  terminal?: string;
}
export interface BoardingPassArtifact {
  airline: string;
  flightNumber: string;
  from: BoardingPassEndpoint;
  to: BoardingPassEndpoint;
  gate?: string;
  seat?: string;
  boardingGroup?: string;
  boardingTime?: string;
  passenger?: string;
  status?: BoardingPassStatus;
  statusNote?: string;
  /** Confirmation / record locator (encoded into the QR). */
  confirmation?: string;
  fareClass?: string;
  baggage?: string;
  durationMin?: number;
  aircraft?: string;
  /** Agent tips, e.g. "Gate B32 is a 12-min walk". */
  notes?: string[];
  /** Airline brand color hex for the card accent. */
  accent?: string;
  density?: 'compact' | 'detailed';
}

// --- Currency converter (live ECB rates + 30-day context) ---
// Emitted by `convert_currency` (Frankfurter, keyless). The card recomputes
// amounts client-side; refresh re-fetches the live rate.
export interface CurrencyConverterArtifact {
  from: string;
  to: string;
  rate: number;
  amount?: number;
  converted?: number;
  /** Rate date as reported by the ECB. */
  date?: string;
  /** ~30 daily rates, oldest → newest. */
  series?: { date: string; rate: number }[];
  avg30d?: number;
  /** Current rate vs the 30-day average, in percent (positive = above average). */
  vsAvgPct?: number;
  density?: 'compact' | 'detailed';
}

// --- World clocks (live time-zone twins) ---
// Emitted by `render_world_clocks`. Pure client-side live: the card ticks in
// real time via Intl, shades sleep hours, and flags a good window to call.
export interface WorldClockZone {
  label: string;
  /** IANA zone, e.g. "Asia/Kolkata". */
  tz: string;
  /** Waking window for the "good time to call" hint (defaults 8–22). */
  wakeStart?: number;
  wakeEnd?: number;
}
export interface WorldClocksArtifact {
  title?: string;
  zones: WorldClockZone[];
  density?: 'compact' | 'detailed';
}

// --- Packing list (interactive checklist, progress persisted locally) ---
// Emitted by `render_packing_list`. Check-off state is tracked client-side
// (localStorage, keyed by `id`) — no server round-trip.
export interface PackingGroup {
  name?: string;
  items: string[];
}
export interface PackingListArtifact {
  /** Stable id for the locally-persisted check-off state. */
  id: string;
  title: string;
  destination?: string;
  /** Context line, e.g. "5 days · highs 31°C · rain likely". */
  context?: string;
  groups: PackingGroup[];
  tips?: string[];
  density?: 'compact' | 'detailed';
}

// --- Trip countdown hero ---
// Emitted by `render_trip_countdown`. The server attaches a live destination
// weather snapshot; the countdown itself ticks client-side.
export interface TripCountdownArtifact {
  destination: string;
  /** ISO date(-time) the trip starts. */
  startDate: string;
  endDate?: string;
  title?: string;
  /** Live destination weather snapshot, attached server-side. */
  weather?: {
    description?: string;
    tempC?: number;
    daily?: { date: string; minC?: number; maxC?: number; description?: string; precipProb?: number }[];
  };
  /** Prep checklist (display only). */
  checklist?: { text: string; done?: boolean }[];
  accent?: string;
  density?: 'compact' | 'detailed';
}

// --- Goal tracker (interactive, persisted locally) ---
// Emitted by `create_goal_tracker` (the /goal skill). Milestone completion is
// tracked client-side (localStorage, keyed by `id`).
export interface GoalMilestone {
  id: string;
  title: string;
  /** Target date (ISO) when relevant. */
  due?: string;
  notes?: string;
}
export interface GoalTrackerArtifact {
  /** Stable id for the locally-persisted completion state. */
  id: string;
  title: string;
  why?: string;
  /** Target date for the whole goal. */
  targetDate?: string;
  /** Cadence line, e.g. "3 sessions / week". */
  cadence?: string;
  metric?: { label: string; start?: number; target?: number; unit?: string };
  milestones: GoalMilestone[];
  nextActions?: string[];
  density?: 'compact' | 'detailed';
}

// --- Code review card ---
// Emitted by `render_code_review` (the /code-review skill). For GitHub PRs the
// recipe first pulls the real diff via `fetch_github_pr`, so findings cite real
// files/lines.
export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'nit';
export type ReviewCategory = 'correctness' | 'security' | 'performance' | 'readability' | 'style' | 'testing' | 'other';
export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  detail?: string;
  file?: string;
  line?: number;
  /** Suggested fix, shown as a code block. */
  suggestion?: string;
  category?: ReviewCategory;
}
export interface CodeReviewArtifact {
  title?: string;
  /** What was reviewed, e.g. a PR URL or "pasted diff". */
  target?: string;
  verdict: 'approve' | 'approve-with-nits' | 'request-changes';
  summary?: string;
  /** 0–10 dimension scores (correctness, readability, …). */
  scores?: { label: string; score: number }[];
  findings: ReviewFinding[];
  stats?: { files?: number; additions?: number; deletions?: number };
  /** Things done well — reviews should not only criticize. */
  positives?: string[];
  density?: 'compact' | 'detailed';
}

// --- Live monitor (auto-refreshing widget loop) ---
// Emitted by `create_monitor` (the /loop skill). Wraps one refresh-whitelisted
// tool call; the client re-runs it on the interval while the widget is visible,
// so the embedded artifact stays live without any model round-trip.
export interface LiveMonitorArtifact {
  label?: string;
  /** The REFRESHABLE_TOOLS member this monitor re-runs. */
  tool: string;
  args: Record<string, unknown>;
  /** Refresh cadence in seconds (clamped 30–3600 by the tool). */
  intervalSec: number;
  /** The initial snapshot (replaced on every tick). */
  artifact?: ChatArtifact;
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- Macro indicator tiles (Apple-Weather-style wall) ---
// Emitted by `show_macro_tiles`. The model composes the tile set; when
// FRED_API_KEY is configured the server fills any tile carrying a `seriesId`
// with the live FRED value, change and sparkline.
export interface MacroTile {
  /** Display label, e.g. "CPI (YoY)". */
  label: string;
  /** FRED series id for live fill, e.g. "CPIAUCSL", "UNRATE", "FEDFUNDS". */
  seriesId?: string;
  value?: string | number;
  unit?: string;
  /** Change vs the previous reading. */
  delta?: number;
  deltaPercent?: number;
  /** Recent readings, oldest → newest. */
  spark?: number[];
  /** Next scheduled release (ISO date) for the countdown. */
  nextRelease?: string;
  source?: string;
  asOf?: string;
}
export interface MacroTilesArtifact {
  title?: string;
  tiles: MacroTile[];
  /** True when values were filled from live FRED data. */
  live?: boolean;
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- Economic calendar timeline ---
// Emitted by `get_econ_calendar`. Live when FINNHUB_API_KEY is configured
// (and the account tier includes the economic calendar); model-supplied
// otherwise. Past events render actual-vs-forecast beat/miss coloring.
export interface EconEvent {
  /** ISO datetime of the release. */
  time: string;
  title: string;
  /** ISO 3166 country/region code, e.g. "US", "EU". */
  country?: string;
  /** 1 = low, 2 = medium, 3 = high importance. */
  importance?: 1 | 2 | 3;
  actual?: string | number;
  forecast?: string | number;
  previous?: string | number;
  unit?: string;
}
export interface EconCalendarArtifact {
  title?: string;
  events: EconEvent[];
  /** True when events came from a live provider. */
  live?: boolean;
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- Earnings countdown carousel ---
// Emitted by `get_earnings_calendar`. Live when FINNHUB_API_KEY is configured;
// model-supplied otherwise. `impliedMovePct` and `preview` are agent-authored.
export type EarningsSession = 'pre' | 'after' | 'during' | 'unknown';
export interface EarningsItem {
  symbol: string;
  name?: string;
  /** Report date (ISO). */
  date: string;
  session?: EarningsSession;
  epsEstimate?: number;
  epsActual?: number;
  revenueEstimate?: number;
  /** Options-implied move in percent (agent/estimated unless options data wired). */
  impliedMovePct?: number;
  /** Agent's one-line preview ("Watch DC revenue guide"). */
  preview?: string;
}
export interface EarningsCalendarArtifact {
  title?: string;
  items: EarningsItem[];
  live?: boolean;
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- Central bank watch ---
// Emitted by `render_central_banks` (model-authored; rates change rarely and
// the implied path has no free live source yet — see docs/features/data-connectors.md).
export interface CentralBank {
  /** "Federal Reserve", "ECB", "Bank of Japan"… */
  name: string;
  /** Short code for the avatar chip, e.g. "Fed". */
  code?: string;
  rateName?: string;
  ratePct: number;
  /** Next policy meeting (ISO date) for the countdown ring. */
  nextMeeting?: string;
  /** Market-implied path points for the mini chart. */
  impliedPath?: { label: string; ratePct: number }[];
  /** e.g. "+25 bps · Mar 2026". */
  lastChange?: string;
  /** One-liner on the latest central-bank speak. */
  summary?: string;
}
export interface CentralBankWatchArtifact {
  title?: string;
  banks: CentralBank[];
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- P&L calendar heatmap (GitHub-contribution style) ---
// Emitted by `render_pnl_calendar` from user/model-supplied daily values.
export interface PnlDay {
  /** ISO date. */
  date: string;
  value: number;
  note?: string;
}
export interface PnlCalendarArtifact {
  title?: string;
  currency?: string;
  /** Unit when not a currency (e.g. "%"). */
  unit?: string;
  days: PnlDay[];
  density?: 'compact' | 'detailed';
}

// --- National debt clock (live odometer) ---
// Emitted by `get_national_debt` from the Treasury FiscalData API (keyless).
// The client animates a per-second tick derived from the recent drift.
export interface DebtClockArtifact {
  label?: string;
  /** Latest reported level (USD). */
  amount: number;
  /** Record date of `amount`. */
  asOf: string;
  /** Estimated drift per second (from the last two records). */
  perSecond?: number;
  previous?: { date: string; amount: number };
  source?: string;
  density?: 'compact' | 'detailed';
}

// --- Flight status tracker ---
// Emitted by `get_flight_status`. Live when AVIATIONSTACK_API_KEY is set
// (real-time status/delays/gates); renders schedule-only (model-supplied)
// otherwise, with `live: false`.
export type FlightPhase = 'scheduled' | 'active' | 'landed' | 'cancelled' | 'diverted' | 'unknown';
export interface FlightEndpointStatus {
  /** IATA code. */
  code: string;
  city?: string;
  scheduled?: string;
  estimated?: string;
  actual?: string;
  terminal?: string;
  gate?: string;
  /** Coordinates for the great-circle arc, when known. */
  lat?: number;
  lng?: number;
}
export interface FlightStatusArtifact {
  airline?: string;
  flightNumber: string;
  status: FlightPhase;
  statusNote?: string;
  departure: FlightEndpointStatus;
  arrival: FlightEndpointStatus;
  /** 0–100 along the route (drives the plane position on the arc). */
  progressPct?: number;
  altitudeM?: number;
  speedKmh?: number;
  delayMin?: number;
  /** True when data came from a live provider (vs schedule-only). */
  live?: boolean;
  asOf?: string;
  density?: 'compact' | 'detailed';
}

// --- Trip budget burn ---
// Emitted by `render_trip_budget`. The card computes burn pace client-side
// ("at this rate you exceed budget by day N") from the dates + spend.
export interface BudgetCategory {
  label: string;
  spent: number;
  budget?: number;
}
export interface TripBudgetArtifact {
  title?: string;
  currency?: string;
  /** Total trip budget. */
  total: number;
  /** Spent so far. */
  spent: number;
  startDate?: string;
  endDate?: string;
  categories?: BudgetCategory[];
  density?: 'compact' | 'detailed';
}

// --- Local cheat-sheet (destination survival card) ---
// Emitted by `render_cheatsheet` (model-authored per city).
export interface CheatsheetPhrase {
  local: string;
  meaning: string;
  /** Phonetic pronunciation hint. */
  say?: string;
}
export interface LocalCheatsheetArtifact {
  destination: string;
  language?: string;
  currency?: string;
  /** General emergency number, e.g. "112". */
  emergency?: string;
  police?: string;
  ambulance?: string;
  tipping?: string;
  /** Plug letters, e.g. "Type A / B". */
  plug?: string;
  voltage?: string;
  /** Cash vs card norms. */
  cashNorm?: string;
  tapWater?: string;
  phrases?: CheatsheetPhrase[];
  /** Scam warnings. */
  warnings?: string[];
  etiquette?: string[];
  density?: 'compact' | 'detailed';
}

// --- Loyalty wallet (stacked membership cards) ---
// Emitted by `render_loyalty_wallet` from user-supplied program data.
export interface LoyaltyCard {
  program: string;
  member?: string;
  number?: string;
  points?: number;
  /** "miles", "points", "nights". */
  pointsLabel?: string;
  tier?: string;
  tierProgress?: { value: number; max: number; nextTier?: string };
  expiry?: string;
  /** Brand color hex. */
  accent?: string;
  /** Agent suggestion ("use 24k points for this leg?"). */
  note?: string;
}
export interface LoyaltyWalletArtifact {
  title?: string;
  cards: LoyaltyCard[];
  density?: 'compact' | 'detailed';
}

// --- Smart widget stack (auto-rotating stack of live widgets) ---
// Emitted by `create_widget_stack`: the server executes up to four refreshable
// tool calls and embeds their snapshots; the client rotates between them
// (pause on hover, dots to jump, manual-only under reduced motion) and each
// card refreshes through its own origin.
export interface WidgetStackArtifact {
  label?: string;
  /** Rotation cadence in seconds (default 8, clamped 4–60). */
  intervalSec?: number;
  /** Embedded artifact snapshots (each stamped with its origin). */
  items: ChatArtifact[];
  density?: 'compact' | 'detailed';
}

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

// --- Code exercise / playground artifact (run real JavaScript while learning) ---
// Emitted by the `code_exercise` tool. The AI provides a task + starter code; the user
// edits and RUNS it in a sandboxed Web Worker, seeing real console output and real
// JS errors (with stack). A small, safe "terminal with legit execution errors".
export interface CodeExerciseArtifact {
  title?: string;
  instructions?: string;
  task?: string;
  /** Language label. JavaScript runs live; other labels render as read-only starters. */
  language?: string;
  /** Starter code to prefill the editor. */
  starterCode?: string;
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

/** One AI-generated "what to build next" recommendation, shown under the iterate composer. */
export interface StudioSuggestion {
  /** Short chip/card label (e.g. "Add user accounts"). */
  label: string;
  /** The full refine prompt this suggestion runs when picked. */
  prompt: string;
  /** One-line rationale — why this is worth doing next. */
  why?: string;
  /** Coarse grouping so the UI can tag it (feature / polish / fix / data / ship). */
  kind?: 'feature' | 'polish' | 'fix' | 'data' | 'ship';
}

export interface StudioSuggestResult {
  suggestions: StudioSuggestion[];
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
  /** Coarse category for the pin glyph: food, cafe, bar, hotel, park, sight,
   *  shop, transit, flight, activity — anything else gets the default dot. */
  category?: string;
  /** Pin color override (e.g. day-coded markers on a whole-trip map). Defaults to accent. */
  color?: string;
}
/** Route summary shown as a chip on the map (mode + time + distance + tolls). */
export interface MapRouteInfo {
  /** Travel mode the user prefers, e.g. 'drive' | 'walk' | 'transit' | 'train' | 'flight'. */
  mode?: string;
  durationMin?: number;
  distanceKm?: number;
  /** Free-text toll estimate, e.g. "$25–40 tolls". */
  tollCost?: string;
}
/** One colored leg of a multi-segment route — e.g. a day's path on a whole-trip map,
 *  or a flight drawn as a curved arc. Each segment animates in sequentially. */
export interface MapRouteSegment {
  /** Ordered points for this leg. */
  points: { lat: number; lng: number }[];
  /** Line color (defaults to the accent). */
  color?: string;
  /** Short legend label, e.g. "Day 1" or "Tokyo → Kyoto". */
  label?: string;
  /** Dashed line (used for flights/ferries and inter-day connectors). */
  dashed?: boolean;
  /** Bow the leg into a curved arc between its endpoints — for flights/long hops. */
  arc?: boolean;
}
export interface MapArtifact {
  title?: string;
  markers: MapMarker[];
  /** Summary of the drawn route, rendered as a glass chip over the map. */
  routeInfo?: MapRouteInfo;
  /** Ordered points for a single drawn route/path between places, if any. */
  route?: { lat: number; lng: number }[];
  /** Multiple colored legs (day-by-day trip route, flight arcs). When present they
   *  draw in sequentially and a color legend is shown; coexists with `route`. */
  segments?: MapRouteSegment[];
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

// --- Multi-symbol comparison ("compare trends") ---
/** One asset overlaid on a comparison chart. Carries the same pre-bucketed history
 *  per range as a quote card, plus a headline price, so the card can switch
 *  timeframes and rebase to % without a round-trip. */
export interface StockComparisonSeries {
  symbol: string;
  name?: string;
  /** Explicit line color; otherwise the card assigns one from the palette ramp. */
  color?: string;
  /** Latest price (for the absolute-price overlay + legend). */
  last?: number;
  /** ISO 4217 currency of `last` (default USD). */
  currency?: string;
  /** Pre-bucketed closing-price history per range (same shape as StockQuoteArtifact.ranges). */
  ranges?: Partial<Record<StockRange, StockPoint[]>>;
  /** Closing prices used when `ranges` is absent (sub-ranges are then derived from it). */
  series?: StockPoint[];
}
/** A multi-symbol "compare trends" chart: 2–6 assets overlaid on one chart, switchable
 *  across time ranges (1D…MAX) and between % change — rebased to the start of the
 *  window, the right way to compare assets at very different price scales (gold vs oil
 *  vs the S&P) — and absolute price. Emitted by the `compare_stocks` tool. */
export interface StockComparisonArtifact {
  title?: string;
  subtitle?: string;
  /** When the snapshot was taken (ISO). */
  asOf?: string;
  /** 2–6 assets to overlay. */
  series: StockComparisonSeries[];
  /** Range tabs to expose; defaults to the ranges every series shares. */
  ranges?: StockRange[];
  /** Initially-selected range (default: a sensible shared window). */
  defaultRange?: StockRange;
  /** Default y-axis: 'percent' (rebased — best for comparison) or 'price' (absolute). */
  mode?: 'percent' | 'price';
  /** Named palette for the series color ramp. */
  palette?: string;
  density?: 'compact' | 'detailed';
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

// --- Customizable dashboard (glass widget board) ---
// A drag-to-rearrange board of live widgets the model composes for ANY field — study
// plans, market watch, trip itineraries, fitness, project status. Rendered with the
// macOS-glass treatment (frosted cards over a soft gradient); layout edits persist
// locally per dashboard. Emitted by the `create_dashboard` tool.
export type DashboardWidgetKind =
  | 'clock'      // live time in one or more time zones
  | 'countdown'  // live countdown to a date/time (exam, launch, flight)
  | 'stat'       // big value + delta + sparkline
  | 'chart'      // line/area/bar chart
  | 'progress'   // goal progress ring
  | 'list'       // checklist / watchlist / steps
  | 'globe'      // minimalist globe with plotted points + great-circle arcs (flights, offices)
  | 'note'       // freeform markdown-ish note / quote
  | 'links';     // quick links

export interface DashboardGlobePoint { label: string; lat: number; lon: number; }
export interface DashboardWidget {
  id: string;
  kind: DashboardWidgetKind;
  title?: string;
  /** Grid footprint: sm = 1 cell, md = 2 cells wide, lg = full row. */
  size?: 'sm' | 'md' | 'lg';
  /** clock */
  timeZones?: { label: string; tz: string }[];
  /** countdown */
  target?: string; // ISO datetime
  /** stat */
  value?: string | number;
  unit?: string;
  delta?: number;
  deltaPercent?: number;
  spark?: number[];
  /** chart */
  points?: { x: string | number; y: number }[];
  chartVariant?: 'line' | 'area' | 'bar';
  /** progress */
  progress?: { value: number; max: number; label?: string };
  /** list */
  items?: { text: string; done?: boolean; meta?: string }[];
  /** globe */
  globePoints?: DashboardGlobePoint[];
  /** Arcs drawn between point labels, e.g. [["SFO","NRT"]] for a flight path. */
  globeArcs?: [string, string][];
  /** note */
  text?: string;
  /** links */
  links?: { label: string; url: string }[];
}

export interface DashboardArtifact {
  title: string;
  subtitle?: string;
  widgets: DashboardWidget[];
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

// --- Generative UI (agent-composed layouts) ---
// A safe, WHITELISTED block tree the model emits to compose a BESPOKE in-chat layout
// when no fixed card fits ("custom-build structures, alignments"). Rendered by
// GenerativeUICard from the Primitive Kit only — no raw HTML, no code execution. The
// renderer normalizes/validates first (depth + node caps, prop coercion, src
// allowlisting), so a malformed or oversized tree degrades gracefully instead of
// throwing. This is also the canonical render target the code sandbox emits into.
export type UIBlockGap = 0 | 1 | 2 | 3 | 4;
export type UIAlign = 'start' | 'center' | 'end' | 'stretch' | 'baseline';

export interface UIStackBlock { kind: 'stack'; gap?: UIBlockGap; align?: UIAlign; children: UIBlock[] }
export interface UIRowBlock { kind: 'row'; gap?: UIBlockGap; align?: UIAlign; wrap?: boolean; children: UIBlock[] }
export interface UIGridBlock { kind: 'grid'; columns?: 1 | 2 | 3 | 4; gap?: UIBlockGap; children: UIBlock[] }
export interface UISectionBlock { kind: 'section'; title?: string; accent?: string; children: UIBlock[] }
export interface UIDividerBlock { kind: 'divider' }
export interface UIHeadingBlock { kind: 'heading'; text: string; level?: 1 | 2 | 3 }
export interface UITextBlock { kind: 'text'; text: string; tone?: 'default' | 'muted' | 'strong'; align?: 'left' | 'center' | 'right' }
export interface UIBadgeBlock { kind: 'badge'; text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }
export interface UIPillBlock { kind: 'pill'; label?: string; change?: number; changePercent?: number }
export interface UIKeyValueBlock { kind: 'keyValue'; items: { label: string; value: string }[] }
export interface UICalloutBlock { kind: 'callout'; tone?: 'info' | 'good' | 'warn' | 'bad'; title?: string; text: string }
export interface UIImageBlock { kind: 'image'; src: string; alt?: string; caption?: string; ratio?: '1:1' | '4:3' | '16:9' }
export interface UIProgressBlock { kind: 'progress'; value: number; max?: number; label?: string; color?: string }
export interface UIMetricBlock { kind: 'metric'; label: string; value: string | number; unit?: string; delta?: number; deltaPercent?: number; spark?: number[] }
export interface UISparklineBlock { kind: 'sparkline'; values: number[]; color?: string }
export interface UITimelineBlock { kind: 'timeline'; items: { title: string; time?: string; text?: string; accent?: string }[] }
export interface UIRatingBlock { kind: 'rating'; value: number; max?: number; count?: number; label?: string }
export interface UITagsBlock { kind: 'tags'; items: string[] }
export interface UIGaugeBlock { kind: 'gauge'; value: number; max?: number; label?: string; unit?: string; color?: string }
export interface UIBarsBlock { kind: 'bars'; items: { label: string; value: number; color?: string }[]; max?: number }
export interface UIChartBlock { kind: 'chart'; chart: ChartArtifact }
export interface UITableBlock { kind: 'table'; table: DataTableArtifact }

export type UIBlock =
  | UIStackBlock | UIRowBlock | UIGridBlock | UISectionBlock | UIDividerBlock
  | UIHeadingBlock | UITextBlock | UIBadgeBlock | UIPillBlock | UIKeyValueBlock
  | UICalloutBlock | UIImageBlock | UIProgressBlock | UITimelineBlock | UIRatingBlock | UITagsBlock | UIGaugeBlock | UIBarsBlock
  | UIMetricBlock | UISparklineBlock | UIChartBlock | UITableBlock;

export interface GenerativeUIArtifact {
  title?: string;
  subtitle?: string;
  /** Accent hex for the card strip. */
  accent?: string;
  /** A named kit palette ("brand" | "ocean" | "sunset" | "violet" | "bull" | "bear" | "mono"). */
  palette?: string;
  /** The block tree. */
  root: UIBlock;
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
