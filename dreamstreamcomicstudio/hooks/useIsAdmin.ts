// Whether the signed-in user is a platform admin. Admins are NEVER feature-gated —
// every product/flag (Code Studio, "Run live", coming-soon surfaces) is always available
// to them — so this is the single signal the UI checks before hiding anything.
//
// Backed by /api/admin/me (services/billing.getAdminAccess). Cached per user-id at module
// scope so the probe runs once per session, not once per component that asks.

import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getAdminAccess } from '../services/billing';

let cache: { userId: string; isAdmin: boolean } | null = null;
let inflight: { userId: string; promise: Promise<boolean> } | null = null;

const fetchIsAdmin = (userId: string): Promise<boolean> => {
  if (cache?.userId === userId) return Promise.resolve(cache.isAdmin);
  if (inflight?.userId === userId) return inflight.promise;
  const promise = getAdminAccess()
    .then((access) => {
      const value = !!access?.isAdmin;
      cache = { userId, isAdmin: value };
      return value;
    })
    .catch(() => {
      // 403 / network → treat as non-admin (fail closed).
      cache = { userId, isAdmin: false };
      return false;
    })
    .finally(() => {
      if (inflight?.userId === userId) inflight = null;
    });
  inflight = { userId, promise };
  return promise;
};

export const useIsAdmin = (): boolean => {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean>(
    user && cache?.userId === user.id ? cache.isAdmin : false
  );

  useEffect(() => {
    let active = true;
    if (!user?.id) {
      setIsAdmin(false);
      return;
    }
    fetchIsAdmin(user.id).then((value) => {
      if (active) setIsAdmin(value);
    });
    return () => {
      active = false;
    };
  }, [user?.id]);

  return isAdmin;
};
