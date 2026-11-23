// Supabase Edge Function. Deploy with gateway JWT verification enabled. The public project
// JWT alone cannot read this endpoint. The private backup reader also presents its scoped token.
const PROJECT_ORIGIN = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const EXPECTED_DIGEST = '__BACKUP_TOKEN_SHA256__';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SIGNED_SECONDS = 600;
const isBucket = (v: unknown): v is string => v === 'comic-assets' || v === 'comic-private';
const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const unavailable = () => json({ error: 'Backup source unavailable' }, 503);

interface ManifestRow {
  id: string; bucket: string; name: string; version: string | null; size: number | null; etag: string | null; updatedAt: string;
}
interface SourceOptions {
  digest: string;
  getServiceKey: () => string | undefined;
  fetcher?: typeof fetch;
}

async function tokenMatches(token: string | null, expected: string) {
  if (!token || token.length > 512 || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  let mismatch = 0;
  for (let i = 0; i < hash.length; i++) mismatch |= hash[i] ^ parseInt(expected.slice(2 * i, 2 * i + 2), 16);
  return mismatch === 0;
}

// The Storage batch endpoint returns a relative signedURL and the original object path. Build
// our absolute URL from the manifest name and fixed host, never from an arbitrary upstream URL.
function pinnedUrl(bucket: string, name: string, signed: string) {
  const marker = signed.lastIndexOf('?token=');
  const prefix = '/object/sign/' + bucket + '/';
  if (marker < 0 || !signed.startsWith(prefix)) throw new Error('Invalid signing result');
  const returned = signed.slice(prefix.length, marker);
  if (returned !== name && decodeURIComponent(returned) !== name) throw new Error('Signing mismatch');
  const token = signed.slice(marker + 7);
  if (!/^[a-zA-Z0-9._-]{1,8192}$/.test(token)) throw new Error('Invalid token shape');
  const parts = name.split('/');
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Invalid object path');
  return PROJECT_ORIGIN + '/storage/v1' + prefix + parts.map(encodeURIComponent).join('/') + '?token=' + token;
}

export function createBackupSource({ digest, getServiceKey, fetcher = fetch }: SourceOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!await tokenMatches(request.headers.get('X-Backup-Token'), digest)) return json({ error: 'Unauthorized' }, 401);
    let input: { bucket?: unknown; afterId?: unknown; limit?: unknown };
    try {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Invalid request' }, 400);
      const text = await request.text();
      if (text.length > 512) return json({ error: 'Invalid request' }, 400);
      input = JSON.parse(text);
    } catch { return json({ error: 'Invalid request' }, 400); }
    if (!input || !isBucket(input.bucket) || !Number.isInteger(input.limit) || typeof input.limit !== 'number' ||
      input.limit < 1 || input.limit > 50 || !(input.afterId === null || (typeof input.afterId === 'string' && UUID.test(input.afterId)))) {
      return json({ error: 'Invalid request' }, 400);
    }
    const { bucket, afterId, limit } = input;
    try {
      const secret = getServiceKey();
      if (!secret) return unavailable();
      const headers = { apikey: secret, Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' };
      const post = (path: string, body: object) => fetcher(PROJECT_ORIGIN + path, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000)
      });
      const listed = await post('/rest/v1/rpc/comic_artwork_backup_manifest', { p_bucket: bucket, p_after: afterId, p_limit: limit });
      if (!listed.ok) return unavailable();
      const rows = await listed.json() as ManifestRow[];
      if (!Array.isArray(rows) || rows.length > limit) return unavailable();
      if (!rows.length) return json({ items: [] });
      let previous = typeof afterId === 'string' ? afterId.toLowerCase() : '';
      for (const row of rows) {
        if (!row || !UUID.test(row.id) || row.id.toLowerCase() <= previous || row.bucket !== bucket || typeof row.name !== 'string' || !row.name ||
            !(row.version === null || typeof row.version === 'string') || !(row.etag === null || typeof row.etag === 'string') ||
            !(row.size === null || (Number.isSafeInteger(row.size) && row.size >= 0)) ||
            typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return unavailable();
        previous = row.id.toLowerCase();
      }
      const sign = await post('/storage/v1/object/sign/' + bucket, { expiresIn: SIGNED_SECONDS, paths: rows.map(row => row.name) });
      if (!sign.ok) return unavailable();
      const links = await sign.json() as Array<{ path: string; error?: string | null; signedURL: string }>;
      if (!Array.isArray(links) || links.length !== rows.length) return unavailable();
      const byPath = new Map(links.map(link => [link.path, link]));
      const items = rows.map(({ id, name, version, size, etag, updatedAt }) => {
        const link = byPath.get(name);
        if (!link || link.error || typeof link.signedURL !== 'string') throw new Error('Signing failed');
        return { id, bucket, name, version, size, etag, updatedAt, signedUrl: pinnedUrl(bucket, name, link.signedURL) };
      });
      return json({ items });
    } catch { return unavailable(); }
  };
}

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown };
if (typeof Deno !== 'undefined') Deno.serve(createBackupSource({ digest: EXPECTED_DIGEST, getServiceKey: () => Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }));
