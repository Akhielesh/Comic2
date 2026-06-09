import { describe, it, expect, beforeEach } from 'vitest';
import { getBackend, setBackend, isValidSupabaseUrl, supabaseScaffold } from './studioBackend';

describe('studioBackend', () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* ignore */ } });

  it('validates Supabase project URLs', () => {
    expect(isValidSupabaseUrl('https://abcd1234.supabase.co')).toBe(true);
    expect(isValidSupabaseUrl('https://abcd1234.supabase.co/')).toBe(true);
    expect(isValidSupabaseUrl('http://abcd.supabase.co')).toBe(false); // must be https
    expect(isValidSupabaseUrl('https://example.com')).toBe(false);
    expect(isValidSupabaseUrl('')).toBe(false);
  });

  it('stores + reads a connection per project', () => {
    setBackend('p1', { provider: 'supabase', url: 'https://x.supabase.co', anonKey: 'k' });
    expect(getBackend('p1')).toEqual({ provider: 'supabase', url: 'https://x.supabase.co', anonKey: 'k' });
    expect(getBackend('p2')).toBeNull();
    setBackend('p1', null);
    expect(getBackend('p1')).toBeNull();
  });

  it('scaffolds env + a typed client', () => {
    const files = supabaseScaffold('https://x.supabase.co/', 'anon-123');
    const env = files.find((f) => f.path === '/.env.local')!;
    const client = files.find((f) => f.path === '/lib/supabaseClient.ts')!;
    expect(env.content).toContain('VITE_SUPABASE_URL=https://x.supabase.co');
    expect(env.content).toContain('VITE_SUPABASE_ANON_KEY=anon-123');
    expect(client.content).toContain("from '@supabase/supabase-js'");
    expect(client.content).toContain('createClient');
  });
});
