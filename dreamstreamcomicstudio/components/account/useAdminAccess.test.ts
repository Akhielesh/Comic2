// The admin flag belongs to one account: switching accounts never carries roles over while the
// new account's /api/admin/me check is in flight, and a failed check means no access.
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ getAdminAccess: vi.fn() }));
vi.mock('../../services/billing', () => ({ getAdminAccess: h.getAdminAccess }));

const { useAdminAccess } = await import('./useAdminAccess');

describe('useAdminAccess', () => {
  it('signed out: no access, settled', () => {
    const { result } = renderHook(() => useAdminAccess(null));
    expect(result.current).toEqual({ isAdmin: false, isModerator: false, access: null, checked: true });
    expect(h.getAdminAccess).not.toHaveBeenCalled();
  });

  it('a failed check means no access', async () => {
    h.getAdminAccess.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useAdminAccess('user-a'));
    expect(result.current.checked).toBe(false);
    await waitFor(() => expect(result.current.checked).toBe(true));
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isModerator).toBe(false);
  });

  it('switching accounts drops the previous roles until the new answer arrives', async () => {
    h.getAdminAccess.mockResolvedValueOnce({ isAdmin: true, isModerator: true });
    const renders: [string, boolean][] = [];
    const { result, rerender } = renderHook(
      ({ id }) => {
        const v = useAdminAccess(id);
        renders.push([id, v.isAdmin]);
        return v;
      },
      { initialProps: { id: 'admin-user' } }
    );
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    let release: (v: unknown) => void = () => undefined;
    h.getAdminAccess.mockReturnValueOnce(new Promise((r) => (release = r)));
    rerender({ id: 'other-user' });
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.checked).toBe(false);
    await act(async () => release({ isAdmin: false, isModerator: true }));
    expect(result.current).toMatchObject({ isAdmin: false, isModerator: true, checked: true });
    // Not even one render of the other account saw the previous account's admin flag.
    expect(renders.filter(([id, admin]) => id === 'other-user' && admin)).toEqual([]);
  });
});
