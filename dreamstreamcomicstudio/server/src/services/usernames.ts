import { randomInt } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UsernameAvailability } from '../../../shared/username.js';

export async function lookupHandles(admin: SupabaseClient, candidates: string[]) {
  const { data, error } = await admin.rpc('lookup_signup_handles', { candidates });
  if (error || !Array.isArray(data)) throw new Error('Username lookup unavailable.');
  return new Map<string, string>(data.map(row => [row.handle, row.profile_id]));
}

export async function checkUsername(admin: SupabaseClient, username: string): Promise<UsernameAvailability> {
  const key = username.toLowerCase();
  const suffixes = ['_art', '_studio', '_' + randomInt(100, 10000)];
  const candidates = suffixes.map(suffix => username.slice(0, 20 - suffix.length) + suffix);
  const matches = await lookupHandles(admin, [username, ...candidates]);
  return matches.has(key)
    ? { available: false, suggestions: candidates.filter(candidate => candidate.toLowerCase() !== key && !matches.has(candidate.toLowerCase())) }
    : { available: true, suggestions: [] };
}
