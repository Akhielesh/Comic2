// Export. Packages a project's generated page images into a downloadable ZIP (plus a
// manifest) and uploads it to storage, returning a public download URL. PDF/webtoon-stitch
// presets can be added later; ZIP keeps the dependency surface to the already-present jszip.

import crypto from 'node:crypto';
import JSZip from 'jszip';
import { STORAGE_BUCKET } from '../../config.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { downloadImageBuffer, listProjectPageImages } from './pageAssets.js';

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');

export const runExportWorker = async (payload: Record<string, unknown>) => {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  const preset = typeof payload.preset === 'string' ? payload.preset : 'digital_pdf';
  if (!projectId || !userId) {
    throw new Error('export job is missing projectId/userId.');
  }

  const pages = await listProjectPageImages(projectId);
  if (pages.length === 0) {
    throw new Error('Nothing to export — generate pages first.');
  }

  const zip = new JSZip();
  const manifestPages: Array<{ pageNumber: number; file: string }> = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const buffer = await downloadImageBuffer(page.bucket, page.imageId);
    const file = `page-${String(index + 1).padStart(3, '0')}.webp`;
    zip.file(file, buffer);
    manifestPages.push({ pageNumber: index + 1, file });
  }

  zip.file('manifest.json', JSON.stringify({
    projectId,
    preset,
    pageCount: pages.length,
    pages: manifestPages,
    exportedAt: new Date().toISOString()
  }, null, 2));

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const admin = getSupabaseAdmin();
  const path = `u/${sanitize(userId)}/p/${sanitize(projectId)}/exports/${crypto.randomUUID()}.zip`;
  const { error: uploadError } = await admin.storage
    .from(STORAGE_BUCKET)
    .upload(path, zipBuffer, { contentType: 'application/zip', upsert: false });
  if (uploadError) throw uploadError;

  const { data } = admin.storage.from(STORAGE_BUCKET).getPublicUrl(path);

  return {
    exported: true,
    preset,
    pageCount: pages.length,
    downloadUrl: data.publicUrl,
    bytes: zipBuffer.byteLength,
    completedAt: Date.now()
  };
};
