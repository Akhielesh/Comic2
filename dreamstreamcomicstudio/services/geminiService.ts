import { post, get, ApiError } from './apiClient';
import {
  AnalyzeScriptRequest,
  AnalyzeScriptResponse,
  StoryOutlineRequest,
  StoryOutlineResponse,
  StoryDraftRequest,
  StoryDraftResponse,
  StoryToolRequest,
  StoryToolResponse,
  ExtractWorldRequest,
  ExtractWorldResponse,
  PanelBreakdownRequest,
  PanelBreakdownResponse,
  LayoutAnalysisRequest,
  LayoutAnalysisResponse,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ContinuitySummaryRequest,
  ContinuitySummaryResponse,
  ContinuityAuditRequest,
  ContinuityAuditResponse,
  TestLabReportRequest,
  TestLabReportResponse,
  SystemStatusResponse,
  SystemDiagnosticsResponse,
  SystemVersionResponse,
  AssistantMessage,
  UniversalAssistantRequest,
  UniversalAssistantResponse
} from '../apiTypes';
import { GenerationArtifact, Character, Item, Location, ContinuityBible, SceneContinuityBinding } from '../types';
import { saveArtifact, saveImage, saveTestImage, getImageUrl, getTestImageUrl, getImageDataUrl } from './db';
import { IMAGE_TEXT_BLOCKER, NO_TEXT_IN_IMAGE, TEXT_MODEL, IMAGE_MODEL } from './modelPolicy';
import { cropImageToRatio } from './imageUtils';
import { updateDebugState } from './debugStore';
import { getAllModelKeys, getDefaultTextModel, getModelSpecificKey } from './appSettings';
import { getActiveKeyForUse, recordKeyUsage } from './apiKeys';
import { getSelectedImageModel } from './modelSelection';
import { groundWorldEntities } from './worldGrounding';
import { WORLD_EXTRACTION_CONTRACT_VERSION } from '../shared/contracts/worldExtraction';

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

const getActiveTextModel = (): string => getDefaultTextModel();
const LEGACY_WORLD_CONTRACT_VERSION = 0;
const SYSTEM_VERSION_CACHE_MS = 5 * 60_000;
let systemVersionCache: { value: SystemVersionResponse; fetchedAt: number } | null = null;
let legacyWorldContractWarningShown = false;
const FRONTEND_GIT_SHA = String(import.meta.env.VITE_APP_GIT_SHA || '').trim() || 'unknown';

export type DeploymentParityStatus = {
  frontendGitSha: string;
  backendGitSha: string;
  contractVersion: number;
  requiredContractVersion: number;
  mismatch: boolean;
};

const buildUnknownSystemVersion = (): SystemVersionResponse => ({
  appVersion: 'unknown',
  gitSha: 'unknown',
  buildTimestamp: new Date(0).toISOString(),
  worldExtractionContractVersion: LEGACY_WORLD_CONTRACT_VERSION
});

const fetchSystemVersion = async (): Promise<SystemVersionResponse> => {
  try {
    return await get<SystemVersionResponse>('/api/system/version');
  } catch (error) {
    const message = error instanceof ApiError ? `${error.status} ${error.message}` : String(error);
    console.warn(`[SYSTEM_VERSION_CHECK] Falling back to legacy contract mode: ${message}`);
    return buildUnknownSystemVersion();
  }
};

const getCachedSystemVersion = async (): Promise<SystemVersionResponse> => {
  const now = Date.now();
  if (systemVersionCache && (now - systemVersionCache.fetchedAt) < SYSTEM_VERSION_CACHE_MS) {
    return systemVersionCache.value;
  }
  const value = await fetchSystemVersion();
  systemVersionCache = { value, fetchedAt: now };
  return value;
};

const getActiveTextApiKey = (): string | undefined => {
  const preferredModel = getActiveTextModel();
  const exact = getModelSpecificKey(preferredModel);
  if (exact) return exact;
  const fallback = getModelSpecificKey(TEXT_MODEL);
  if (fallback) return fallback;
  const anyGemini = Object.entries(getAllModelKeys()).find(([modelId, key]) =>
    modelId.toLowerCase().includes('gemini') && !!key
  );
  return anyGemini?.[1] || undefined;
};

const isInvalidGeminiKeyError = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return false;
  const detailText = typeof error.details === 'string' ? error.details : JSON.stringify(error.details || {});
  const combined = `${error.message} ${detailText}`.toLowerCase();
  return combined.includes('api key not valid') || combined.includes('api_key_invalid');
};

const isUnsupportedTextModelError = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return false;
  const detailText = typeof error.details === 'string' ? error.details : JSON.stringify(error.details || {});
  const combined = `${error.message} ${detailText}`.toLowerCase();
  return (
    combined.includes('models/') &&
    (combined.includes('not found') || combined.includes('not supported')) &&
    combined.includes('generatecontent')
  );
};

const withTextKeyFallback = async <T>(call: (apiKey: string | undefined, modelId: string) => Promise<T>): Promise<T> => {
  const preferredKey = getActiveTextApiKey();
  const requestedModelId = getActiveTextModel();
  const fallbackModelId = TEXT_MODEL;

  const tryWithModelAndKey = (apiKey: string | undefined, modelId: string) => call(apiKey, modelId);

  try {
    return await tryWithModelAndKey(preferredKey, requestedModelId);
  } catch (firstError) {
    if (isInvalidGeminiKeyError(firstError)) {
      try {
        return await tryWithModelAndKey(undefined, requestedModelId);
      } catch (secondError) {
        if (isUnsupportedTextModelError(secondError) && requestedModelId !== fallbackModelId) {
          return tryWithModelAndKey(undefined, fallbackModelId);
        }
        throw secondError;
      }
    }

    if (isUnsupportedTextModelError(firstError) && requestedModelId !== fallbackModelId) {
      try {
        return await tryWithModelAndKey(preferredKey, fallbackModelId);
      } catch (secondError) {
        if (isInvalidGeminiKeyError(secondError)) {
          return tryWithModelAndKey(undefined, fallbackModelId);
        }
        throw secondError;
      }
    }

    throw firstError;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableTextError = (error: unknown): boolean => {
  if (error instanceof ApiError) {
    if ([408, 429, 500, 502, 503, 504].includes(error.status)) return true;
    if (error.status === 401) {
      const detailText = typeof error.details === 'string' ? error.details : JSON.stringify(error.details || {});
      const combined = `${error.message} ${detailText}`.toLowerCase();
      return (
        combined.includes('missing authorization header') ||
        combined.includes('invalid or expired token') ||
        combined.includes('auth provider unavailable')
      );
    }
    return false;
  }
  const text = String(error || '').toLowerCase();
  return text.includes('failed to fetch') || text.includes('networkerror') || text.includes('load failed');
};

const withTextRetry = async <T>(
  call: () => Promise<T>,
  options?: { attempts?: number; delayMs?: number }
): Promise<T> => {
  const attempts = Math.max(1, options?.attempts ?? 2);
  const delayMs = Math.max(100, options?.delayMs ?? 350);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (!isRetryableTextError(error) || attempt >= attempts) {
        throw error;
      }
      await sleep(delayMs * attempt);
    }
  }

  throw lastError ?? new Error('Text request failed');
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
      const diagnostics = (response as unknown as { diagnostics?: unknown }).diagnostics;
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
        timings: { ...(response.timings || {}), durationMs: Math.round(performance.now() - startPerf) },
        meta: diagnostics ? { diagnostics } : undefined
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
    return { status: 'error', message: String(e) };
  }
};

export const checkSystemDiagnostics = async (): Promise<SystemDiagnosticsResponse> => {
  try {
    return await get<SystemDiagnosticsResponse>('/api/system/diagnostics');
  } catch (e) {
    handleGeminiError('system_diagnostics', e);
    return { status: 'error', geminiKeyPresent: false, pixazoKeyPresent: false, message: String(e) };
  }
};

export const checkSystemVersion = async (): Promise<SystemVersionResponse> => {
  return getCachedSystemVersion();
};

export const checkDeploymentParity = async (): Promise<DeploymentParityStatus> => {
  const version = await getCachedSystemVersion();
  const backendGitSha = String(version.gitSha || 'unknown').trim() || 'unknown';
  const mismatch = (
    FRONTEND_GIT_SHA !== 'unknown'
    && backendGitSha !== 'unknown'
    && FRONTEND_GIT_SHA !== backendGitSha
  );

  return {
    frontendGitSha: FRONTEND_GIT_SHA,
    backendGitSha,
    contractVersion: Number(version.worldExtractionContractVersion || 0),
    requiredContractVersion: WORLD_EXTRACTION_CONTRACT_VERSION,
    mismatch
  };
};

export const queryUniversalAssistant = async (
  message: string,
  history: AssistantMessage[] = [],
  context?: UniversalAssistantRequest['context']
): Promise<UniversalAssistantResponse> => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'assistant_chat', lastError: undefined });
  try {
    return await withTextKeyFallback((apiKey, modelId) =>
      post<UniversalAssistantRequest, UniversalAssistantResponse>(
        '/api/assistant/chat',
        { message, history, context },
        { apiKey, modelId }
      )
    );
  } catch (e) {
    handleGeminiError('assistant_chat', e);
    throw e;
  }
};

export const analyzeScript = async (script: string, projectId?: string) => {
  const response = await analyzeScriptDetailed(script, projectId);
  return response.scenes;
};

export const analyzeScriptDetailed = async (script: string, projectId?: string) => {
  const response = await safeGeminiCall(
    'analyze_script',
    projectId,
    'text',
    'script',
    async () => withTextRetry(
      () => withTextKeyFallback((apiKey, modelId) =>
        post<AnalyzeScriptRequest, AnalyzeScriptResponse>('/api/text/analyze-script', { script }, { apiKey, modelId, stage: 'analyze_script' })
      ),
      { attempts: 2, delayMs: 350 }
    ),
    script
  );
  return response;
};

export const generateStoryOutline = async (inputs: StoryOutlineRequest, projectId?: string) => {
  const response = await safeGeminiCall(
    'story_outline',
    projectId,
    'text',
    'story_outline',
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<StoryOutlineRequest, StoryOutlineResponse>('/api/text/story-outline', inputs, { apiKey, modelId })
    ),
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
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<StoryDraftRequest, StoryDraftResponse>('/api/text/story-draft', inputs, { apiKey, modelId })
    ),
    JSON.stringify(inputs)
  );
  return response.script || '';
};

export const extractWorldDetails = async (
  scenes: ExtractWorldRequest['scenes'],
  projectId?: string,
  script?: string
) => {
  if (!scenes || scenes.length === 0) {
    return {
      characters: [],
      items: [],
      locations: [],
      diagnostics: {
        input_scene_count: 0,
        entity_counts: { characters: 0, items: 0, locations: 0 },
        filtered_entity_count: 0,
        dropped_entities: [],
        ungrounded_characters_dropped: 0
      }
    };
  }
  if (!script || !script.trim()) {
    throw new Error('Script is required for world extraction.');
  }
  const systemVersion = await getCachedSystemVersion();
  const backendContractVersion = systemVersion.worldExtractionContractVersion;
  const useLegacyFallback = backendContractVersion < WORLD_EXTRACTION_CONTRACT_VERSION;
  if (useLegacyFallback && !legacyWorldContractWarningShown) {
    legacyWorldContractWarningShown = true;
    console.warn(
      `[WORLD_EXTRACTION] Backend contract v${backendContractVersion} is older than required v${WORLD_EXTRACTION_CONTRACT_VERSION}. Applying client-side grounding fallback.`
    );
  }

  const response = await safeGeminiCall(
    'extract_world',
    projectId,
    'text',
    'world',
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<ExtractWorldRequest, ExtractWorldResponse>('/api/text/extract-world', { scenes, script: script.trim() }, { apiKey, modelId, stage: 'extract_world' })
    ),
    scenes.map(s => s.synopsis || s.rawText).join('\n')
  );
  let characters = response.characters;
  let items = response.items;
  let locations = response.locations;
  let diagnostics = response.diagnostics;

  if (useLegacyFallback) {
    const grounded = groundWorldEntities({
      scenes,
      script,
      characters: response.characters,
      items: response.items,
      locations: response.locations
    });

    characters = grounded.characters;
    items = grounded.items;
    locations = grounded.locations;
    diagnostics = grounded.diagnostics;

    if (grounded.diagnostics.dropped_entities.length > 0) {
      console.warn('[WORLD_EXTRACTION] Client-side fallback dropped ungrounded entities.', {
        droppedCount: grounded.diagnostics.dropped_entities.length,
        backendContractVersion
      });
      updateDebugState('gemini', {
        lastRequestAt: Date.now(),
        lastRequestType: 'extract_world_fallback'
      });
      if (projectId) {
        void recordArtifact({
          projectId,
          timestamp: Date.now(),
          type: 'text',
          provider: 'gemini',
          model: response.model || TEXT_MODEL,
          stage: 'world_fallback_filter',
          prompt: 'Client-side world extraction grounding fallback',
          responseText: JSON.stringify(grounded.diagnostics),
          success: true,
          meta: {
            backendContractVersion,
            requiredContractVersion: WORLD_EXTRACTION_CONTRACT_VERSION,
            backendDiagnostics: response.diagnostics,
            fallbackDiagnostics: grounded.diagnostics
          }
        });
      }
    }
  }

  return {
    characters,
    items,
    locations,
    diagnostics
  };
};

export const generatePanelBreakdown = async (
  scene: PanelBreakdownRequest['scene'],
  style: PanelBreakdownRequest['style'],
  layoutType: PanelBreakdownRequest['layoutType'],
  projectId?: string,
  panelCount: number = 3,
  options?: {
    stage?: string;
    abortSignal?: AbortSignal;
    continuitySummary?: string;
    continuityBible?: ContinuityBible;
    sceneBindings?: SceneContinuityBinding[];
    previousPanelContext?: Array<{ panelId?: string; sceneId?: number; description: string; dialogue?: string }>;
  }
) => {
  const response = await safeGeminiCall(
    'panel_breakdown',
    projectId,
    'text',
    options?.stage || 'preview',
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<PanelBreakdownRequest, PanelBreakdownResponse>('/api/text/panel-breakdown', {
        scene,
        style,
        layoutType,
        panelCount,
        stage: options?.stage,
        continuitySummary: options?.continuitySummary,
        continuityBible: options?.continuityBible,
        sceneBindings: options?.sceneBindings,
        previousPanelContext: options?.previousPanelContext
      }, { signal: options?.abortSignal, apiKey, modelId, stage: 'panel_breakdown' })
    ),
    scene?.synopsis || scene?.rawText || ''
  );
  return response.panels || [];
};

export const runContinuityAudit = async (
  payload: ContinuityAuditRequest,
  projectId?: string
) => {
  const response = await safeGeminiCall(
    'continuity_audit',
    projectId,
    'text',
    'continuity_audit',
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<ContinuityAuditRequest, ContinuityAuditResponse>(
        '/api/text/continuity-audit',
        payload,
        { apiKey, modelId, stage: 'continuity_audit' }
      )
    ),
    JSON.stringify(payload.panels || [])
  );
  return response;
};

export const analyzeLayoutFromImages = async (images: string[], projectId?: string) => {
  const response = await safeGeminiCall(
    'analyze_layout',
    projectId,
    'text',
    'layout',
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<LayoutAnalysisRequest, LayoutAnalysisResponse>('/api/vision/analyze-layout', { images }, { apiKey, modelId })
    ),
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
  options?: {
    abortSignal?: AbortSignal;
    stage?: string;
    cropToRatio?: string;
    storage?: 'project' | 'test';
    meta?: Record<string, unknown>;
    modelId?: string;
    continuitySensitive?: boolean;
    requiredReferences?: boolean;
    lockedModelId?: string;
  }
) => {
  // Special handling for generateImage since it has unique artifact fields (images) and logic
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'generate_image', lastError: undefined });
  const finalPrompt = NO_TEXT_IN_IMAGE ? `${prompt}\n\n${IMAGE_TEXT_BLOCKER}` : prompt;
  const startPerf = performance.now();
  const targetModel = options?.modelId || IMAGE_MODEL;
  const artifactMeta = options?.meta || {};
  const referenceCount = Number(artifactMeta.referenceCount);
  const fallbackOccurred = Boolean(artifactMeta.fallbackOccurred);
  const fallbackFromModel = typeof artifactMeta.fallbackFromModel === 'string' ? artifactMeta.fallbackFromModel : undefined;
  const fallbackToModel = typeof artifactMeta.fallbackToModel === 'string' ? artifactMeta.fallbackToModel : undefined;
  const styleLockUsed = Boolean(artifactMeta.styleLockUsed);

  try {
    const referenceDataUrls = await Promise.all(referenceImageIds.map((id) => getImageDataUrl(id)));
    const validReferenceImages = referenceDataUrls.filter((img): img is string => !!img);
    const modelSpecificKey = getModelSpecificKey(targetModel);
    const storageMode = options?.storage || 'project';
    const requestBody: ImageGenerateRequest = {
      prompt: finalPrompt,
      aspectRatio,
      resolution,
      referenceImages: validReferenceImages,
      stage: options?.stage,
      projectId,
      storage: storageMode,
      cropToRatio: options?.cropToRatio,
      model: targetModel
    };

    // Pipeline cutover: when the user has a BYOK OpenRouter key, route real panel/
    // cover generation through the unified gateway (their key, their account).
    // Falls back to the legacy Gemini path when no OpenRouter key is configured.
    const { key: activeOpenRouterKey, blocked: openRouterBlocked } = getActiveKeyForUse('openrouter');
    if (openRouterBlocked) {
      throw new Error(
        `Your active OpenRouter key "${activeOpenRouterKey?.label}" has reached its monthly usage limit. ` +
        'Switch to another key or raise the limit in Settings → API Configuration.'
      );
    }
    // No OpenRouter key configured → fall back to the legacy Gemini path.
    const useOpenRouter = Boolean(activeOpenRouterKey);
    let response: ImageGenerateResponse;
    if (useOpenRouter) {
      // Omit the Gemini model id; the server defaults to OPENROUTER_IMAGE_MODEL.
      // The X-OpenRouter-Key header is attached automatically by apiClient.
      response = await post<ImageGenerateRequest, ImageGenerateResponse>(
        '/api/image/openrouter',
        { ...requestBody, model: getSelectedImageModel() || undefined },
        { signal: options?.abortSignal }
      );
      // Attribute the real provider cost to the active OpenRouter key (per-key usage).
      const usedUsd =
        (response as { billing?: { settled?: { providerCostUsd?: number } } }).billing?.settled?.providerCostUsd
        ?? (response as { usage?: { providerCostUsd?: number } }).usage?.providerCostUsd
        ?? 0;
      if (usedUsd > 0) recordKeyUsage('openrouter', usedUsd);
    } else {
      try {
        response = await post<ImageGenerateRequest, ImageGenerateResponse>(
          '/api/image/gemini',
          requestBody,
          { signal: options?.abortSignal, apiKey: modelSpecificKey || undefined }
        );
      } catch (error) {
        // If a model-specific key is invalid, retry with default Gemini key from local storage.
        if (modelSpecificKey && isInvalidGeminiKeyError(error)) {
          response = await post<ImageGenerateRequest, ImageGenerateResponse>(
            '/api/image/gemini',
            requestBody,
            { signal: options?.abortSignal }
          );
        } else {
          throw error;
        }
      }
    }

    let imageId = response.imageId;
    let imageUrl = response.imageUrl;

    if (!imageId || !imageUrl || storageMode === 'test') {
      let dataUrl = response.dataUrl;
      if (!dataUrl) {
        throw new Error('Image generation response did not include image payload.');
      }
      if (options?.cropToRatio) {
        dataUrl = await cropImageToRatio(dataUrl, options.cropToRatio);
      }
      imageId = storageMode === 'test' ? await saveTestImage(dataUrl) : await saveImage(dataUrl);
      imageUrl = storageMode === 'test'
        ? (await getTestImageUrl(imageId)) || dataUrl
        : (await getImageUrl(imageId)) || dataUrl;
    }

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
        usage: response.usage,
        referenceCount: Number.isFinite(referenceCount) ? referenceCount : undefined,
        fallbackOccurred,
        fallbackFromModel,
        fallbackToModel,
        styleLockUsed
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
        model: targetModel,
        stage: options?.stage || 'generation',
        prompt: finalPrompt,
        inputImageIds: referenceImageIds,
        aspectRatio,
        resolution,
        success: false,
        error: (e as Error)?.message || String(e),
        timings: { durationMs: Math.round(performance.now() - startPerf) },
        meta: options?.meta,
        referenceCount: Number.isFinite(referenceCount) ? referenceCount : undefined,
        fallbackOccurred,
        fallbackFromModel,
        fallbackToModel,
        styleLockUsed
      });
    }
    handleGeminiError('generate_image', e);
    throw e;
  }
};

const runStoryTool = async (
  script: string,
  instruction: string,
  history: AssistantMessage[] = []
): Promise<string> => {
  updateDebugState('gemini', { lastRequestAt: Date.now(), lastRequestType: 'story_tool', lastError: undefined });
  try {
    const response = await withTextKeyFallback((apiKey, modelId) =>
      post<StoryToolRequest, StoryToolResponse>(
        '/api/text/story-tool',
        { script, instruction, history },
        { apiKey, modelId }
      )
    );
    return response.text || '';
  } catch (e) {
    handleGeminiError('story_tool', e);
    throw e;
  }
};

export const suggestStyle = async (script: string): Promise<string> => {
  const instruction = "Analyze this script and suggest a unique, creative visual style for a comic adaptation. Provide a concise, evocative style prompt (art style, colors, mood) suitable for an image generator. Output ONLY the prompt, no intro.";
  return await runStoryTool(script, instruction, []);
};

export const suggestFormFactor = async (script: string): Promise<string> => {
  const instruction = "Analyze this script and suggest the best aspect ratio (Form Factor) for a comic book adaptation. Options: '1:1', '3:4', '4:3', '9:16', '16:9'. Return ONLY the ratio string (e.g. '16:9').";
  const result = await runStoryTool(script, instruction, []);
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

  const result = await runStoryTool(script, message, []);
  try {
    const jsonStr = result.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.warn("Failed to parse consistency check", e);
    return {};
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
    const response = await withTextKeyFallback((apiKey, modelId) =>
      post<ContinuitySummaryRequest, ContinuitySummaryResponse>('/api/text/continuity-summary', {
        currentSummary,
        scene,
        panels
      }, { apiKey, modelId })
    );
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
    async () => withTextKeyFallback((apiKey, modelId) =>
      post<TestLabReportRequest, TestLabReportResponse>('/api/text/testlab-report', { report }, { apiKey, modelId })
    )
  );
  return response.text || '';
};
