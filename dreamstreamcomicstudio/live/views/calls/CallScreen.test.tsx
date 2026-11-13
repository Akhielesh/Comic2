// The call screen covers the whole app (FaceTime-style), so it is a modal dialog: whatever is
// underneath — a live Stream Studio included — must not act on its keys (ui/hotkeys.ts
// isModalOpen). Minimized, the call is a small floating window and the page is usable again.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveView } from '../../calls/callCenter';
import { isModalOpen } from '../../ui/hotkeys';

vi.mock('../../account', () => ({ searchPeople: async () => [] }));
vi.mock('../../monitor/client', () => ({ listPeople: async () => ({ ok: true, people: [] }) }));
vi.mock('../../monitor/invite', () => ({ openInvite: vi.fn() }));
vi.mock('../../calls/callCenter', () => ({
  isDirect: (nid: string) => nid.startsWith('d:'),
  useCalls: () => ({ favs: [], uid: 'me' }),
  callCenter: { dismiss: vi.fn(), hangup: vi.fn(), toggleMic: vi.fn(), toggleCam: vi.fn(), flip: vi.fn(), retry: vi.fn(), invite: vi.fn() },
}));

import { CallScreen } from './CallScreen';

const active = (over: Partial<ActiveView> = {}): ActiveView => ({
  nid: 'd:0123456789abcdef', nursery: 'Stream Studio member', id: '0123456789abcdef', outgoing: true, video: false, state: 'calling',
  call: null, peers: [], local: { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream, mic: true, cam: false,
  canFlip: false, facing: 'user', ended: null, asked: [{ uid: 'sam', name: 'Sam' }], since: null, failText: null, why: null,
  busy: false, relayTest: false, receipt: null, ...over,
});

describe('CallScreen · modal over the app', () => {
  it('the full-screen call is aria-modal (studio hotkeys rest under it); the minimized window is not', () => {
    render(<CallScreen a={active()} push={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Call with Sam' })).toHaveAttribute('aria-modal', 'true');
    expect(isModalOpen()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize the call' }));
    expect(screen.getByRole('dialog', { name: 'Call with Sam' })).not.toHaveAttribute('aria-modal');
    expect(isModalOpen()).toBe(false);
  });
});
