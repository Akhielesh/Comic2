// Who is signed in, as the account menu shows them (navtheme NT-1). App fills the provider once: the person (from the
// signed-in user's own session data, so the menu reads nothing over the network to draw its trigger), whether the
// account is staff (App's existing admin probe; display only, the server still enforces every admin route), and the
// handler that runs after a sign-out (App's handleSignedOut, the same one Settings calls).
//
// The @handle and the photo live in the public profile row, not in the session (the handle can be renamed in
// Settings): the panel reads that row once, when the person opens it, and remembers it here for the page's life so
// the trigger can show the photo and a second open reads nothing.

import React, { createContext, useContext, useSyncExternalStore } from 'react';

export interface AccountPerson {
  id: string;
  /** The account's one display name, or null when none is set. */
  name: string | null;
  /** The letter on the trigger when there is no photo. */
  initial: string;
  /** The @handle without the @. Undefined: not known yet (the panel reads it on open); null: none. */
  username?: string | null;
  /** The photo. Undefined: not known yet; null: none. */
  avatarUrl?: string | null;
}

export interface AccountContextValue {
  /** Null while signed out. */
  person: AccountPerson | null;
  /** Staff see the Admin console row (the server enforces access; this only decides what the menu lists). */
  staff: boolean;
  /** Runs after signOut() resolves (App's handleSignedOut). */
  onSignedOut: () => void;
}

const noop = () => undefined;

export const AccountContext = createContext<AccountContextValue>({ person: null, staff: false, onSignedOut: noop });

export const AccountProvider: React.FC<{ value: AccountContextValue; children: React.ReactNode }> = ({ value, children }) => (
  <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
);

export const useAccount = (): AccountContextValue => useContext(AccountContext);

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);

interface SessionUser {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * The person from the signed-in user's session data: the display name every studio shares (user_metadata.display_name,
 * shared/accountName.ts), else first + last, else a provider's full name. The initial falls back to the sign-up handle,
 * then the address's first letter; the address itself is never shown.
 */
export const accountPersonOf = (user: SessionUser | null | undefined): AccountPerson | null => {
  if (!user?.id) return null;
  const meta = user.user_metadata ?? {};
  const joined = [text(meta.first_name), text(meta.last_name)].filter(Boolean).join(' ');
  const name = text(meta.display_name) || text(joined) || text(meta.full_name) || text(meta.name);
  const letterFrom = name || text(meta.username) || text(user.email) || '';
  const initial = (Array.from(letterFrom)[0] ?? '').toLocaleUpperCase() || '?';
  return { id: user.id, name, initial };
};

// ── The profile row, remembered once read ────────────────────────────────────────────────────────────────────────

export interface RememberedProfile {
  username: string | null;
  avatarUrl: string | null;
}

const remembered = new Map<string, RememberedProfile>();
const listeners = new Set<() => void>();

export const rememberProfile = (id: string, profile: RememberedProfile): void => {
  remembered.set(id, profile);
  for (const listener of [...listeners]) listener();
};

/** Test hook. */
export const forgetRememberedProfiles = (): void => {
  remembered.clear();
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The person with what the panel has read so far filled in (what App passed wins). */
export const usePersonWithProfile = (person: AccountPerson | null): AccountPerson | null => {
  const read = useSyncExternalStore(subscribe, () => (person ? remembered.get(person.id) : undefined), () => undefined);
  if (!person || !read) return person;
  return {
    ...person,
    username: person.username !== undefined ? person.username : read.username,
    avatarUrl: person.avatarUrl !== undefined ? person.avatarUrl : read.avatarUrl
  };
};
