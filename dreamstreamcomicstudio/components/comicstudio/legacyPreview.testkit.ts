// Synthetic owner/project and response shape from Supabase Storage's signed object endpoint.
export const legacyPagePath = 'u/12345678-1234-4123-8123-123456789abc/p/abcdef12-3456-4789-8123-abcdef123456/img/page.webp';

export function signedLegacyPreview(path: string, bucket: string, now: number, ttl = 300, transform = false): string {
  const host = import.meta.env.VITE_SUPABASE_URL || 'https://storage.example';
  const payload = btoa(JSON.stringify({ url: bucket + '/' + path, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttl }))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return new URL('/storage/v1/' + (transform ? 'render/image' : 'object') + '/sign/' + bucket + '/' + path + '?token=test.' + payload + '.test', host).href;
}
