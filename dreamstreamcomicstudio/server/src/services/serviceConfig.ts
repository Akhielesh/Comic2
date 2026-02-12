export type PublicConfigError = Error & {
  status: number;
  publicCode: string;
  details?: unknown;
};

export const createPublicConfigError = (
  message: string,
  options: {
    status: number;
    publicCode: string;
    details?: unknown;
  }
): PublicConfigError => {
  const error = new Error(message) as PublicConfigError;
  error.status = options.status;
  error.publicCode = options.publicCode;
  error.details = options.details;
  return error;
};

export const buildMissingServiceRoleKeyError = () =>
  createPublicConfigError(
    'Image storage persistence is unavailable because SUPABASE_SERVICE_ROLE_KEY is missing.',
    {
      status: 503,
      publicCode: 'MISSING_SERVICE_ROLE_KEY',
      details: 'Set SUPABASE_SERVICE_ROLE_KEY in server environment variables.'
    }
  );

export const buildMissingSupabaseConfigError = () =>
  createPublicConfigError(
    'Supabase configuration is incomplete for server-side persistence.',
    {
      status: 503,
      publicCode: 'MISSING_SUPABASE_CONFIG',
      details: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in server environment variables.'
    }
  );
