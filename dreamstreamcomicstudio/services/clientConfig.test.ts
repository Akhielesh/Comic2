import { describe, expect, it } from 'vitest';
import { resolveApiBase, buildApiUrl } from './clientConfig';

describe('resolveApiBase', () => {
  it('keeps a valid absolute API base (trailing slashes trimmed)', () => {
    expect(resolveApiBase('https://dreamstream-api.example.workers.dev')).toBe('https://dreamstream-api.example.workers.dev');
    expect(resolveApiBase('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('ignores the dead Railway backend so the app falls back to same-origin', () => {
    expect(resolveApiBase('https://comic2-production.up.railway.app')).toBe('');
    expect(resolveApiBase('https://comic2-production.up.railway.app/')).toBe('');
    expect(resolveApiBase('https://anything.up.railway.app/api')).toBe('');
  });

  it('treats empty / whitespace as same-origin', () => {
    expect(resolveApiBase('')).toBe('');
    expect(resolveApiBase('   ')).toBe('');
  });

  it('builds same-origin URLs when the base is empty', () => {
    // buildApiUrl uses the resolved API_BASE_URL; with no VITE_API_BASE_URL set in the
    // test env it is '', so paths stay same-origin.
    expect(buildApiUrl('/api/account/byok')).toBe('/api/account/byok');
  });
});
