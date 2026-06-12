import { getSupabaseAdmin } from './supabase.js';

export type UserRole = 'admin' | 'moderator';

export type AccessProfile = {
  isAdmin: boolean;
  isModerator: boolean;
  bootstrapAdmin: boolean;
  roles: UserRole[];
};

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

// Fail CLOSED when ADMIN_EMAILS is unset: an empty allowlist means no bootstrap
// admins. (A guessable default like admin@test.com would hand full admin to
// whoever registers that address on a fresh deployment.) Durable admins come
// from the user_roles table; ADMIN_EMAILS only bootstraps the first one.
export const parseAdminEmails = () =>
  process.env.ADMIN_EMAILS
    ?.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean) ?? [];

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
      if (role === 'admin' || role === 'moderator') {
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

  return {
    isAdmin,
    isModerator,
    bootstrapAdmin,
    roles
  };
};
