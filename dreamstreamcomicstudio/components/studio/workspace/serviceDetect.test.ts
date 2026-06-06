import { describe, it, expect } from 'vitest';
import { detectServices, buildEnvExample } from './serviceDetect';

describe('detectServices', () => {
  it('detects Supabase from the client import and collects env vars', () => {
    const files = [
      { path: '/src/db.ts', content: "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);" },
    ];
    const r = detectServices(files);
    expect(r.services.map((s) => s.id)).toContain('supabase');
    expect(r.envVars).toEqual(['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL']);
  });

  it('detects Postgres + Stripe from a node server', () => {
    const files = [
      { path: '/server.js', content: "import pg from 'pg';\nimport Stripe from 'stripe';\nconst pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);" },
    ];
    const ids = detectServices(files).services.map((s) => s.id);
    expect(ids).toContain('postgres');
    expect(ids).toContain('stripe');
  });

  it('ignores build noise env vars (NODE_ENV, PORT)', () => {
    const files = [{ path: '/server.js', content: 'const p = process.env.PORT; const e = process.env.NODE_ENV; const k = process.env.API_KEY;' }];
    expect(detectServices(files).envVars).toEqual(['API_KEY']);
  });

  it('returns nothing for a plain UI with no services or env', () => {
    const r = detectServices([{ path: '/App.tsx', content: 'export default () => <div>hi</div>;' }]);
    expect(r.services).toEqual([]);
    expect(r.envVars).toEqual([]);
  });

  it('buildEnvExample renders KEY= lines (and a placeholder when empty)', () => {
    expect(buildEnvExample(['A_KEY', 'B_URL'])).toContain('A_KEY=');
    expect(buildEnvExample(['A_KEY', 'B_URL'])).toContain('B_URL=');
    expect(buildEnvExample([])).toContain('(none detected)');
  });
});
