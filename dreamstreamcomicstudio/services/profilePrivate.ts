type SupabaseLikeError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
};

export const isMissingPrivateProfileTableError = (error: unknown): boolean => {
  const err = (error || {}) as SupabaseLikeError;
  const code = String(err.code || '').toUpperCase();
  const message = String(err.message || '').toLowerCase();
  const details = String(err.details || '').toLowerCase();
  const hint = String(err.hint || '').toLowerCase();
  const status = Number(err.status || 0);

  if (code === 'PGRST116' || code === 'PGRST205') return true;
  if (status === 404 && (message.includes('profile_private') || details.includes('profile_private'))) return true;
  if (message.includes('relation') && message.includes('profile_private') && message.includes('does not exist')) return true;
  if (details.includes('schema cache') && details.includes('profile_private')) return true;
  if (hint.includes('schema cache') && hint.includes('profile_private')) return true;
  return false;
};
