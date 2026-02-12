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
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
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
};

export type ExtractWorldRequest = { scenes: Scene[] };
export type ExtractWorldResponse = {
  characters: Character[];
  items: Item[];
  locations: Location[];
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
};

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
};

export type LayoutAnalysisRequest = { images: string[] };
export type LayoutAnalysisResponse = {
  description: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
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
  timings?: ApiTimings;
  model: string;
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
  planTier?: 'free' | 'pro' | 'admin';
  usage?: {
    imagesGenerated?: number;
    maxImagesAllowed?: number;
    hasByok?: boolean;
    isPremium?: boolean;
  };
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
};

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
