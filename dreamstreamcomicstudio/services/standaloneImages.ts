import { get, post } from './apiClient';
import { emitBillingSummaryRefresh } from './billing';
import { downloadBlob } from './download';
import { getModelSpecificKey } from './appSettings';
import type { ImageGenerateRequest, ImageGenerateResponse } from '../apiTypes';
import {
  MAX_REF_BYTES, REF_MIME_TYPES, STANDALONE_MODEL, NATIVE_REFERENCE_MODEL, type WorkspaceQuality, type StandaloneRoute,
  type SavedStandaloneImage, type StandaloneGallery, type ImageFormatChoice
} from '../shared/standaloneImage';

const endpoint = '/api/image/standalone';

export const loadImageHistory = (offset = 0) => get<StandaloneGallery>(`${endpoint}?offset=${offset}`);

export function loadStandaloneRoute(owner: string, quality: WorkspaceQuality, signal: AbortSignal, allowPaidImage = false) {
  const model = quality === 'native' ? STANDALONE_MODEL : NATIVE_REFERENCE_MODEL;
  return get<StandaloneRoute>(`${endpoint}/route?model=${encodeURIComponent(model)}`, {
    expectedAccountId: owner, apiKey: getModelSpecificKey(model) || undefined, modelId: model, signal, allowPaidImage
  });
}

export async function renderStandalone(
  owner: string, prompt: string, aspectRatio: ImageFormatChoice, referenceImages: string[], requestId: string, quality: WorkspaceQuality = 'native', options: { signal?: AbortSignal; allowPaidImage?: boolean; expectedRoute?: StandaloneRoute } = {}
): Promise<SavedStandaloneImage> {
  const model = quality === 'native' ? STANDALONE_MODEL : NATIVE_REFERENCE_MODEL;
  const target = options.expectedRoute ? endpoint + '?' + new URLSearchParams({
    expectedProvider: options.expectedRoute.provider, expectedPayer: options.expectedRoute.payer
  }) : endpoint;
  const result = await post<Omit<ImageGenerateRequest, 'aspectRatio'> & { aspectRatio: ImageFormatChoice }, ImageGenerateResponse>(target, {
    prompt: prompt.trim(), aspectRatio, resolution: quality === 'native' ? '1K' : quality, model, referenceImages
  }, { expectedAccountId: owner, idempotencyKey: requestId, signal: options.signal, allowPaidImage: options.allowPaidImage, apiKey: getModelSpecificKey(model) || undefined });
  if (!result.imageId || !result.imageUrl) throw new Error('Your image could not be opened. Refresh your saved images before trying again.');
  emitBillingSummaryRefresh();
  return { imageId: result.imageId, imageUrl: result.imageUrl, createdAt: new Date().toISOString(), model: result.model, provider: result.provider, byok: result.payer ? result.payer === 'personal' : result.billing?.byokBypass, apiMs: result.timings?.apiMs, saveMs: result.timings?.saveMs };
}

export async function loadReference(file: File): Promise<{ name: string; data: string }> {
  if (!REF_MIME_TYPES.includes(file.type) || !file.size || file.size > MAX_REF_BYTES) {
    throw new Error(`${file.name}: choose a JPEG, PNG or WebP up to 2 MB.`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result) });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}. Choose the file again.`));
    reader.readAsDataURL(file);
  });
}

export async function reopenStandalone(image: SavedStandaloneImage) {
  const assetId = image.imageId.split('/').pop() || '';
  const { images } = await get<StandaloneGallery>(`${endpoint}?file=${encodeURIComponent(assetId)}`);
  if (!images[0]) throw new Error('This image is no longer available.');
  return images[0];
}

async function standaloneBlob(image: SavedStandaloneImage) {
  const renewed = await reopenStandalone(image);
  const response = await fetch(renewed.imageUrl, { credentials: 'omit' });
  if (!response.ok) throw new Error('Download failed. Please try again.');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('The image could not be downloaded.');
  return blob;
}

export async function reuseStandalone(image: SavedStandaloneImage) {
  const blob = await standaloneBlob(image);
  return loadReference(new File([blob], 'Generated image.webp', { type: blob.type }));
}

export async function downloadStandalone(image: SavedStandaloneImage) {
  const blob = await standaloneBlob(image);
  downloadBlob(blob, `dreamstream-${image.imageId.split('/').pop() || 'image.webp'}`);
}
