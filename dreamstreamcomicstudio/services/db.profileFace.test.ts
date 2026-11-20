// The account menu reads two fields of the profile row, the @handle and the photo, and nothing else: never the
// address, the bio, the website or the consent flags (getProfileFace, components/account/AccountPanel.tsx).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  result: { data: { username: 'ada', avatar_url: null } as unknown, error: null as unknown }
}));

vi.mock('./supabase', () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    const record = (name: string) => (...args: unknown[]) => {
      sb.calls.push([name, ...args]);
      return q;
    };
    Object.assign(q, {
      select: record('select'),
      eq: record('eq'),
      single: async () => {
        sb.calls.push(['single']);
        return sb.result;
      },
      maybeSingle: async () => {
        sb.calls.push(['maybeSingle']);
        return sb.result;
      }
    });
    return q;
  };
  return {
    supabase: {
      auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
      from: (table: string) => {
        sb.calls.push(['from', table]);
        return chain();
      },
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: p } }) }) }
    }
  };
});

const { getProfileFace } = await import('./db');

beforeEach(() => {
  sb.calls.length = 0;
  sb.result = { data: { username: 'ada', avatar_url: null }, error: null };
});

describe('getProfileFace', () => {
  it('selects the handle and the photo only, for one id, without failing on a missing row', async () => {
    expect(await getProfileFace('person-1')).toEqual({ username: 'ada', avatar_url: null });
    expect(sb.calls).toEqual([['from', 'profiles'], ['select', 'username, avatar_url'], ['eq', 'id', 'person-1'], ['maybeSingle']]);
  });

  it('reads as nothing when there is no row or the read fails', async () => {
    sb.result = { data: null, error: null };
    expect(await getProfileFace('person-1')).toBeNull();
    sb.result = { data: null, error: { message: 'offline' } };
    expect(await getProfileFace('person-1')).toBeNull();
  });
});
