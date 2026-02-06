import { AspectRatio, ImageResolution, Scene, Character, Item, Location, DialogueBlock, Project } from './types.js';

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
};
export type PanelBreakdownResponse = {
  panels: Array<{ description: string; dialogue: string; dialogueBlocks?: DialogueBlock[] }>;
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
};
export type ImageGenerateResponse = {
  dataUrl: string;
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
};
export type FluxGenerateResponse = {
  dataUrl: string;
  mimeType: string;
  prompt: string;
  timings?: ApiTimings;
  model: string;
};

export type AssistantMessage = { role: 'user' | 'model'; text: string };

export type StoryAssistantRequest = {
  script: string;
  message: string;
  history: AssistantMessage[];
};
export type StoryAssistantResponse = {
  text: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
};

export type MasterAssistantContext = {
  view: string;
  project?: Project;
  systemStatus?: any;
  reportSummary?: any;
  artifactSummary?: any;
  panelPlanSummary?: any;
  pricingConfig?: any;
  allProjectsSummary?: any;
  projectSnapshot?: any;
  appSnapshot?: any;
  testLabSummary?: any;
  testLabRecentRuns?: any;
};

export type MasterAssistantRequest = {
  message: string;
  history: AssistantMessage[];
  context: MasterAssistantContext;
};
export type MasterAssistantResponse = {
  text: string;
  prompt: string;
  responseText?: string;
  usage?: ApiUsage;
  model: string;
};

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
  geminiKeyPresent: boolean;
  pixazoKeyPresent: boolean;
  message?: string;
};
