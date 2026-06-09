// Bring-your-own backend connection for a Code Studio project.
//
// Lets the user wire their OWN Supabase project (URL + anon key) into a generated app so it gets a
// real, persistent database/auth they control — no provisioning, no billing surprises, no infra we
// don't have. The connection is stored per-project (localStorage; the anon key is the public,
// client-safe key) and a one-click scaffold drops a `.env.local` + a typed `supabaseClient.ts` into
// the workspace so the app (and future AI refines) can use it. Dependency-free; SSR/test-safe.

export interface StudioBackend {
  provider: 'supabase';
  url: string;
  anonKey: string;
}

const KEY = (projectId: string): string => `dreamstream_studio_backend_${projectId}`;

/** A Supabase project URL, e.g. https://abcdefgh.supabase.co */
export const isValidSupabaseUrl = (url: string): boolean =>
  /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test((url || '').trim());

export const getBackend = (projectId?: string | null): StudioBackend | null => {
  if (!projectId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY(projectId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StudioBackend>;
    if (v && v.provider === 'supabase' && typeof v.url === 'string' && typeof v.anonKey === 'string') {
      return { provider: 'supabase', url: v.url, anonKey: v.anonKey };
    }
    return null;
  } catch {
    return null;
  }
};

export const setBackend = (projectId: string | null | undefined, conn: StudioBackend | null): void => {
  if (!projectId || typeof window === 'undefined') return;
  try {
    if (conn) window.localStorage.setItem(KEY(projectId), JSON.stringify(conn));
    else window.localStorage.removeItem(KEY(projectId));
  } catch {
    /* storage unavailable */
  }
};

/** The files to drop into the workspace to wire a Supabase backend (env + a typed client). Pure. */
export const supabaseScaffold = (url: string, anonKey: string): { path: string; content: string }[] => [
  {
    path: '/.env.local',
    content: `# Supabase backend (connected from Code Studio). The anon key is the public client key.\nVITE_SUPABASE_URL=${url.trim().replace(/\/$/, '')}\nVITE_SUPABASE_ANON_KEY=${anonKey.trim()}\n`,
  },
  {
    path: '/lib/supabaseClient.ts',
    content: `// Supabase client — reads the connected project's URL + anon key from the environment.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey);
`,
  },
];
