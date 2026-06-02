// Shared helpers for the page-composition workers (assembly / lettering / export).
//
// Generation persists one image per planned page via persistGeneratedImage(); these helpers
// read those back from the image_assets table + storage so the downstream workers operate on
// real artifacts instead of stubs.

import { STORAGE_BUCKET } from '../../config.js';
import { getSupabaseAdmin } from '../../services/supabase.js';

export type ProjectPageImage = {
  imageId: string; // storage path
  imageUrl: string;
  bucket: string;
  createdAt: string;
};

const GENERATION_SOURCES = ['openrouter', 'gemini', 'flux', 'nvidia'];

/** List a project's generated images, oldest first (page order matches generation order). */
export const listProjectPageImages = async (projectId: string): Promise<ProjectPageImage[]> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('image_assets')
    .select('id, bucket, path, source, created_at')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data || [])
    .filter((row) => GENERATION_SOURCES.includes(String((row as Record<string, unknown>).source || '')))
    .map((row) => {
      const record = row as Record<string, unknown>;
      const bucket = String(record.bucket || STORAGE_BUCKET);
      const path = String(record.path || '');
      const { data: pub } = admin.storage.from(bucket).getPublicUrl(path);
      return {
        imageId: path,
        imageUrl: pub.publicUrl,
        bucket,
        createdAt: String(record.created_at || '')
      };
    });
};

/** Download the raw bytes for a stored image path. */
export const downloadImageBuffer = async (bucket: string, path: string): Promise<Buffer> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) {
    throw error || new Error(`Failed to download image ${path}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
};
