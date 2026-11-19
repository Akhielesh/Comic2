// AlertsHost (notify SPEC §6 NF-4): the alert core runs only while someone is signed in; signing out (or switching
// account) stops it and runs its stop hooks (where a held comic stream aborts); Open routes a comic to the studio and
// a chat to Chat (the chat Chat opens is chosen first, and a Chat on screen is asked to switch). It renders nothing.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const telemetry = vi.hoisted(() => ({ captureEvent: vi.fn(), captureError: vi.fn() }));
vi.mock('../../services/telemetry', () => telemetry);

import { AlertsHost } from './AlertsHost';
import { alertsRunning, onAlertsStop, postAlert, stopAlerts } from '../../services/alerts/bus';
import { CHAT_OPEN_EVENT } from '../../services/alerts/chatOpen';
import { getLastActiveChatSessionId } from '../../services/chatStorage';
import { resetToastsForTests, ToastHost } from '../ds/Toast';

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

let seq = 0;
const host = (accountId: string | null, onOpenComic = vi.fn(), onOpenChat = vi.fn()) => (
  <>
    <ToastHost />
    <AlertsHost accountId={accountId} onOpenComic={onOpenComic} onOpenChat={onOpenChat} />
  </>
);

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  telemetry.captureEvent.mockClear();
});
afterEach(() => {
  cleanup();
  stopAlerts();
  act(() => resetToastsForTests());
  vi.restoreAllMocks();
});

describe('AlertsHost', () => {
  it('renders nothing, and never starts the core without a signed-in person', async () => {
    const { container } = render(<AlertsHost accountId={null} onOpenComic={vi.fn()} onOpenChat={vi.fn()} />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(alertsRunning()).toBe(false);
  });

  it('starts with a person; signing out stops it and runs the stop hooks (held streams abort there)', async () => {
    const hook = vi.fn();
    const off = onAlertsStop(hook);
    const view = render(host('u1'));
    await settle();
    expect(alertsRunning()).toBe(true);
    view.rerender(host(null));
    await settle();
    expect(alertsRunning()).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
    off();
  });

  it('another account starts afresh', async () => {
    const hook = vi.fn();
    const off = onAlertsStop(hook);
    const view = render(host('u1'));
    await settle();
    view.rerender(host('u2'));
    await settle();
    expect(alertsRunning()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    off();
  });

  it('Open on a comic alert opens the comic; Open on a chat alert goes to Chat with that chat chosen', async () => {
    const onOpenComic = vi.fn();
    const onOpenChat = vi.fn();
    const asked = vi.fn();
    window.addEventListener(CHAT_OPEN_EVENT, (e) => asked((e as CustomEvent).detail));
    render(host('u1', onOpenComic, onOpenChat));
    await settle();

    act(() => postAlert({ kind: 'reply', key: `k${(seq += 1)}`, target: { app: 'comic', id: 'p_spice' }, title: 'Spice Market' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenComic).toHaveBeenCalledWith('p_spice');
    expect(telemetry.captureEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'alert_open', metadata: { kind: 'reply' } }));

    act(() => postAlert({ kind: 'chat_reply', key: `k${(seq += 1)}`, target: { app: 'chat', id: 'c_week' }, title: 'Week plan' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' }).at(-1)!);
    expect(onOpenChat).toHaveBeenCalledWith('c_week');
    expect(getLastActiveChatSessionId()).toBe('c_week');
    expect(asked).toHaveBeenCalledWith({ id: 'c_week' });
    // The count carries the kind only: never a title or an id.
    for (const call of telemetry.captureEvent.mock.calls) expect(JSON.stringify(call[0])).not.toMatch(/Spice|Week|p_spice|c_week/);
  });
});
