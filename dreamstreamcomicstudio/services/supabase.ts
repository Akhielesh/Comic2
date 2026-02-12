
import { createClient } from '@supabase/supabase-js';

// These will be populated by the user in .env.local
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    // We check for these to provide a helpful error, but we don't crash immediately 
    // to allow the app to render the "Setup Required" or Login screen effectively.
    console.warn('Missing Supabase URL or Anon Key. Authentication will not work.');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');
