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
};

export type ApiTimings = {
  apiMs?: number;
  saveMs?: number;
  totalMs?: number;
};

export type AnalyzeScriptRequest = { script: string };
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

export type ExtractWorldRequest = { scenes: Scene[]; script: string };
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
    description: string;
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
