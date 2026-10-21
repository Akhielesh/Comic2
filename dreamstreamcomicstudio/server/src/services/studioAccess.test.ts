import { describe, expect, it } from 'vitest';
import { computeStudioAccess, type AccessInputs } from './studioAccess.js';

const base: AccessInputs = { productRows: [], streamMember: true, streamGrandfathered: false, nurseries: 2, isAdmin: false };
const status = (r: ReturnType<typeof computeStudioAccess>) => Object.fromEntries(r.studios.map((s) => [s.id, s.status]));

describe('studio access', () => {
  it('open beta (no grants on file): every studio, baby monitor with its nurseries', () => {
    const r = computeStudioAccess(base);
    expect(r.confined).toBe(false);
    expect(status(r)).toEqual({ comic_studio: 'open', chat_studio: 'open', stream_studio: 'open', baby_monitor: 'open' });
    expect(r.studios.find((s) => s.id === 'baby_monitor')?.detail).toBe('2 nurseries');
  });

  it('confined by an admin: exactly the granted studios; the rest say how to get them', () => {
    const r = computeStudioAccess({ ...base, productRows: [{ product: 'stream_studio', active: true }, { product: 'comic_studio', active: false }] });
    expect(r.confined).toBe(true);
    expect(status(r)).toMatchObject({ comic_studio: 'locked', chat_studio: 'locked', stream_studio: 'open', baby_monitor: 'open' });
    const comic = r.studios.find((s) => s.id === 'comic_studio')!;
    expect(comic.detail).toBe('Access was turned off for this account');
    expect(comic.action?.label).toBe('Ask an admin for access');
    expect(r.studios.find((s) => s.id === 'chat_studio')?.detail).toBe('Not part of your account yet');
  });

  it('Stream Studio not unlocked yet: one step (welcome code), and the monitor comes with it', () => {
    const r = computeStudioAccess({ ...base, streamMember: false, nurseries: 0 });
    expect(status(r)).toMatchObject({ stream_studio: 'needs_code', baby_monitor: 'needs_code' });
    expect(r.studios.find((s) => s.id === 'stream_studio')?.action?.label).toBe('Enter welcome code');
  });

  it('an early account is unlocked on its first Stream Studio visit', () => {
    const r = computeStudioAccess({ ...base, streamMember: false, streamGrandfathered: true, nurseries: 0 });
    expect(status(r)).toMatchObject({ stream_studio: 'open', baby_monitor: 'open' });
    expect(r.studios.find((s) => s.id === 'baby_monitor')?.action?.label).toBe('Set up a nursery');
  });

  it('Code Studio shows only to admins, marked as retiring', () => {
    expect(computeStudioAccess(base).studios.some((s) => s.id === 'code_studio')).toBe(false);
    expect(status(computeStudioAccess({ ...base, isAdmin: true })).code_studio).toBe('retiring');
  });
});
