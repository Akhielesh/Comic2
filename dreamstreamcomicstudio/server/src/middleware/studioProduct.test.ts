import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
const db = vi.hoisted(() => ({ read: vi.fn(), role: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ getSupabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: db.read }) }) }) }));
vi.mock('../services/rbac.js', () => ({ resolveAccessProfile: db.role }));
import { requireStudioProduct } from './studioProduct.js';

const gate = requireStudioProduct('chat_studio', 'Chat Studio', 'Chat Studio');
const run = async (userId?: string) => {
  const next = vi.fn();
  const status = vi.fn().mockReturnValue({ json: vi.fn() });
  const req = { user: userId ? { id: userId } : undefined, body: { userId: 'other', isAdmin: true } } as unknown as Request;
  await gate(req, { set: vi.fn(), status } as unknown as Response, next);
  return { next, status };
};
beforeEach(() => { db.read.mockReset(); db.role.mockReset().mockResolvedValue({ isAdmin: false }); });
describe('Chat Studio account access', () => {
  it('requires a verified account before reading grants', async () => {
    expect((await run()).status).toHaveBeenCalledWith(401);
    expect(db.read).not.toHaveBeenCalled();
  });
  it('passes existing open accounts and the specific owner’s active grant', async () => {
    db.read.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [{ product: 'chat_studio', active: true }] });
    expect((await run('a')).next).toHaveBeenCalled();
    expect((await run('b')).next).toHaveBeenCalled();
    expect(db.read.mock.calls).toEqual([['user_id', 'a'], ['user_id', 'b']]);
  });
  it('rejects another studio or a revoked grant and only honors server-verified admins', async () => {
    db.read.mockResolvedValue({ data: [{ product: 'comic_studio', active: true }, { product: 'chat_studio', active: false }] });
    expect((await run('a')).status).toHaveBeenCalledWith(403);
    db.role.mockResolvedValue({ isAdmin: true });
    expect((await run('b')).next).toHaveBeenCalled();
  });
  it('makes no provider dispatch if the entitlement source is unavailable', async () => {
    db.read.mockRejectedValue(new Error('unavailable'));
    const { next, status } = await run('a');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
  });
});
