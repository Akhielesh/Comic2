// Software reuse for Comic Studio renders (contract §12.3, softwarefirst.md §1.4).
//
// Image models are not deterministic, so "same input ⇒ reuse" must never block a user who
// WANTS a new take. Every rule here applies to IMPLICIT requests only (draw what is missing
// or out of date); an explicit redraw, edit, variation or safer take always draws.
//
//   R1  no-op guard        a ready, current target is never drawn again
//   R2  spec-hash reuse    a version (history or archive) made from exactly today's spec is
//                          put back for free instead of being drawn again
//   R3  job-hash reuse     an asset anywhere in the doc made by the identical job (model,
//                          resolution, aspect, prompt, reference paths) is copied for free
//   R7  in-flight join     an identical job already drawing in this session is awaited
//                          instead of paying for it twice
//
// Each reuse is recorded by the job runner as a zero-cost spend entry carrying `savedUsd`
// (decisions-final #6: "Free — done by the editor, no AI cost").

import { createHash } from 'node:crypto';
import {
  archiveOf,
  getRender,
  isTargetStale,
  renderTargetKey,
  specHashFor,
  trashOf,
  type ArchivedVersion,
  type AssetRef,
  type ComicDoc,
  type RenderState,
  type RenderTarget,
  type RenderVersion,
  type VersionMeta
} from '../../../shared/comic/doc.js';
import { formatUsd } from '../../../shared/comic/models.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';

const isBusy = (r?: RenderState) => r?.status === 'queued' || r?.status === 'rendering';

// ── R1 ───────────────────────────────────────────────────────────────────────

/** Ready, not stale and not busy: an implicit request has nothing to draw here. */
export const isReadyAndCurrent = (doc: ComicDoc, target: RenderTarget): boolean => {
  const r = getRender(doc, target);
  return !!r && r.status === 'ready' && !!r.asset?.path && !isTargetStale(doc, target);
};

// ── R2 ───────────────────────────────────────────────────────────────────────

export interface SpecHashMatch {
  path: string;
  /** Where the version lives: the target's own history, or the project archive. */
  from: 'history' | 'archive';
  version: RenderVersion | ArchivedVersion;
}

/**
 * A stored version of this target made from exactly the target's CURRENT spec (newest first),
 * that the owner may see. Null when the target has no spec hash (style options), the current
 * asset already matches (R1), or nothing matches.
 */
export const findSpecHashVersion = (doc: ComicDoc, target: RenderTarget): SpecHashMatch | null => {
  const render = getRender(doc, target);
  if (!render) return null;
  const want = specHashFor(doc, target);
  if (!want) return null;
  const current = render.asset?.path;
  if (current && render.status === 'ready' && render.specHash === want) return null;
  for (const v of render.history) {
    if (v?.path && v.path !== current && v.specHash === want && canServeToOwner(v)) return { path: v.path, from: 'history', version: v };
  }
  const key = renderTargetKey(target);
  for (const a of archiveOf(doc)) {
    if (a?.path && a.targetKey === key && a.path !== current && a.specHash === want && canServeToOwner(a)) return { path: a.path, from: 'archive', version: a };
  }
  return null;
};

// ── R3 ───────────────────────────────────────────────────────────────────────

/**
 * Exact fingerprint of an image job after reference loading: model, resolution, aspect, the
 * compiled prompt and the storage paths actually attached (order-insensitive). 96 bits of
 * SHA-256, so an accidental match can never copy the wrong picture into a page.
 */
export const jobHashOf = (job: { specId: string; resolution: string; aspect: string; prompt: string; referencePaths: string[] }): string =>
  createHash('sha256')
    .update(JSON.stringify(['job/1', job.specId, job.resolution, job.aspect, job.prompt, [...job.referencePaths].sort()]))
    .digest('hex')
    .slice(0, 24);

export interface JobHashMatch {
  /** The asset to copy (variants and safety verdict travel with it). */
  asset: AssetRef;
  /** Meta of the version it came from (qc is reusable: the job was identical). */
  meta: VersionMeta;
  model?: string;
  from: RenderTarget;
}

const assetOf = (v: AssetRef & Record<string, unknown>): AssetRef => {
  const out: AssetRef = { path: v.path, source: v.source, at: v.at };
  if (typeof v.w === 'number') out.w = v.w;
  if (typeof v.h === 'number') out.h = v.h;
  if (typeof v.model === 'string') out.model = v.model;
  if (Array.isArray(v.variants)) out.variants = v.variants as AssetRef['variants'];
  if (v.safety && typeof v.safety === 'object') out.safety = v.safety as AssetRef['safety'];
  if (typeof v.libraryId === 'string') out.libraryId = v.libraryId;
  if (typeof v.derivedFrom === 'string') out.derivedFrom = v.derivedFrom;
  return out;
};

const metaOf = (v: VersionMeta): VersionMeta => {
  const out: VersionMeta = {};
  if (v.specHash) out.specHash = v.specHash;
  if (v.qc) out.qc = v.qc;
  if (v.resolution) out.resolution = v.resolution;
  if (v.aspect) out.aspect = v.aspect;
  if (v.jobHash) out.jobHash = v.jobHash;
  if (v.continuityPath) out.continuityPath = v.continuityPath;
  if (v.refPaths?.length) out.refPaths = [...v.refPaths];
  return out;
};

/** Every render in the doc (live targets plus trashed pages) with the target that addresses it. */
const allRenders = (doc: ComicDoc): { target: RenderTarget; render: RenderState }[] => {
  const out: { target: RenderTarget; render: RenderState }[] = [];
  doc.pages.forEach((p) => out.push({ target: { kind: 'page', id: p.id }, render: p.render }));
  out.push({ target: { kind: 'cover' }, render: doc.cover.render });
  doc.cast.forEach((c) => out.push({ target: { kind: 'sheet', id: c.id }, render: c.sheet }));
  doc.places.forEach((p) => out.push({ target: { kind: 'place', id: p.id }, render: p.sheet }));
  doc.style.options.forEach((o) => out.push({ target: { kind: 'style_option', id: o.id }, render: o.render }));
  trashOf(doc).forEach((t) => out.push({ target: { kind: 'page', id: t.page.id }, render: t.page.render }));
  return out;
};

/**
 * An asset anywhere in the doc made by the identical job, that the owner may see and that
 * is not already the target's current image. Current assets are preferred over history.
 */
export const findJobHashAsset = (doc: ComicDoc, jobHash: string, target: RenderTarget): JobHashMatch | null => {
  if (!jobHash) return null;
  const own = getRender(doc, target)?.asset?.path;
  const renders = allRenders(doc);
  for (const { target: from, render } of renders) {
    if (render.asset?.path && render.asset.path !== own && !isBusy(render) && render.jobHash === jobHash && canServeToOwner(render.asset)) {
      return { asset: assetOf(render.asset as AssetRef & Record<string, unknown>), meta: metaOf(render), model: render.model ?? render.asset.model, from };
    }
  }
  for (const { target: from, render } of renders) {
    for (const v of render.history) {
      if (v?.path && v.path !== own && v.jobHash === jobHash && canServeToOwner(v)) {
        return { asset: assetOf(v as AssetRef & Record<string, unknown>), meta: metaOf(v), model: v.model, from };
      }
    }
  }
  return null;
};

// ── R7 ───────────────────────────────────────────────────────────────────────

/**
 * Identical jobs currently drawing, per session. The first caller registers; a second caller
 * with the same hash awaits the first one's asset (null when it failed — then it draws).
 */
export class InflightJobs {
  private readonly jobs = new Map<string, Promise<AssetRef | null>>();

  /** The in-flight promise for this hash, if any. */
  get(hash: string): Promise<AssetRef | null> | undefined {
    return this.jobs.get(hash);
  }

  /** Register a job; call `settle(asset | null)` exactly once when it lands or fails. */
  register(hash: string): (asset: AssetRef | null) => void {
    let resolve!: (asset: AssetRef | null) => void;
    const promise = new Promise<AssetRef | null>((r) => (resolve = r));
    this.jobs.set(hash, promise);
    let settled = false;
    return (asset) => {
      if (settled) return;
      settled = true;
      if (this.jobs.get(hash) === promise) this.jobs.delete(hash);
      resolve(asset);
    };
  }

  get size(): number {
    return this.jobs.size;
  }
}

// ── Ledger text ──────────────────────────────────────────────────────────────

/** "Page 1 (reused — saved ≈$0.07)" — the zero-cost ledger line for a reuse. */
export const reusedLabel = (label: string, savedUsd: number): string =>
  savedUsd > 0 ? `${label} (reused — saved ≈${formatUsd(savedUsd)})` : `${label} (reused)`;
