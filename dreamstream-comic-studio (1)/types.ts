
export type AspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
export type ImageResolution = "1K" | "2K" | "4K";
export type ImageProviderId = "flux" | "gemini";

export type ImageModelDefinition = {
  id: string;
  label: string;
  provider: ImageProviderId;
  supportsReferences: boolean;
  supportsAspectRatio: boolean;
  defaultSteps?: number;
  isFree?: boolean;
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
  showAssistant?: boolean;
  defaultImageModel?: string;
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

export interface Character {
  id: string;
  name: string;
  bio: string; // Backstory/Personality
  description: string; // Visual prompt
  imageId?: string;
  imageUrl?: string;
  referenceImageIds: string[];
}

export interface Item {
  id: string;
  name: string;
  description: string;
  imageId?: string;
  imageUrl?: string;
  referenceImageIds: string[];
}

export interface Location {
  id: string;
  name: string;
  description: string;
  imageId?: string;
  imageUrl?: string;
  referenceImageIds: string[];
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

export interface ComicState {
  step: number;
  maxStepReached: number;
  flowVersion?: number;
  script: string;
  scriptChecklist?: {
    found: string[];
    missing: string[];
    suggestions: string[];
    updatedAt: number;
  };
  scenes: Scene[];
  continuitySummary?: string;
  overview?: string;
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
  customLayoutPrompt?: string;
  textLayout?: TextLayout;
  panelPlanVersion?: number;
  pricingConfig?: PricingConfig;
  assistantChat?: ChatMessage[];
  imageTags?: Record<string, ImageTag>;
  imageTagCounters?: Record<string, number>;

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
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  coverImage?: string;
  state: ComicState;
  isPublic?: boolean;
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
  STYLE_SELECTION = 1,
  REFERENCE_BUILDER = 2,
  COVER = 3,
  LAYOUT_SELECTION = 4,
  COMBINED_PREVIEW = 5,
  FULL_GENERATION = 6,
  REVIEW_EXPORT = 7
}

export interface UserProfile {
  id: string; // references auth.users
  username?: string; // UNIQUE
  email: string;
  avatar_url?: string;
  bio?: string;
  full_name?: string;
  website?: string;
  created_at: string;
  updated_at?: string;
  is_premium?: boolean; // From usage_limits join
  credits?: number; // From usage_limits
}

export interface Comment {
  id: string;
  project_id: string;
  user_id: string;
  text: string;
  created_at: string;
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
  type: 'follow' | 'comment' | 'like';
  entity_id?: string;
  is_read: boolean;
  created_at: string;
  actor?: { username: string; avatar_url?: string };
}

export interface CommentLike {
  id: string;
  user_id: string;
  comment_id: string;
  created_at: string;
}
