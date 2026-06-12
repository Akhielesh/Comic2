import { getSupabaseAdmin } from './supabase.js';

export type UserRole = 'admin' | 'moderator' | 'researcher';

export type AccessProfile = {
  isAdmin: boolean;
  isModerator: boolean;
  /** Researchers/analysts: may run model benchmarks and build reports — NOT full admin. */
  isResearcher: boolean;
  bootstrapAdmin: boolean;
  roles: UserRole[];
};

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

// Platform owners — ALWAYS bootstrap admins, locked in code so a misconfigured
// ADMIN_EMAILS env can never lock the owners out. Owners (and any admin) can
// grant further admin/moderator/researcher roles via the admin role endpoints;
// no guessable defaults beyond these two real accounts.
const OWNER_ADMIN_EMAILS = ['akhieleshsrirangam@gmail.com', 'akhielesh99@gmail.com'];

export const parseAdminEmails = () => {
  const configured = process.env.ADMIN_EMAILS
    ?.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean) ?? [];
  return Array.from(new Set([...OWNER_ADMIN_EMAILS, ...configured]));
};

export const isBootstrapAdminEmail = (email?: string | null) => {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return parseAdminEmails().includes(normalized);
};

export const getUserRoles = async (userId: string): Promise<UserRole[]> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('user_roles')
      .select('role, is_active')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) {
      if (isMissingTableError(error)) return [];
      throw error;
    }
    if (!Array.isArray(data)) return [];

    const roles = new Set<UserRole>();
    for (const row of data as Array<Record<string, unknown>>) {
      const role = String(row.role || '').toLowerCase();
      if (role === 'admin' || role === 'moderator' || role === 'researcher') {
        roles.add(role);
      }
    }
    return Array.from(roles);
  } catch {
    return [];
  }
};

export const resolveAccessProfile = async (input: {
  userId: string;
  email?: string | null;
}): Promise<AccessProfile> => {
  const roles = await getUserRoles(input.userId);
  const bootstrapAdmin = isBootstrapAdminEmail(input.email);
  const isAdmin = bootstrapAdmin || roles.includes('admin');
  const isModerator = isAdmin || roles.includes('moderator');
  const isResearcher = isAdmin || roles.includes('researcher');

  return {
    isAdmin,
    isModerator,
    isResearcher,
    bootstrapAdmin,
    roles
  };
};
