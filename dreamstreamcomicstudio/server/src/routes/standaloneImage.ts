import type { RequestHandler } from 'express';
import { COMIC_PRIVATE_BUCKET } from '../config.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { requireStudioProduct } from '../middleware/studioProduct.js';
import { IMAGE_PROMPT_LIMIT, IMAGE_RATIOS, MAX_IMAGE_REFS, NATIVE_REFERENCE_MODEL, STANDALONE_MODEL, suggestedImageRatio } from '../../../shared/standaloneImage.js';

import { prepareStandaloneReferences } from '../services/standaloneReferences.js';

export const privateImageFolder = (userId: string) => `u/${userId}/standalone/`;
export const IMAGE_LINK_SECONDS = 3600;
const PAGE_SIZE = 24;

export const requireImageWorkspace = requireStudioProduct('comic_studio', 'Comic Studio', 'your image workspace');

// Constrain the standalone request before opening a paid provider call. References are inline only.
export const validateImageWorkspaceRequest: RequestHandler = async (req, res, next) => {
  const { prompt, aspectRatio = 'auto', referenceImages = [], model = STANDALONE_MODEL, resolution = '1K' } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > IMAGE_PROMPT_LIMIT || (aspectRatio !== 'auto' && !IMAGE_RATIOS.includes(aspectRatio)) || ![STANDALONE_MODEL, NATIVE_REFERENCE_MODEL].includes(model) || (model === STANDALONE_MODEL ? resolution !== '1K' : !['1K','2K','4K'].includes(resolution))) {
    return void res.status(400).json({ error: { message: 'Enter a description and choose a supported image format.' } });
  }
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  res.once('close', disconnected);
  if (res.destroyed) controller.abort();
  let prepared: string[];
  try {
    prepared = await prepareStandaloneReferences(referenceImages, controller.signal, model === NATIVE_REFERENCE_MODEL ? MAX_IMAGE_REFS : 3);
    if (controller.signal.aborted) return;
  } catch {
    if (controller.signal.aborted) return;
    return void res.status(400).json({ error: { message: `Use up to ${MAX_IMAGE_REFS} readable JPEG, PNG or WebP images, 2 MB each and 6 MB total.` } });
  } finally {
    res.off('close', disconnected);
  }
  res.locals.standaloneImage = true;
  const automatic = aspectRatio === 'auto';
  const brief = prompt.trim();
  // This instruction rides in the one image request. Explicit choices in the brief always take priority.
  const directedPrompt = automatic
    ? `Create one finished image from the following brief. Choose the composition, lighting and style wherever the creator has left them open. Honor the creator's specified format and visual choices.${referenceImages.length ? ' Use the attached references as directed by the brief.' : ''}\n\n${brief}`
    : brief;
  req.body = { prompt: prepared.length < referenceImages.length ? directedPrompt + "\n\nThe attached sheets contain numbered references in the creator’s original order. Use the referenced subjects and visual details. Omit the sheet grid and labels from the finished image." : directedPrompt, aspectRatio: automatic ? suggestedImageRatio(brief) ?? 'auto' : aspectRatio,
    referenceImages: prepared, model, resolution, stage: 'standalone-image', storage: 'project' };
  next();
};

export const listStandaloneImages: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return void res.status(400).json({ error: { message: 'Invalid image history offset.' } });
    const db = getSupabaseAdmin();
    const file = req.query.file;
    if (file !== undefined && (typeof file !== 'string' || !/^[a-f0-9-]{36}\.webp$/.test(file))) {
      return void res.status(400).json({ error: { message: 'Invalid image.' } });
    }
    let query = db.from('image_assets').select('path,created_at,width,height')
      .eq('user_id', userId).eq('bucket', COMIC_PRIVATE_BUCKET).like('path', privateImageFolder(userId) + '%')
      .is('deleted_at', null);
    if (typeof file === 'string') query = query.eq('path', privateImageFolder(userId) + file);
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + PAGE_SIZE);
    if (error) throw error;
    const rows = (data || []).slice(0, PAGE_SIZE);
    if (!rows.length) return void res.json({ images: [], hasMore: false });
    const signed = await db.storage.from(COMIC_PRIVATE_BUCKET).createSignedUrls(rows.map(row => row.path), IMAGE_LINK_SECONDS);
    if (signed.error) throw signed.error;
    const urls = new Map(signed.data.map(item => [item.path, item.signedUrl]));
    const images = rows.map(row => {
      const imageUrl = urls.get(row.path);
      if (!imageUrl) throw new Error('Could not open a saved image. Try loading your images again.');
      return { imageId: row.path, imageUrl, createdAt: row.created_at, width: row.width ?? undefined, height: row.height ?? undefined };
    });
    res.json({ images, hasMore: (data?.length ?? 0) > PAGE_SIZE });
  } catch (error) { next(error); }
};
