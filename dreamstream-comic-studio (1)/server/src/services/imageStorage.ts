import crypto from 'crypto';
import sharp from 'sharp';
import type { ImageResolution } from '../../../types.js';
import { STORAGE_BUCKET } from '../config.js';
import { getSupabaseAdmin } from './supabase.js';

type PersistGeneratedImageArgs = {
  userId: string;
  projectId?: string;
  dataUrl: string;
  source: 'gemini' | 'flux' | 'upload' | 'migration';
  resolution?: ImageResolution | string;
  cropToRatio?: string;
  bucket?: string;
};

type PersistGeneratedImageResult = {
  imageId: string;
  imageUrl: string;
  mimeType: string;
  saveMs: number;
  originalBytes: number;
  storedBytes: number;
  width?: number;
  height?: number;
  compressionRatio: number;
};

const WEBP_EFFORT = 4;
const WEBP_QUALITY: Record<string, number> = {
  '1K': 82,
  '2K': 78,
  '4K': 74
};

const parseDataUrl = (dataUrl: string): { mimeType: string; buffer: Buffer } => {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) {
    throw new Error('Invalid data URL for image persistence.');
  }
  const mimeType = match[1] || 'image/png';
  const buffer = Buffer.from(match[2], 'base64');
  return { mimeType, buffer };
};

const parseRatio = (ratio?: string): number | null => {
  if (!ratio) return null;
  const parts = ratio.split(':').map((part) => Number(part.trim()));
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1]) || parts[0] <= 0 || parts[1] <= 0) {
    return null;
  }
  return parts[0] / parts[1];
};

const isUuid = (value?: string): boolean =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const sanitizeSegment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');

const buildStoragePath = (userId: string, imageId: string, projectId?: string) => {
  const userSegment = sanitizeSegment(userId);
  if (projectId && projectId.trim()) {
    return `u/${userSegment}/p/${sanitizeSegment(projectId)}/img/${imageId}.webp`;
  }
  return `u/${userSegment}/tmp/${imageId}.webp`;
};

const cropToRatioIfNeeded = async (buffer: Buffer, ratio?: string): Promise<Buffer> => {
  const targetRatio = parseRatio(ratio);
  if (!targetRatio) return buffer;

  const image = sharp(buffer, { failOnError: false });
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) return buffer;

  const currentRatio = width / height;
  if (Math.abs(currentRatio - targetRatio) < 0.01) return buffer;

  if (currentRatio > targetRatio) {
    const cropWidth = Math.max(1, Math.round(height * targetRatio));
    const left = Math.max(0, Math.floor((width - cropWidth) / 2));
    return image
      .extract({ left, top: 0, width: cropWidth, height })
      .toBuffer();
  }

  const cropHeight = Math.max(1, Math.round(width / targetRatio));
  const top = Math.max(0, Math.floor((height - cropHeight) / 2));
  return image
    .extract({ left: 0, top, width, height: cropHeight })
    .toBuffer();
};

export const persistGeneratedImage = async ({
  userId,
  projectId,
  dataUrl,
  source,
  resolution,
  cropToRatio,
  bucket = STORAGE_BUCKET
}: PersistGeneratedImageArgs): Promise<PersistGeneratedImageResult> => {
  const start = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  const { buffer: rawBuffer } = parseDataUrl(dataUrl);
  const croppedBuffer = await cropToRatioIfNeeded(rawBuffer, cropToRatio);
  const quality = WEBP_QUALITY[resolution || '1K'] || WEBP_QUALITY['1K'];
  const webp = await sharp(croppedBuffer, { failOnError: false })
    .webp({ quality, effort: WEBP_EFFORT })
    .toBuffer({ resolveWithObject: true });

  const imageId = crypto.randomUUID();
  const path = buildStoragePath(userId, imageId, projectId);
  const mimeType = 'image/webp';
  const uploadBuffer = webp.data;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(bucket)
    .upload(path, uploadBuffer, {
      upsert: false,
      contentType: mimeType,
      cacheControl: '31536000'
    });
  if (uploadError) throw uploadError;

  const { error: metadataError } = await supabaseAdmin.from('image_assets').insert({
    id: imageId,
    user_id: userId,
    project_id: isUuid(projectId) ? projectId : null,
    bucket,
    path,
    mime_type: mimeType,
    bytes: uploadBuffer.byteLength,
    width: webp.info.width || null,
    height: webp.info.height || null,
    source,
    created_at: new Date().toISOString(),
    last_referenced_at: new Date().toISOString(),
    expires_at: null,
    deleted_at: null
  });

  if (metadataError) {
    await supabaseAdmin.storage.from(bucket).remove([path]).catch(() => null);
    throw metadataError;
  }

  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  const originalBytes = rawBuffer.byteLength;
  const storedBytes = uploadBuffer.byteLength;
  const compressionRatio = originalBytes > 0 ? storedBytes / originalBytes : 1;

  return {
    imageId: path,
    imageUrl: data.publicUrl,
    mimeType,
    saveMs: Date.now() - start,
    originalBytes,
    storedBytes,
    width: webp.info.width,
    height: webp.info.height,
    compressionRatio
  };
};
