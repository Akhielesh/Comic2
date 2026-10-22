// Per-request wiring for Comic Studio (v4).
//
// A StudioContext bundles everything the director, tools and job runner need for one
// request: the session (doc + events), the user's provider keys, the text/image
// transports, asset storage, billing hooks, the abort signal and two helpers —
// publishUrls() (sign new storage paths and stream them) and track() (register
// background work so the SSE response stays open until it settles).
//
// v5 (contract §12.1, §12.5): the context also carries the request's StudioCaps and
// effective rating, a spend lock for restricted accounts (no image or translation spend
// can even reserve), and signs private paths (reference photos) with a 300 s TTL.
//
// Every dependency is injectable so routes and tests can swap in fakes.

import type { Request } from 'express';
import type { StudioCaps } from '../../../shared/comic/capabilities.js';
import type { ContentRating } from '../../../shared/comic/safety.js';
import { logger } from '../lib/logger.js';
import { createSupabaseAssetStore } from './assets.js';
import { createBillingHooks } from './billing.js';
import { createImageGenerator } from './imageClient.js';
import { studioKeysFromRequest } from './keys.js';
import { createLlmClient } from './llm.js';
import { SIGNED_TTL_SEC, isPrivatePath } from './storagePaths.js';
import type {
  AssetStore,
  BillingHooks,
  ImageGenerator,
  LlmClient,
  StudioContext,
  StudioKeys,
  StudioSessionApi
} from './types.js';

/**
 * The orchestrator's view of a context: the agreed StudioContext plus request-scoped
 * facts the route resolved up front.
 */
export interface OrchestratorContext extends StudioContext {
  /**
   * Set when the user may not spend on the Pro tier (no paid plan, platform key). Spend
   * actions on Pro then stop with this message instead of rendering.
   */
  qualityDenied?: string;
  /** Set when this account may not start paid work (moderation `restricted`); the user-facing reason. */
  spendBlocked?: string;
  /** Resolves when every tracked piece of work has settled (including work added meanwhile). */
  settled(): Promise<void>;
}

export interface StudioContextDeps {
  keys?: StudioKeys;
  llm?: LlmClient;
  images?: ImageGenerator;
  assets?: AssetStore;
  billing?: BillingHooks;
}

/**
 * Sign storage paths for display, routed per lane: private paths (reference photos,
 * quarantine) get the short private TTL, everything else the public TTL. A failure in one
 * lane never drops the other's URLs. Never throws.
 */
export async function signAssetPaths(assets: AssetStore, paths: string[], log: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const unique = [...new Set((paths || []).filter((p): p is string => typeof p === 'string' && !!p))];
  if (!unique.length) return {};
  const priv = unique.filter(isPrivatePath);
  const pub = unique.filter((p) => !isPrivatePath(p));
  const sign = async (group: string[], ttlSec?: number): Promise<Record<string, string>> => {
    if (!group.length) return {};
    try {
      return (await assets.signUrls(group, ttlSec ? { ttlSec } : undefined)) || {};
    } catch (err) {
      logger.warn('comic_sign_urls_failed', { ...log, count: group.length, private: !!ttlSec, message: (err as Error)?.message });
      return {};
    }
  };
  const [a, b] = await Promise.all([sign(pub), sign(priv, SIGNED_TTL_SEC.private)]);
  return { ...a, ...b };
}

/** Image units / translation are paid work; chat, planning and QC text stay available. */
const isPaidReserve = (args: Parameters<BillingHooks['reserve']>[0]): boolean => (args.imageUnits ?? 0) > 0 || args.stage === 'translate';

/** Billing hooks that refuse paid work up front (restricted accounts) and pass text through. */
export const spendLockedBilling = (inner: BillingHooks, message: string): BillingHooks => ({
  async reserve(args) {
    if (isPaidReserve(args)) return { ok: false, code: 'BILLING_DENIED', message };
    return inner.reserve(args);
  }
});

let sharedAssetStore: AssetStore | null = null;
/** One Supabase asset store per process (it owns the data-URL and signed-URL caches). */
export const defaultAssetStore = (): AssetStore => {
  if (!sharedAssetStore) sharedAssetStore = createSupabaseAssetStore();
  return sharedAssetStore;
};

export function createStudioContext(args: {
  req: Request;
  session: StudioSessionApi;
  /** Signal for this request's turn (defaults to the session's abort signal). */
  signalFrom?: AbortSignal;
  deps?: StudioContextDeps;
  qualityDenied?: string;
  /** What this user may do (resolveStudioCaps); absent ⇒ consumers use DEFAULT_CAPS. */
  caps?: StudioCaps;
  /** effectiveRating() for this request (account ceiling applied). */
  rating?: ContentRating;
  /** Restricted account: paid work is refused with this message (text work still runs). */
  spendBlocked?: string;
}): OrchestratorContext {
  const { req, session } = args;
  const deps = args.deps || {};
  const keys = deps.keys || studioKeysFromRequest(req);
  const assets = deps.assets || defaultAssetStore();
  const billing = deps.billing || createBillingHooks(req, session.projectId);
  const pending = new Set<Promise<unknown>>();
  const retain = (session as { retain?: () => () => void }).retain?.bind(session) as (() => () => void) | undefined;

  const ctx: OrchestratorContext = {
    session,
    userId: session.userId,
    projectId: session.projectId,
    keys,
    llm: deps.llm || createLlmClient(keys),
    images: deps.images || createImageGenerator(keys),
    assets,
    billing: args.spendBlocked ? spendLockedBilling(billing, args.spendBlocked) : billing,
    signal: args.signalFrom || session.abort.signal,
    ...(args.qualityDenied ? { qualityDenied: args.qualityDenied } : {}),
    ...(args.spendBlocked ? { spendBlocked: args.spendBlocked } : {}),
    ...(args.caps ? { caps: args.caps } : {}),
    ...(args.rating ? { rating: args.rating } : {}),

    async publishUrls(paths: string[]) {
      // The asset is saved either way; on a signing failure the client re-signs on its next load.
      const urls = await signAssetPaths(assets, paths, { projectId: session.projectId, via: 'publish' });
      if (Object.keys(urls).length) session.emit({ type: 'urls', urls });
    },

    track<T>(work: Promise<T>): Promise<T> {
      const release = retain?.();
      const entry = work.then(
        () => undefined,
        () => undefined
      );
      pending.add(entry);
      void entry.finally(() => {
        pending.delete(entry);
        release?.();
      });
      return work;
    },

    async settled() {
      while (pending.size) await Promise.all([...pending]);
    }
  };
  return ctx;
}
