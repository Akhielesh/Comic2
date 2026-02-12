
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { buildMissingServiceRoleKeyError, buildMissingSupabaseConfigError } from './serviceConfig.js';

// Load .env.local first (overrides .env in some setups, or provides missing keys)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const safeSupabaseUrl = supabaseUrl || 'http://localhost:54321';
const safeSupabaseAnonKey = supabaseAnonKey || 'missing-anon-key';

if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('SERVER: Missing Supabase URL or Key. Auth checks will fail.');
}
if (!supabaseServiceRoleKey) {
    console.warn('SERVER: Missing SUPABASE_SERVICE_ROLE_KEY. Server-side storage writes are disabled.');
}

export const supabase = createClient(safeSupabaseUrl, safeSupabaseAnonKey, {
    auth: {
        persistSession: false // Node backend doesn't need to persist session in storage
    }
});

let supabaseAdminClient: SupabaseClient | null = null;

export const getSupabaseAdmin = (): SupabaseClient => {
    if (!supabaseUrl || !supabaseAnonKey) {
        throw buildMissingSupabaseConfigError();
    }
    if (!supabaseServiceRoleKey) {
        throw buildMissingServiceRoleKeyError();
    }
    if (!supabaseAdminClient) {
        supabaseAdminClient = createClient(
            supabaseUrl,
            supabaseServiceRoleKey,
            {
                auth: {
                    persistSession: false
                }
            }
        );
    }
    return supabaseAdminClient;
};

export const getSupabaseCapabilityStatus = () => ({
    supabaseConfigured: Boolean(supabaseUrl && supabaseAnonKey),
    storagePersistenceEnabled: Boolean(supabaseUrl && supabaseServiceRoleKey)
});
