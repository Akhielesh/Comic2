import { isOriginalSlug } from '../shared/comic/originals';
import { isContentRating, type ContentRating } from '../shared/comic/safety';
import { supabase } from './supabase';

export interface StudioOriginalCard {
  editorial: true;
  slug: string;
  id: string;
  name: string;
  publicOverview: string;
  authorName: string;
  pageCount: number;
  contentRating: ContentRating;
  publishedAt: number;
  createdAt: number;
  updatedAt: number;
  coverImage: string;
  // First-party editorial editions have no member, project likes or member publication counters.
  userId?: undefined;
  isLiked?: undefined;
  likesCount?: undefined;
  viewsCount?: undefined;
}

export function originalCatalogCards(value: unknown): StudioOriginalCard[] {
  if (!Array.isArray(value)) return [];
  const cards: StudioOriginalCard[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row.slug !== 'string' || !isOriginalSlug(row.slug) || seen.has(row.slug) ||
        typeof row.title !== 'string' || !row.title.trim() || typeof row.description !== 'string' ||
        row.creator !== 'DreamStream Studio Originals' || !isContentRating(row.rating) ||
        !Number.isInteger(row.pageCount) || row.pageCount < 15 || row.pageCount > 500 ||
        !Number.isSafeInteger(row.publishedAt) || row.publishedAt <= 0 ||
        !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.publishedAt ||
        typeof row.coverPath !== 'string' || !/^pub\/[A-Za-z0-9]{22}\/[a-zA-Z0-9_-]+\.webp$/.test(row.coverPath)) continue;
    const cover = supabase.storage.from('comic-assets').getPublicUrl(row.coverPath).data?.publicUrl;
    if (!cover) continue;
    seen.add(row.slug);
    cards.push({ editorial: true, slug: row.slug, id: row.slug, name: row.title.trim().slice(0,200),
      publicOverview: row.description.slice(0,600), authorName: row.creator, pageCount: row.pageCount,
      contentRating: row.rating, publishedAt: row.publishedAt, createdAt: row.publishedAt, updatedAt: row.updatedAt,
      coverImage: cover });
  }
  return cards;
}

export async function loadStudioOriginals(): Promise<StudioOriginalCard[]> {
  const { data, error } = await supabase.rpc('comic_originals_catalog');
  if (error) throw error;
  return originalCatalogCards(data);
}
