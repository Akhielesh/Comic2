// Per-account product access (product_access table) — the client-side mirror of the
// server's standalone-studio onboarding. Semantics (see server/sql/product_access.sql):
//   - no rows for the user  → unrestricted (open beta default)        → null
//   - rows present          → the account is confined to exactly the   → Set of active
//                             products with active = true                products
// Every failure (signed out, table missing, RLS/network error) degrades to null
// (unrestricted) so a backend hiccup can never lock paying users out of the suite.
//
// Admin management of grants goes through the Railway server (service-role writes):
//   POST /api/admin/product-access  · GET /api/admin/product-access?email=…

import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { get, post } from './apiClient';

export const PRODUCT_IDS = ['stream_studio', 'comic_studio', 'chat_studio'] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export const PRODUCT_LABELS: Record<ProductId, string> = {
  stream_studio: 'Stream Studio',
  comic_studio: 'Comic Studio',
  chat_studio: 'Chat Studio'
};

/** null = unrestricted (or unknown — callers must treat null as "allow"). */
export type AllowedProducts = Set<ProductId> | null;

const isProductId = (value: unknown): value is ProductId =>
  typeof value === 'string' && (PRODUCT_IDS as readonly string[]).includes(value);

// ── Module cache (one fetch per signed-in user, shared by every consumer) ──────
let cache: { userId: string; allowed: AllowedProducts } | null = null;
let inflight: { userId: string; promise: Promise<AllowedProducts> } | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // a broken subscriber must not break the others
    }
  });
};

/** Drop the cached access set (e.g. after an admin changed grants) and re-notify hooks. */
export const invalidateProductAccess = () => {
  cache = null;
  inflight = null;
  notify();
};

// Invalidate whenever the signed-in user actually changes (sign-in / sign-out / user
// switch). TOKEN_REFRESHED fires constantly on refocus — same user id keeps the cache.
let lastSeenUserId: string | null | undefined;
supabase.auth.onAuthStateChange((_event, session) => {
  const userId = session?.user?.id ?? null;
  if (userId !== lastSeenUserId) {
    lastSeenUserId = userId;
    invalidateProductAccess();
  }
});

/**
 * The signed-in user's allowed products. Resolves to:
 *   - null            → unrestricted (no rows, signed out, or any failure)
 *   - Set<ProductId>  → the account is confined to exactly these products
 *                       (possibly empty when every grant is revoked)
 */
export const getAllowedProducts = async (): Promise<AllowedProducts> => {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return null;
    if (cache?.userId === userId) return cache.allowed;
    if (inflight?.userId === userId) return inflight.promise;

    const promise = (async (): Promise<AllowedProducts> => {
      const { data, error } = await supabase
        .from('product_access')
        .select('product, active')
        .eq('user_id', userId);
      // Missing table / RLS error / no rows ⇒ unrestricted.
      if (error || !data || data.length === 0) return null;
      const allowed = new Set<ProductId>();
      for (const row of data) {
        if (row?.active === true && isProductId(row.product)) allowed.add(row.product);
      }
      return allowed;
    })()
      .then((allowed) => {
        cache = { userId, allowed };
        notify();
        return allowed;
      })
      .catch((): AllowedProducts => {
        cache = { userId, allowed: null };
        return null;
      })
      .finally(() => {
        if (inflight?.userId === userId) inflight = null;
      });
    inflight = { userId, promise };
    return promise;
  } catch {
    return null;
  }
};

/**
 * React hook: the current user's allowed products, kept fresh across auth changes.
 * Returns null while loading/unrestricted — treat null as "allow everything".
 */
export const useProductAccess = (): AllowedProducts => {
  const [allowed, setAllowed] = useState<AllowedProducts>(() => cache?.allowed ?? null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getAllowedProducts().then((value) => {
        if (active) setAllowed(value);
      });
    };
    refresh();
    listeners.add(refresh);
    return () => {
      active = false;
      listeners.delete(refresh);
    };
  }, []);

  return allowed;
};

// ── Admin endpoints (requireAdmin on the server) ───────────────────────────────
export interface ProductAccessGrant {
  product: ProductId;
  active: boolean;
  note?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ProductAccessLookup {
  userId: string;
  email: string;
  grants: ProductAccessGrant[];
}

/** Admin: look up a user's per-studio grants by email. */
export const adminGetProductAccess = (email: string): Promise<ProductAccessLookup> =>
  get(`/api/admin/product-access?email=${encodeURIComponent(email)}`);

export interface SetProductAccessInput {
  email: string;
  product: ProductId;
  active: boolean;
  note?: string;
  /** When granting: also send the branded studio-invite email. */
  sendInvite?: boolean;
  inviterName?: string;
  personalNote?: string;
}

/** Admin: grant/revoke one studio for a user (optionally emailing the studio invite). */
export const adminSetProductAccess = (
  input: SetProductAccessInput
): Promise<{ success: boolean; userId: string; product: ProductId; active: boolean; emailed: boolean }> =>
  post('/api/admin/product-access', input);
