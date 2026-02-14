import { getSupabaseAdmin } from './supabase.js';

export type UserRole = 'admin' | 'moderator';

export type AccessProfile = {
  isAdmin: boolean;
  isModerator: boolean;
  bootstrapAdmin: boolean;
  roles: UserRole[];
};

const DEFAULT_ADMIN_EMAILS = ['admin@test.com'];

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

export const parseAdminEmails = () => {
  const configured = process.env.ADMIN_EMAILS
    ?.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (configured && configured.length > 0) {
    return configured;
  }

  return DEFAULT_ADMIN_EMAILS;
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
