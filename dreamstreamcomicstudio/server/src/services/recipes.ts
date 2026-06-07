// Durable recipe library (the user's saved, reusable agent workflows). Mirrors
// customAgents.ts: scoped to a userId, written with the service role, sanitized on
// every read (defense in depth), and best-effort — a DB hiccup never breaks a run, it
// just means the user's saved recipes aren't available that turn. The built-in recipes
// live in code (ai/recipes/library.ts) and are never stored here.

import { getSupabaseAdmin } from './supabase.js';
import { sanitizeRecipe } from '../ai/recipes/validate.js';
import type { Recipe } from '../ai/recipes/schema.js';

export interface StoredRecipe extends Recipe {
  /** DB row id (distinct from the recipe slug `id`). */
  rowId: string;
  slug: string;
  isPublic: boolean;
  updatedAt: string;
}

// Storage slug = the recipe's hyphenated id (matches ai/recipes/validate slugifyId).
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'recipe';

const mapRow = (r: Record<string, any>): StoredRecipe | null => {
  const recipe = sanitizeRecipe(r.recipe, r.slug);
  if (!recipe) return null;
  return {
    ...recipe,
    rowId: r.id,
    slug: r.slug,
    isPublic: Boolean(r.is_public),
    updatedAt: r.updated_at
  };
};

/** A user's saved recipes (newest first). Best-effort. */
export const listRecipes = async (userId: string): Promise<StoredRecipe[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('recipes')
    .select('id, slug, recipe, is_public, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  return (data || []).map(mapRow).filter((r): r is StoredRecipe => r !== null);
};

export const getRecipe = async (userId: string, slug: string): Promise<StoredRecipe | null> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('recipes')
    .select('id, slug, recipe, is_public, updated_at')
    .eq('user_id', userId)
    .eq('slug', slug)
    .maybeSingle();
  return data ? mapRow(data) : null;
};

/** Create or update one recipe. The payload is sanitized before it is stored. */
export const saveRecipe = async (
  userId: string,
  input: unknown,
  opts: { isPublic?: boolean } = {}
): Promise<StoredRecipe | null> => {
  const recipe = sanitizeRecipe(input);
  if (!recipe) return null;
  const admin = getSupabaseAdmin();
  const slug = slugify(recipe.id || recipe.title);
  const row = {
    user_id: userId,
    slug,
    recipe,
    is_public: opts.isPublic === true,
    updated_at: new Date().toISOString()
  };
  const { data } = await admin
    .from('recipes')
    .upsert(row, { onConflict: 'user_id,slug' })
    .select('id, slug, recipe, is_public, updated_at')
    .maybeSingle();
  return data ? mapRow(data) : null;
};

export const deleteRecipe = async (userId: string, slug: string): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('recipes')
    .delete()
    .eq('user_id', userId)
    .eq('slug', slug)
    .select('id');
  return Array.isArray(data) && data.length > 0;
};

/** The user's saved recipes, never throwing (for merging with the built-ins in a route). */
export const loadUserRecipes = async (userId: string): Promise<StoredRecipe[]> => {
  try {
    return await listRecipes(userId);
  } catch {
    return [];
  }
};
