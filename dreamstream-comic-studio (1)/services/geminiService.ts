import { post, get, ApiError } from './apiClient';
import {
  AnalyzeScriptRequest,
  AnalyzeScriptResponse,
  StoryOutlineRequest,
  StoryOutlineResponse,
  StoryDraftRequest,
  StoryDraftResponse,
  ExtractWorldRequest,
  ExtractWorldResponse,
  PanelBreakdownRequest,
  PanelBreakdownResponse,
  LayoutAnalysisRequest,
  LayoutAnalysisResponse,
  ImageGenerateRequest,
  ImageGenerateResponse,
  StoryAssistantRequest,
  StoryAssistantResponse,
  MasterAssistantRequest,
  MasterAssistantResponse,
  ContinuitySummaryRequest,
  ContinuitySummaryResponse,
  TestLabReportRequest,
  TestLabReportResponse,
  SystemStatusResponse,
  AssistantMessage
} from '../apiTypes';
import { GenerationArtifact, Character, Item, Location } from '../types';
import { saveArtifact, saveImage, saveTestImage, getImageUrl, getTestImageUrl, getImageDataUrl } from './db';
import { IMAGE_TEXT_BLOCKER, NO_TEXT_IN_IMAGE, TEXT_MODEL, IMAGE_MODEL } from './modelPolicy';
import { cropImageToRatio } from './imageUtils';
import { updateDebugState } from './debugStore';
import { getModelSpecificKey } from './appSettings';

// --- Generic Helper ---

const recordArtifact = async (artifact: Omit<GenerationArtifact, 'id'>) => {
  try {
    await saveArtifact({ id: crypto.randomUUID(), ...artifact });
  } catch (e) {
    console.warn('Failed to record artifact', e);
  }
};

const handleGeminiError = (label: string, error: unknown) => {
  const message = error instanceof ApiError ? error.message : String(error);
  updateDebugState('gemini', { lastError: message, lastRequestType: label, lastRequestAt: Date.now() });
  throw error;
};

/**
 * Generic wrapper for Gemini API calls to handle timing, debug state, and artifact recording.
 */
async function safeGeminiCall<TRes extends {
  model?: string;
  usage?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number };
  prompt?: string;
  responseText?: string;
  timings?: { apiMs?: number; saveMs?: number; totalMs?: number }
}>(
  label: string,
  projectId: string | undefined,
  artifactType: 'text' | 'image' | 'system',
  artifactStage: string,
  fn: () => Promise<TRes>,
  errorPrompt?: string
): Promise<TRes> {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: label, lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await fn();
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: artifactType,
        provider: 'gemini',
        model: response.model || TEXT_MODEL,
        stage: artifactStage,
        prompt: response.prompt || '',
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { ...(response.timings || {}), durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response;
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: artifactType,
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: artifactStage,
        prompt: errorPrompt || '',
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError(label, e);
    throw e;
  }
}

// --- Exported Functions ---

export const checkSystemStatus = async (): Promise<SystemStatusResponse> => {
  try {
    return await get<SystemStatusResponse>('/api/system/status');
  } catch (e) {
    handleGeminiError('system_status', e);
    return { status: 'error', geminiKeyPresent: false, pixazoKeyPresent: false, message: String(e) };
  }
};

export const analyzeScript = async (script: string, projectId?: string) => {
  const response = await safeGeminiCall(
    'analyze_script',
    projectId,
    'text',
    'script',
    async () => {
      const apiKey = getModelSpecificKey(TEXT_MODEL);
      return await post<AnalyzeScriptRequest, AnalyzeScriptResponse>('/api/text/analyze-script', { script }, { apiKey: apiKey || undefined });
    },
    script
  );
  return response.scenes;
};

export const generateStoryOutline = async (inputs: StoryOutlineRequest, projectId?: string) => {
  const response = await safeGeminiCall(
    'story_outline',
    projectId,
    'text',
    'story_outline',
    async () => post<StoryOutlineRequest, StoryOutlineResponse>('/api/text/story-outline', inputs),
    JSON.stringify(inputs)
  );
  return response.outline || '';
};

export const generateScriptDraft = async (inputs: StoryDraftRequest, projectId?: string) => {
  const response = await safeGeminiCall(
    'story_draft',
    projectId,
    'text',
    'story_draft',
    async () => post<StoryDraftRequest, StoryDraftResponse>('/api/text/story-draft', inputs),
    JSON.stringify(inputs)
  );
  return response.script || '';
};

export const extractWorldDetails = async (scenes: ExtractWorldRequest['scenes'], projectId?: string) => {
  if (!scenes || scenes.length === 0) {
    return { characters: [], items: [], locations: [] };
  }
  const response = await safeGeminiCall(
    'extract_world',
    projectId,
    'text',
    'world',
    async () => post<ExtractWorldRequest, ExtractWorldResponse>('/api/text/extract-world', { scenes }),
    scenes.map(s => s.synopsis || s.rawText).join('\n')
  );
  return {
    characters: response.characters,
    items: response.items,
    locations: response.locations
  };
};

export const generatePanelBreakdown = async (
  scene: PanelBreakdownRequest['scene'],
  style: PanelBreakdownRequest['style'],
  layoutType: PanelBreakdownRequest['layoutType'],
  projectId?: string,
  panelCount: number = 3,
  options?: { stage?: string; abortSignal?: AbortSignal }
) => {
  const response = await safeGeminiCall(
    'panel_breakdown',
    projectId,
    'text',
    options?.stage || 'preview',
    async () => post<PanelBreakdownRequest, PanelBreakdownResponse>('/api/text/panel-breakdown', {
      scene,
      style,
      layoutType,
      panelCount,
      stage: options?.stage
    }, { signal: options?.abortSignal }),
    scene?.synopsis || scene?.rawText || ''
  );
  return response.panels || [];
};

export const analyzeLayoutFromImages = async (images: string[], projectId?: string) => {
  const response = await safeGeminiCall(
    'analyze_layout',
    projectId,
    'text',
    'layout',
    async () => post<LayoutAnalysisRequest, LayoutAnalysisResponse>('/api/vision/analyze-layout', { images }),
    'Analyze layout'
  );
  return response.description || 'Could not analyze layout.';
};

export const generateImage = async (
  prompt: string,
  aspectRatio: ImageGenerateRequest['aspectRatio'] = '1:1',
  resolution: ImageGenerateRequest['resolution'] = '1K',
  referenceImageIds: string[] = [],
  projectId?: string,
  options?: { abortSignal?: AbortSignal; stage?: string; cropToRatio?: string; storage?: 'project' | 'test'; meta?: Record<string, unknown>; modelId?: string }
) => {
  // Special handling for generateImage since it has unique artifact fields (images) and logic
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'generate_image', lastError: undefined });
  const finalPrompt = NO_TEXT_IN_IMAGE ? `${prompt}\n\n${IMAGE_TEXT_BLOCKER}` : prompt;
  const startPerf = performance.now();

  try {
    const referenceDataUrls = await Promise.all(referenceImageIds.map((id) => getImageDataUrl(id)));
    const validReferenceImages = referenceDataUrls.filter((img): img is string => !!img);
    const targetModel = options?.modelId || IMAGE_MODEL;
    const apiKey = getModelSpecificKey(targetModel);

    const response = await post<ImageGenerateRequest & { model?: string }, ImageGenerateResponse>('/api/image/gemini', {
      prompt: finalPrompt,
      aspectRatio,
      resolution,
      referenceImages: validReferenceImages,
      stage: options?.stage,
      model: options?.modelId
    }, { signal: options?.abortSignal, apiKey: apiKey || undefined });

    let dataUrl = response.dataUrl;
    if (options?.cropToRatio) {
      dataUrl = await cropImageToRatio(dataUrl, options.cropToRatio);
    }

    const imageId = options?.storage === 'test' ? await saveTestImage(dataUrl) : await saveImage(dataUrl);
    const imageUrl = options?.storage === 'test'
      ? (await getTestImageUrl(imageId)) || dataUrl
      : (await getImageUrl(imageId)) || dataUrl;

    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'image',
        provider: 'gemini',
        model: response.model || 'gemini-image',
        stage: options?.stage || 'generation',
        prompt: response.prompt,
        inputImageIds: referenceImageIds,
        outputImageId: imageId,
        aspectRatio,
        resolution,
        success: true,
        timings: { ...response.timings, durationMs: Math.round(performance.now() - startPerf) },
        meta: options?.meta,
        usage: response.usage
      });
    }

    return { imageId, imageUrl, timings: response.timings };
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'image',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: options?.stage || 'generation',
        prompt: finalPrompt,
        inputImageIds: referenceImageIds,
        aspectRatio,
        resolution,
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) },
        meta: options?.meta
      });
    }
    handleGeminiError('generate_image', e);
    throw e;
  }
};

export const queryStoryAssistant = async (
  script: string,
  message: string,
  history: AssistantMessage[]
): Promise<string> => {
  // Simpler call, no artifact recording needed generally, or we could add it.
  // Keeping as is for now but wrapped in safe try/catch via direct call if we wanted, 
  // but it doesn't match the recordArtifact pattern exactly (no projectId).
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'story_assistant', lastError: undefined });
  try {
    const response = await post<StoryAssistantRequest, StoryAssistantResponse>('/api/assistant/story', {
      script,
      message,
      history
    });
    return response.text || "";
  } catch (e) {
    handleGeminiError('story_assistant', e);
    throw e;
  }
};

export const suggestStyle = async (script: string): Promise<string> => {
  const message = "Analyze this script and suggest a unique, creative visual style for a comic adaptation. Provide a concise, evocative style prompt (art style, colors, mood) suitable for an image generator. Output ONLY the prompt, no intro.";
  return await queryStoryAssistant(script, message, []);
};

export const suggestFormFactor = async (script: string): Promise<string> => {
  const message = "Analyze this script and suggest the best aspect ratio (Form Factor) for a comic book adaptation. Options: '1:1', '3:4', '4:3', '9:16', '16:9'. Return ONLY the ratio string (e.g. '16:9').";
  const result = await queryStoryAssistant(script, message, []);
  const match = result.match(/\d+:\d+/);
  return match ? match[0] : '1:1';
};

export const checkConsistency = async (
  script: string,
  entities: { characters: Character[], items: Item[], locations: Location[] }
): Promise<Record<string, string[]>> => {
  const message = `Analyze the consistency of the following world entities with the script. 
  Identify contradictions, anachronisms, or logic gaps (e.g. a character described as tall in script but short in bio, or a sci-fi gun in a medieval story).
  
  Entities JSON:
  ${JSON.stringify(entities)}

  Return a JSON object where keys are Entity IDs and values are arrays of warning strings. 
  If an entity is fine, omit it or return empty array.
  Example: { "char-123": ["Contradicts script: described as blonde but bio says dark hair"] }
  RETURN ONLY JSON.`;

  const result = await queryStoryAssistant(script, message, []);
  try {
    const jsonStr = result.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.warn("Failed to parse consistency check", e);
    return {};
  }
};

export const queryMasterAssistant = async (
  userMessage: string,
  history: AssistantMessage[],
  context: MasterAssistantRequest['context']
): Promise<string> => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'assistant', lastError: undefined });
  try {
    const response = await post<MasterAssistantRequest, MasterAssistantResponse>('/api/assistant/master', {
      message: userMessage,
      history,
      context
    });
    return response.text || "";
  } catch (e) {
    handleGeminiError('assistant', e);
    return "I'm having trouble connecting to the studio mainframe. Please try again in a moment.";
  }
};

export const updateContinuitySummary = async (
  currentSummary: string | undefined,
  scene: ContinuitySummaryRequest['scene'],
  panels: ContinuitySummaryRequest['panels'],
  projectId?: string
) => {
  // Using explicit try/catch because of the "return currentSummary" fallback logic
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'continuity_summary', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<ContinuitySummaryRequest, ContinuitySummaryResponse>('/api/text/continuity-summary', {
      currentSummary,
      scene,
      panels
    });
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model || TEXT_MODEL,
        stage: 'generation',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response.summary || currentSummary || '';
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: 'generation',
        prompt: scene?.synopsis || scene?.rawText || '',
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('continuity_summary', e);
    return currentSummary || '';
  }
};

export const analyzeTestLabReport = async (report: Record<string, unknown>): Promise<string> => {
  const response = await safeGeminiCall(
    'testlab_report',
    undefined,
    'text',
    'testlab',
    async () => post<TestLabReportRequest, TestLabReportResponse>('/api/text/testlab-report', { report })
  );
  return response.text || '';
};
