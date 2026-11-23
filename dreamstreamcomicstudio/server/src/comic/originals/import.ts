import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ORIGINAL_SLUGS, type OriginalKey } from '../../../../shared/comic/originals.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import type { AssetRef, ComicDoc } from '../../../../shared/comic/doc.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { newAssetKey } from '../publication/ids.js';
import { renderOgCard } from '../publication/ogImage.js';
import { buildShareCard, buildSnapshot, ogPath, planSnapshot } from '../publication/snapshot.js';
import { publicObjectUrl } from '../publication/publication.js';
import { PUBLIC_BUCKET } from '../storagePaths.js';
import { claimReviewedEdition, editorialReview } from './review.js';
import { runPublishGateImpl } from '../safety/publishGate.js';
import { withSharpSlot } from '../imageMeasure.js';
import { IMPRINT, inspectOriginal, originalDocument, originalPath, sha256, type OriginalBook, type OriginalImage } from './book.js';

async function verifiedBytes(image: OriginalImage): Promise<Buffer> {
  const bytes = await readFile(image.file);
  if (bytes.length !== image.bytes || sha256(bytes) !== image.sha256) throw new Error('Bundled editorial artwork changed.');
  return bytes;
}
function assetsFor(book: OriginalBook): AssetRef[] {
  return book.images.map((image) => ({
    path: originalPath(book, image),
    source: 'generated',
    at: 0,
    w: image.width,
    h: image.height,
    variants: [480, 1080]
      .filter((w) => w < image.width)
      .map((w) => ({
        path: originalPath(book, image).replace(/\.webp$/, '_w' + w + '.webp'),
        w,
        h: Math.round((image.height * w) / image.width)
      }))
  }));
}
const sourceUrl = (bytes: Buffer) => 'data:image/webp;base64,' + bytes.toString('base64');

/** The exact same image + complete-text publication gate as a member book, without a member identity. */
export async function reviewOriginal(book: OriginalBook, source: ComicDoc) {
  let doc = source;
  const files = new Map(book.images.map((i) => [originalPath(book, i), i]));
  async function read(path: string) {
    const item = files.get(path);
    if (!item) throw new Error('Unknown editorial asset.');
    return verifiedBytes(item);
  }
  const gate = await runPublishGateImpl(
    {
      userId: null,
      projectId: null,
      rating: book.metadata.rating,
      signal: AbortSignal.timeout(5 * 60_000),
      session: { commit: (ops) => (doc = applyOps(doc, ops)) },
      assets: {
        loadDataUrl: async (path) => sourceUrl(await read(path)),
        previewDataUrl: async (path, edge = 768) => {
          if (typeof path !== 'string') throw new Error('Editorial image data must come from the frozen bundle.');
          const source = await read(path);
          const bytes = await withSharpSlot(() =>
            sharp(source).resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
          );
          return sourceUrl(bytes);
        }
      }
    },
    doc,
    { pageIds: doc.pages.map((p) => p.id), includeCover: true, languages: ['en'] }
  );
  return editorialReview(gate, doc);
}

export async function publishBundledOriginal(key: OriginalKey, root: string): Promise<{ slug: string }> {
  const book = await inspectOriginal(root, key);
  const db = getSupabaseAdmin();
  const bucket = await db.storage.getBucket(PUBLIC_BUCKET);
  if (bucket.error || bucket.data?.public !== true) throw new Error('Public publication storage is unavailable.');
  const token = randomUUID();
  const slug = ORIGINAL_SLUGS[key];
  const doc = originalDocument(book, assetsFor(book), Date.now());
  const claim = await claimReviewedEdition(
    db,
    {
      p_key: key,
      p_slug: slug,
      p_digest: book.digest,
      p_asset_key: newAssetKey(),
      p_token: token
    },
    book,
    doc,
    () => reviewOriginal(book, doc)
  );
  if (
    claim.error ||
    !claim.data ||
    !['staging', 'checked', 'live'].includes(claim.data.status) ||
    !/^[a-zA-Z0-9]{22}$/.test(claim.data.assetKey)
  ) {
    throw new Error('Editorial publication is busy, withdrawn, or its source changed.');
  }
  const assetKey = String(claim.data.assetKey);
  const plan = planSnapshot(doc, {
    assetKey,
    pageIds: doc.pages.map((p) => p.id),
    includeCover: true,
    languages: ['en'],
    defaultLang: 'en',
    rating: book.metadata.rating
  });
  const publicationTime = claim.data.status === 'live' ? Date.parse(claim.data.publishedAt) : Date.now();
  if (!Number.isFinite(publicationTime)) throw new Error('Invalid editorial publication date.');
  const snapshot = buildSnapshot(doc, { ...plan, publicationId: slug, publishedAt: publicationTime });
  const assertLive = async () => {
    const response = await db.rpc('comic_originals_public_payload', { p_slug: slug });
    const payload = response.data;
    // Postgres JSONB may reorder object properties. Compare the exact public reading copy,
    // including accessible descriptions, transcripts, all sizes and the unique public book ID.
    if (
      response.error ||
      payload?.publication?.assetKey !== assetKey ||
      !isDeepStrictEqual(payload?.doc, JSON.parse(JSON.stringify(snapshot)))
    ) {
      throw new Error('The full live Studio Original could not be verified.');
    }
    return { slug };
  };
  if (claim.data.status === 'live') return assertLive();
  const ownedUpdate = async (values: Record<string, unknown>) => {
    const { data, error } = await db
      .from('studio_original_editions')
      .update(values)
      .eq('book_key', key)
      .eq('source_digest', book.digest)
      .eq('lease_token', token)
      .in('status', ['staging', 'checked'])
      .gt('lease_until', new Date().toISOString())
      .select('book_key')
      .maybeSingle();
    if (error || !data) throw new Error('Editorial publication lease or review state changed.');
  };
  try {
    if (claim.data.status !== 'checked') {
      const gate = await reviewOriginal(book, doc);
      const verified = gate.status === 'cleared';
      await ownedUpdate({
        status: verified ? 'checked' : gate.status === 'blocked' ? 'blocked' : 'staging',
        moderation_status: gate.status,
        review_report: gate.report,
        moderation_usd: Number(claim.data.moderationUsd ?? 0) + gate.costUsd,
        rating: gate.rating,
        checked_digest: verified ? book.digest : null,
        gate_hash: gate.checkedHash,
        checked_at: new Date().toISOString()
      });
      if (!verified) throw new Error('The complete original did not clear the publication checks.');
    }
    const storage = db.storage.from(PUBLIC_BUCKET);
    const put = async (path: string, bytes: Buffer, mime: string) => {
      if (!path.startsWith('pub/' + assetKey + '/')) throw new Error('Unexpected editorial destination.');
      const result = await storage.upload(path, bytes, { contentType: mime, cacheControl: '300', upsert: false });
      if (result.error && !/already exists|duplicate/i.test(result.error.message) && String(result.error.statusCode) !== '409')
        throw new Error('Editorial artwork upload failed.');
      const reread = await storage.download(path);
      if (reread.error || !reread.data || sha256(Buffer.from(await reread.data.arrayBuffer())) !== sha256(bytes))
        throw new Error('Editorial artwork checksum mismatch.');
    };
    for (const [i, image] of book.images.entries()) {
      const bytes = await verifiedBytes(image);
      const target = i ? snapshot.pages[i - 1].render.asset : snapshot.cover.render.asset;
      if (!target) throw new Error('Incomplete editorial snapshot.');
      await put(target.path, bytes, 'image/webp');
      for (const variant of target.variants || []) {
        const resized = await withSharpSlot(() => sharp(bytes).resize({ width: variant.w }).webp({ quality: 80 }).toBuffer());
        await put(variant.path, resized, 'image/webp');
      }
    }
    const og = await renderOgCard({
      title: book.metadata.title,
      subtitle: book.metadata.summary,
      kindLabel: 'Comic',
      pageCount: 15,
      lang: 'en',
      languagesLabel: 'English',
      coverBuf: await verifiedBytes(book.images[0]),
      fallbackPageBuf: null,
      showMark: true,
      rating: book.metadata.rating
    });
    const ogFile = ogPath(assetKey, 'en', sha256(og.jpeg).slice(0, 12));
    await put(ogFile, og.jpeg, 'image/jpeg');
    const card = buildShareCard({
      doc,
      snapshot,
      languages: ['en'],
      publicUrl: publicObjectUrl,
      og: { en: { path: ogFile, w: 1200, h: 630, alt: book.metadata.coverAlt.slice(0, 200) } },
      themeColor: og.themeColor,
      creator: IMPRINT
    });
    const cover = snapshot.cover.render.asset!;
    await ownedUpdate({
      status: 'live',
      snapshot,
      card,
      cover_path: cover.variants?.find((v) => v.w === 1080)?.path ?? cover.path,
      published_at: new Date(publicationTime).toISOString(),
      lease_token: null,
      lease_until: null
    });
    return await assertLive();
  } finally {
    // On transport failures release only this attempt. A crashed process loses its lease after one hour.
    await db.from('studio_original_editions').update({ lease_token: null, lease_until: null }).eq('book_key', key).eq('lease_token', token);
  }
}
