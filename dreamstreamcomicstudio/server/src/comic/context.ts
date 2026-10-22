// Per-request wiring for Comic Studio (v4).
//
// A StudioContext bundles everything the director, tools and job runner need for one
// request: the session (doc + events), the user's provider keys, the text/image
// transports, asset storage, billing hooks, the abort signal and two helpers —
// publishUrls() (sign new storage paths and stream them) and track() (register
// background work so the SSE response stays open until it settles).
//
// Every dependency is injectable so routes and tests can swap in fakes.

import type { Request } from 'express';
import { logger } from '../lib/logger.js';
import { createSupabaseAssetStore } from './assets.js';
import { createBillingHooks } from './billing.js';
import { createImageGenerator } from './imageClient.js';
import { studioKeysFromRequest } from './keys.js';
import { createLlmClient } from './llm.js';
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
}): OrchestratorContext {
  const { req, session } = args;
  const deps = args.deps || {};
  const keys = deps.keys || studioKeysFromRequest(req);
  const assets = deps.assets || defaultAssetStore();
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
    billing: deps.billing || createBillingHooks(req, session.projectId),
    signal: args.signalFrom || session.abort.signal,
    ...(args.qualityDenied ? { qualityDenied: args.qualityDenied } : {}),

    async publishUrls(paths: string[]) {
      const unique = [...new Set((paths || []).filter((p) => typeof p === 'string' && p))];
      if (!unique.length) return;
      try {
        const urls = await assets.signUrls(unique);
        if (urls && Object.keys(urls).length) session.emit({ type: 'urls', urls });
      } catch (err) {
        // The asset is saved; the client re-signs on its next load.
        logger.warn('comic_publish_urls_failed', { projectId: session.projectId, count: unique.length, message: (err as Error)?.message });
      }
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
