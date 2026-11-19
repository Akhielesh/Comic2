// @vitest-environment jsdom
// The member hint follows this tab's sign-in and sign-out, and a tab that merely opens signed out (another tab holds
// the session, "Remember me" off) never removes it.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => vi.fn());
vi.mock('../services/productHost', () => ({ syncMemberHint: sync }));

import { useMemberHint } from './useMemberHint';

beforeEach(() => sync.mockReset());

describe('useMemberHint', () => {
  it('a tab that opens signed out leaves the hint alone', () => {
    const { rerender } = renderHook(({ signedIn, loading }) => useMemberHint(signedIn, loading), {
      initialProps: { signedIn: false, loading: true }
    });
    rerender({ signedIn: false, loading: false });
    rerender({ signedIn: false, loading: false });
    expect(sync).not.toHaveBeenCalled();
  });

  it('sets the hint while signed in, and removes it when this tab signs out', () => {
    const { rerender } = renderHook(({ signedIn, loading }) => useMemberHint(signedIn, loading), {
      initialProps: { signedIn: false, loading: true }
    });
    expect(sync).not.toHaveBeenCalled();
    rerender({ signedIn: true, loading: false });
    expect(sync).toHaveBeenLastCalledWith(true);
    rerender({ signedIn: false, loading: false });
    expect(sync).toHaveBeenLastCalledWith(false);
    expect(sync).toHaveBeenCalledTimes(2);
    // Signed out again later: nothing more to remove.
    rerender({ signedIn: false, loading: false });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the auth state is still loading', () => {
    renderHook(() => useMemberHint(true, true));
    expect(sync).not.toHaveBeenCalled();
  });
});
