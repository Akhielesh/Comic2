import {
  ComicForgeAnalyzeScriptRequest,
  ComicForgeAnalyzeScriptResponse,
  ComicForgeAssemblePageRequest,
  ComicForgeAssemblePageResponse,
  ComicForgeAssetCardsListResponse,
  ComicForgeBuildArchitectureRequest,
  ComicForgeBuildArchitectureResponse,
  ComicForgeBuildLetteringRulesRequest,
  ComicForgeBuildLetteringRulesResponse,
  ComicForgeBuildStyleBibleRequest,
  ComicForgeBuildStyleBibleResponse,
  ComicForgeCostTrackerResponse,
  ComicForgeCreateAssetCardRequest,
  ComicForgeCreateAssetCardResponse,
  ComicForgeExportRequest,
  ComicForgeExportResponse,
  ComicForgeExtractLayoutRequest,
  ComicForgeExtractLayoutResponse,
  ComicForgeFormatLockRequest,
  ComicForgeFormatLockResponse,
  ComicForgeGenerateBalloonZonesRequest,
  ComicForgeGenerateBalloonZonesResponse,
  ComicForgeGenerateRefsRequest,
  ComicForgeGenerateRefsResponse,
  ComicForgeGenerateRequest,
  ComicForgeGenerateResponse,
  ComicForgeGenerateThumbnailsRequest,
  ComicForgeGenerateThumbnailsResponse,
  ComicForgeJobEventsResponse,
  ComicForgeJobStatusResponse,
  ComicForgePatchAssetCardRequest,
  ComicForgePatchAssetCardResponse,
  ComicForgePatchPanelLetteringRequest,
  ComicForgePatchPanelLetteringResponse,
  ComicForgePreviewPackResponse,
  ComicForgeRegeneratePanelRequest,
  ComicForgeRegeneratePanelResponse,
  ComicForgeRenderLetteringRequest,
  ComicForgeRenderLetteringResponse,
  ComicForgeResolveAmbiguityRequest,
  ComicForgeResolveAmbiguityResponse,
  ComicForgeRunQcRequest,
  ComicForgeRunQcResponse,
  ComicForgeSuggestStylesRequest,
  ComicForgeSuggestStylesResponse,
  ComicForgeValidateStoryboardResponse
} from '../../apiTypes';
import { buildApiUrl } from '../clientConfig';
import { supabase } from '../supabase';
import { getFluxKeyInfo } from '../appSettings';

const getGeminiKey = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('dreamstream_api_key');
  } catch {
    return null;
  }
};

const request = async <TResponse, TBody = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH',
  body?: TBody
): Promise<TResponse> => {
  const { data: { session } } = await supabase.auth.getSession();
  const geminiKey = getGeminiKey();
  const fluxInfo = getFluxKeyInfo();
  const response = await fetch(buildApiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(geminiKey ? { 'X-Gemini-Key': geminiKey } : {}),
      ...(fluxInfo.key ? { 'X-Pixazo-Key': fluxInfo.key } : {}),
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) })
  });

  const payload = await response.json().catch(() => null) as TResponse | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && payload.error?.message
      ? payload.error.message
      : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as TResponse;
};

const v1 = (path: string) => `/api/v1/comicforge${path}`;

export const comicForgeApi = {
  formatLock: (projectId: string, body: ComicForgeFormatLockRequest) =>
    request<ComicForgeFormatLockResponse, ComicForgeFormatLockRequest>(v1(`/projects/${projectId}/format-lock`), 'POST', body),
  analyzeScript: (projectId: string, body: ComicForgeAnalyzeScriptRequest) =>
    request<ComicForgeAnalyzeScriptResponse, ComicForgeAnalyzeScriptRequest>(v1(`/projects/${projectId}/analyze-script`), 'POST', body),
  resolveAmbiguity: (projectId: string, body: ComicForgeResolveAmbiguityRequest) =>
    request<ComicForgeResolveAmbiguityResponse, ComicForgeResolveAmbiguityRequest>(v1(`/projects/${projectId}/resolve-ambiguity`), 'POST', body),
  buildArchitecture: (projectId: string, body: ComicForgeBuildArchitectureRequest) =>
    request<ComicForgeBuildArchitectureResponse, ComicForgeBuildArchitectureRequest>(v1(`/projects/${projectId}/build-architecture`), 'POST', body),
  suggestStyles: (projectId: string, body: ComicForgeSuggestStylesRequest) =>
    request<ComicForgeSuggestStylesResponse, ComicForgeSuggestStylesRequest>(v1(`/projects/${projectId}/suggest-styles`), 'POST', body),
  buildStyleBible: (projectId: string, body: ComicForgeBuildStyleBibleRequest) =>
    request<ComicForgeBuildStyleBibleResponse, ComicForgeBuildStyleBibleRequest>(v1(`/projects/${projectId}/build-style-bible`), 'POST', body),
  listAssetCards: (projectId: string) =>
    request<ComicForgeAssetCardsListResponse>(v1(`/projects/${projectId}/asset-cards`), 'GET'),
  createAssetCard: (projectId: string, body: ComicForgeCreateAssetCardRequest) =>
    request<ComicForgeCreateAssetCardResponse, ComicForgeCreateAssetCardRequest>(v1(`/projects/${projectId}/asset-cards`), 'POST', body),
  patchAssetCard: (assetCardId: string, body: ComicForgePatchAssetCardRequest) =>
    request<ComicForgePatchAssetCardResponse, ComicForgePatchAssetCardRequest>(v1(`/asset-cards/${assetCardId}`), 'PATCH', body),
  generateRefs: (assetCardId: string, body: ComicForgeGenerateRefsRequest) =>
    request<ComicForgeGenerateRefsResponse, ComicForgeGenerateRefsRequest>(v1(`/asset-cards/${assetCardId}/generate-refs`), 'POST', body),
  extractLayout: (projectId: string, body: ComicForgeExtractLayoutRequest) =>
    request<ComicForgeExtractLayoutResponse, ComicForgeExtractLayoutRequest>(v1(`/projects/${projectId}/extract-layout`), 'POST', body),
  buildLetteringRules: (projectId: string, body: ComicForgeBuildLetteringRulesRequest) =>
    request<ComicForgeBuildLetteringRulesResponse, ComicForgeBuildLetteringRulesRequest>(v1(`/projects/${projectId}/build-lettering-rules`), 'POST', body),
  generateBalloonZones: (pageId: string, body: ComicForgeGenerateBalloonZonesRequest) =>
    request<ComicForgeGenerateBalloonZonesResponse, ComicForgeGenerateBalloonZonesRequest>(v1(`/pages/${pageId}/balloon-zones`), 'POST', body),
  generateThumbnails: (projectId: string, body: ComicForgeGenerateThumbnailsRequest) =>
    request<ComicForgeGenerateThumbnailsResponse, ComicForgeGenerateThumbnailsRequest>(v1(`/projects/${projectId}/generate-thumbnails`), 'POST', body),
  validateStoryboard: (projectId: string) =>
    request<ComicForgeValidateStoryboardResponse>(v1(`/projects/${projectId}/validate-storyboard`), 'POST', {}),
  getPreviewPack: (projectId: string) =>
    request<ComicForgePreviewPackResponse>(v1(`/projects/${projectId}/preview-pack`), 'GET'),
  generate: (projectId: string, body: ComicForgeGenerateRequest) =>
    request<ComicForgeGenerateResponse, ComicForgeGenerateRequest>(v1(`/projects/${projectId}/generate`), 'POST', body),
  regeneratePanel: (panelId: string, body: ComicForgeRegeneratePanelRequest) =>
    request<ComicForgeRegeneratePanelResponse, ComicForgeRegeneratePanelRequest>(v1(`/panels/${panelId}/regenerate`), 'POST', body),
  assemblePage: (pageId: string, body: ComicForgeAssemblePageRequest) =>
    request<ComicForgeAssemblePageResponse, ComicForgeAssemblePageRequest>(v1(`/pages/${pageId}/assemble`), 'POST', body),
  renderLettering: (pageId: string, body: ComicForgeRenderLetteringRequest) =>
    request<ComicForgeRenderLetteringResponse, ComicForgeRenderLetteringRequest>(v1(`/pages/${pageId}/render-lettering`), 'POST', body),
  runQc: (pageId: string, body: ComicForgeRunQcRequest) =>
    request<ComicForgeRunQcResponse, ComicForgeRunQcRequest>(v1(`/pages/${pageId}/run-qc`), 'POST', body),
  patchPanelLettering: (panelLetteringId: string, body: ComicForgePatchPanelLetteringRequest) =>
    request<ComicForgePatchPanelLetteringResponse, ComicForgePatchPanelLetteringRequest>(v1(`/panel-lettering/${panelLetteringId}`), 'PATCH', body),
  exportProject: (projectId: string, body: ComicForgeExportRequest) =>
    request<ComicForgeExportResponse, ComicForgeExportRequest>(v1(`/projects/${projectId}/export`), 'POST', body),
  getJobStatus: (jobId: string, projectId: string) =>
    request<ComicForgeJobStatusResponse>(v1(`/jobs/${jobId}/status?projectId=${encodeURIComponent(projectId)}`), 'GET'),
  getJobEvents: (jobId: string, projectId: string) =>
    request<ComicForgeJobEventsResponse>(v1(`/jobs/${jobId}/events?projectId=${encodeURIComponent(projectId)}`), 'GET'),
  getCostTracker: (projectId: string) =>
    request<ComicForgeCostTrackerResponse>(v1(`/projects/${projectId}/cost-tracker`), 'GET')
};
