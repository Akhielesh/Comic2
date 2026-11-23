import type { RequestHandler } from 'express';
import { COMIC_PRIVATE_BUCKET } from '../config.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { requireStudioProduct } from '../middleware/studioProduct.js';
import { IMAGE_PROMPT_LIMIT, IMAGE_RATIOS, MAX_IMAGE_REFS, MAX_REF_BYTES, STANDALONE_MODEL, suggestedImageRatio } from '../../../shared/standaloneImage.js';

export const privateImageFolder = (userId: string) => `u/${userId}/standalone/`;
export const IMAGE_LINK_SECONDS = 3600;
const PAGE_SIZE = 24;

export const requireImageWorkspace = requireStudioProduct('comic_studio', 'Comic Studio', 'your image workspace');

// Constrain the standalone request before opening a paid provider call. References are inline only.
export const validateImageWorkspaceRequest: RequestHandler = (req, res, next) => {
  const { prompt, aspectRatio = 'auto', referenceImages = [], model = STANDALONE_MODEL } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > IMAGE_PROMPT_LIMIT || (aspectRatio !== 'auto' && !IMAGE_RATIOS.includes(aspectRatio)) || model !== STANDALONE_MODEL) {
    return void res.status(400).json({ error: { message: 'Enter a description and choose a supported image format.' } });
  }
  if (!Array.isArray(referenceImages) || referenceImages.length > MAX_IMAGE_REFS || referenceImages.some(ref =>
    typeof ref !== 'string' || ref.length > Math.ceil(MAX_REF_BYTES / 3) * 4 + 32 ||
    !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref))) {
    return void res.status(400).json({ error: { message: 'Use up to three JPEG, PNG or WebP references, each 2 MB or smaller.' } });
  }
  res.locals.standaloneImage = true;
  const automatic = aspectRatio === 'auto';
  const brief = prompt.trim();
  // This instruction rides in the one image request. Explicit choices in the brief always take priority.
  const directedPrompt = automatic
    ? `Create one finished image from the following brief. Choose the composition, lighting and style wherever the creator has left them open. Honor the creator's specified format and visual choices.${referenceImages.length ? ' Use the attached references as directed by the brief.' : ''}\n\n${brief}`
    : brief;
  req.body = { prompt: directedPrompt, aspectRatio: automatic ? suggestedImageRatio(brief) ?? 'auto' : aspectRatio,
    referenceImages, model, resolution: '1K', stage: 'standalone-image', storage: 'project' };
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
    let query = db.from('image_assets').select('path,created_at')
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
      return { imageId: row.path, imageUrl, createdAt: row.created_at };
    });
    res.json({ images, hasMore: (data?.length ?? 0) > PAGE_SIZE });
  } catch (error) { next(error); }
};
