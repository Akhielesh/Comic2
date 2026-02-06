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
import { GenerationArtifact } from '../types';
import { saveArtifact, saveImage, saveTestImage, getImageUrl, getTestImageUrl, getImageDataUrl } from './db';
import { IMAGE_TEXT_BLOCKER, NO_TEXT_IN_IMAGE, TEXT_MODEL } from './modelPolicy';
import { cropImageToRatio } from './imageUtils';
import { updateDebugState } from './debugStore';

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

export const checkSystemStatus = async (): Promise<SystemStatusResponse> => {
  try {
    return await get<SystemStatusResponse>('/api/system/status');
  } catch (e) {
    handleGeminiError('system_status', e);
    return { status: 'error', geminiKeyPresent: false, pixazoKeyPresent: false, message: String(e) };
  }
};

export const analyzeScript = async (script: string, projectId?: string) => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'analyze_script', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<AnalyzeScriptRequest, AnalyzeScriptResponse>('/api/text/analyze-script', { script });
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model,
        stage: 'script',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response.scenes;
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: 'script',
        prompt: script,
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('analyze_script', e);
    throw e;
  }
};

export const generateStoryOutline = async (inputs: StoryOutlineRequest, projectId?: string) => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'story_outline', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<StoryOutlineRequest, StoryOutlineResponse>('/api/text/story-outline', inputs);
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model,
        stage: 'story_outline',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response.outline || '';
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: 'story_outline',
        prompt: JSON.stringify(inputs || {}),
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('story_outline', e);
    throw e;
  }
};

export const generateScriptDraft = async (inputs: StoryDraftRequest, projectId?: string) => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'story_draft', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<StoryDraftRequest, StoryDraftResponse>('/api/text/story-draft', inputs);
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model,
        stage: 'story_draft',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response.script || '';
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: 'story_draft',
        prompt: JSON.stringify(inputs || {}),
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('story_draft', e);
    throw e;
  }
};

export const extractWorldDetails = async (scenes: ExtractWorldRequest['scenes'], projectId?: string) => {
  if (!scenes || scenes.length === 0) {
    return { characters: [], items: [], locations: [] };
  }
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'extract_world', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<ExtractWorldRequest, ExtractWorldResponse>('/api/text/extract-world', { scenes });
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model,
        stage: 'world',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return {
      characters: response.characters,
      items: response.items,
      locations: response.locations
    };
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: 'world',
        prompt: scenes.map((scene) => scene.synopsis || scene.rawText).join('\n'),
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('extract_world', e);
    throw e;
  }
};

export const generatePanelBreakdown = async (
  scene: PanelBreakdownRequest['scene'],
  style: PanelBreakdownRequest['style'],
  layoutType: PanelBreakdownRequest['layoutType'],
  projectId?: string,
  panelCount: number = 3,
  options?: { stage?: string; abortSignal?: AbortSignal }
) => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'panel_breakdown', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<PanelBreakdownRequest, PanelBreakdownResponse>('/api/text/panel-breakdown', {
      scene,
      style,
      layoutType,
      panelCount,
      stage: options?.stage
    }, { signal: options?.abortSignal });
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model,
        stage: options?.stage || 'preview',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response.panels || [];
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: options?.stage || 'preview',
        prompt: scene?.synopsis || scene?.rawText || '',
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('panel_breakdown', e);
    throw e;
  }
};

export const analyzeLayoutFromImages = async (images: string[], projectId?: string) => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'analyze_layout', lastError: undefined });
  const startPerf = performance.now();
  try {
    const response = await post<LayoutAnalysisRequest, LayoutAnalysisResponse>('/api/vision/analyze-layout', { images });
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: response.model,
        stage: 'layout',
        prompt: response.prompt,
        responseText: response.responseText,
        usage: response.usage,
        success: true,
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    return response.description || 'Could not analyze layout.';
  } catch (e) {
    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: 'text',
        provider: 'gemini',
        model: TEXT_MODEL,
        stage: 'layout',
        prompt: 'Analyze layout',
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) }
      });
    }
    handleGeminiError('analyze_layout', e);
    throw e;
  }
};

export const generateImage = async (
  prompt: string,
  aspectRatio: ImageGenerateRequest['aspectRatio'] = '1:1',
  resolution: ImageGenerateRequest['resolution'] = '1K',
  referenceImageIds: string[] = [],
  projectId?: string,
  options?: { abortSignal?: AbortSignal; stage?: string; cropToRatio?: string; storage?: 'project' | 'test'; meta?: Record<string, unknown> }
) => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'generate_image', lastError: undefined });
  const finalPrompt = NO_TEXT_IN_IMAGE ? `${prompt}\n\n${IMAGE_TEXT_BLOCKER}` : prompt;
  const startPerf = performance.now();
  try {
    const referenceDataUrls = await Promise.all(referenceImageIds.map((id) => getImageDataUrl(id)));
    const response = await post<ImageGenerateRequest, ImageGenerateResponse>('/api/image/gemini', {
      prompt: finalPrompt,
      aspectRatio,
      resolution,
      referenceImages: referenceDataUrls.filter((img): img is string => !!img),
      stage: options?.stage
    }, { signal: options?.abortSignal });

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
        model: response.model,
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
        model: response.model,
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
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'testlab_report', lastError: undefined });
  try {
    const response = await post<TestLabReportRequest, TestLabReportResponse>('/api/text/testlab-report', { report });
    return response.text || '';
  } catch (e) {
    handleGeminiError('testlab_report', e);
    throw e;
  }
};
