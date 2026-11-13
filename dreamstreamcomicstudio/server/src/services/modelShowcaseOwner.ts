// Optional owner evidence for Models. Every read is scoped to the authenticated requester. No public
// response receives these records, and every signed path is checked independently of document ownership.
import type { AssetRef } from '../../../shared/comic/doc.js';
import { getImageModel } from '../../../shared/comic/models.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';
import { MODEL_SHOWCASE_IDS, type ModelShowcaseExample } from '../../../shared/modelShowcase.js';
import { createSupabaseAssetStore, isOwnedAssetPath } from '../comic/assets.js';
import { isPrivatePath } from '../comic/storagePaths.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';

export const OWNER_SHOWCASE_DOC_LIMIT = 20;
const PER_MODEL_LIMIT = 3;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const selected = new Set<string>(MODEL_SHOWCASE_IDS);
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const array = (v: unknown, max: number): unknown[] => Array.isArray(v) ? v.slice(0, max) : [];
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export interface OwnerShowcaseDocRow {
  project_id: string;
  user_id: string;
  title?: unknown;
  cover?: unknown;
  pages?: unknown;
  cast?: unknown;
  places?: unknown;
}

interface OwnerCandidate extends Omit<ModelShowcaseExample, 'url' | 'thumbnailUrl'> {
  path: string;
  thumbnailPath: string;
}

/** Never consult the project lock or render.model: only the exact generated asset's own model attribution. */
export function ownerShowcaseCandidates(rows: OwnerShowcaseDocRow[], userId: string): OwnerCandidate[] {
  const candidates: OwnerCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, OWNER_SHOWCASE_DOC_LIMIT)) {
    if (row.user_id !== userId || !UUID.test(row.project_id)) continue;
    const title = typeof row.title === 'string' ? row.title.slice(0, 200) : 'Your comic';
    const targets: Array<{ label: string; render: unknown }> = [
      { label: 'Cover', render: record(row.cover)?.render },
      ...array(row.pages, 120).map((page, i) => ({ label: `Page ${i + 1}`, render: record(page)?.render })),
      ...array(row.cast, 40).map((entry) => ({ label: 'Character sheet', render: record(entry)?.sheet })),
      ...array(row.places, 40).map((entry) => ({ label: 'Place sheet', render: record(entry)?.sheet }))
    ];
    for (const target of targets) {
      const render = record(target.render);
      const asset = record(render?.asset);
      if (render?.status !== 'ready' || !asset || asset.source !== 'generated' || typeof asset.model !== 'string' || !selected.has(asset.model)) continue;
      const spec = getImageModel(asset.model);
      const path = asset.path;
      if (!spec || typeof path !== 'string' || !isOwnedAssetPath(path, userId) || isPrivatePath(path) || seen.has(path)) continue;
      if (!canServeToOwner(asset as unknown as AssetRef) || !positive(asset.w) || !positive(asset.h) || !positive(asset.at)) continue;
      const variants = array(asset.variants, 4).map(record).filter((v) => v && typeof v.path === 'string' && isOwnedAssetPath(v.path, userId) && !isPrivatePath(v.path));
      const thumbnailPath = variants.find((v) => positive(v.w) && v.w >= 480)?.path as string | undefined;
      seen.add(path);
      candidates.push({
        id: `${row.project_id}:${target.label}:${asset.at}`,
        modelId: asset.model,
        // AssetRef records our model id, but not the route that generated it. Do not infer that route.
        providerModelId: null,
        path,
        thumbnailPath: thumbnailPath ?? path,
        alt: `${target.label} from ${title}`,
        width: asset.w,
        height: asset.h,
        generatedAt: asset.at,
        resolution: typeof render.resolution === 'string' ? render.resolution : 'unrecorded',
        source: 'your_comic',
        projectId: row.project_id,
        title,
        readingLink: `/?view=read&id=${encodeURIComponent(row.project_id)}`
      });
    }
  }
  const counts = new Map<string, number>();
  return candidates.sort((a, b) => b.generatedAt - a.generatedAt).filter((candidate) => {
    const n = counts.get(candidate.modelId) ?? 0;
    counts.set(candidate.modelId, n + 1);
    return n < PER_MODEL_LIMIT;
  });
}

export interface OwnerShowcaseSource {
  docsForUser(userId: string): Promise<OwnerShowcaseDocRow[]>;
  signUrls(paths: string[]): Promise<Record<string, string>>;
}

const defaultSource: OwnerShowcaseSource = {
  async docsForUser(userId) {
    const { data, error } = await getSupabaseAdmin().from('comic_docs')
      .select('project_id,user_id,title:doc->brief->title,cover:doc->cover,pages:doc->pages,cast:doc->cast,places:doc->places')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(OWNER_SHOWCASE_DOC_LIMIT)
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('owner_showcase_read_failed');
    return (data ?? []) as OwnerShowcaseDocRow[];
  },
  signUrls: (paths) => createSupabaseAssetStore().signUrls(paths, { ttlSec: 300 })
};

export async function readOwnerModelExamples(userId: string, source: OwnerShowcaseSource = defaultSource): Promise<ModelShowcaseExample[] | null> {
  if (!userId) return [];
  if (source === defaultSource && !getSupabaseCapabilityStatus().storagePersistenceEnabled) return null;
  const candidates = ownerShowcaseCandidates(await source.docsForUser(userId), userId);
  if (!candidates.length) return [];
  const urls = await source.signUrls([...new Set(candidates.flatMap((c) => [c.path, c.thumbnailPath]))]);
  const examples = candidates.flatMap(({ path, thumbnailPath, ...example }) => {
    const url = urls[path];
    return url ? [{ ...example, url, thumbnailUrl: urls[thumbnailPath] ?? url }] : [];
  });
  // The signer intentionally swallows storage failures. Do not turn that into "you have no artwork".
  return examples.length ? examples : null;
}
