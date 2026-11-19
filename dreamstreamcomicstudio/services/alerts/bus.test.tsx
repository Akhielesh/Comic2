// The alert bus (notify SPEC §6 NF-1 "Bus API"), on the real ds toast slot and the page's visibility and focus:
// nothing before startAlerts or after stopAlerts; the looking target each source sets and clears; a toast with one
// Open action that only navigates; the chime through the person's prefs; the title count while away and the return
// toast; an alert toast that waits for a component toast; the stop hooks a held stream registers (NF-2).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  playChime: vi.fn(async () => true),
  unlockAudio: vi.fn(() => null),
  syncAudioToSound: vi.fn(),
  closeAudio: vi.fn()
}));
vi.mock('./chime', () => ({ playChime: audio.playChime }));
vi.mock('./audio', () => ({ unlockAudio: audio.unlockAudio, syncAudioToSound: audio.syncAudioToSound, closeAudio: audio.closeAudio }));

import { endToastClaim, resetToastsForTests, ToastHost } from '../../components/ds/Toast';
import { claimUndoToast } from '../../components/comicstudio/timeline/UndoToast';
import {
  alertsRunning,
  isLooking,
  lookingTarget,
  onAlertsStop,
  onLookingChange,
  playChimeNow,
  postAlert,
  setLooking,
  startAlerts,
  stopAlerts
} from './bus';
import { ALERT_RULES } from './rules';
import { saveAlertPrefs, __resetAlertPrefsForTests } from './prefs';
import { __resetTabBadgeForTests } from './tabBadge';
import type { AlertDraft, AlertTarget } from './types';

const SPICE: AlertTarget = { app: 'comic', id: 'p_spice' };
const CHAT: AlertTarget = { app: 'chat', id: 'c_1' };
let seq = 0;
const reply = (target: AlertTarget = SPICE): AlertDraft => ({ kind: target.app === 'chat' ? 'chat_reply' : 'reply', key: `k${(seq += 1)}`, target, title: 'Spice Market' });

let visibility: DocumentVisibilityState = 'visible';
let focused = true;
const setPage = (v: DocumentVisibilityState, f: boolean) => {
  visibility = v;
  focused = f;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
  });
};

const open = vi.fn();
const track = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  __resetAlertPrefsForTests();
  __resetTabBadgeForTests();
  document.title = 'DreamStream';
  visibility = 'visible';
  focused = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  open.mockClear();
  track.mockClear();
  Object.values(audio).forEach((fn) => fn.mockClear());
});
afterEach(() => {
  stopAlerts();
  setLooking(null, 'studio');
  setLooking(null, 'chat');
  cleanup();
  act(() => resetToastsForTests());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cards = () => Array.from(document.querySelectorAll('[data-slot="toast"]'));

describe('start and stop', () => {
  it('does nothing before startAlerts and after stopAlerts', () => {
    render(<ToastHost />);
    act(() => postAlert(reply()));
    expect(cards()).toHaveLength(0);
    expect(alertsRunning()).toBe(false);
    startAlerts({ accountId: 'u1', open, track });
    expect(alertsRunning()).toBe(true);
    stopAlerts();
    act(() => postAlert(reply()));
    expect(cards()).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(ALERT_RULES.coalesceMs));
    expect(audio.playChime).not.toHaveBeenCalled();
  });

  it('keeps the audio in step with the sound pref, and closes it on stop', () => {
    startAlerts({ accountId: 'u1', open });
    expect(audio.syncAudioToSound).toHaveBeenLastCalledWith(true);
    saveAlertPrefs({ sound: false });
    expect(audio.syncAudioToSound).toHaveBeenLastCalledWith(false);
    stopAlerts();
    expect(audio.closeAudio).toHaveBeenCalled();
  });

  it('stop hooks run once per stop (a held comic stream aborts on sign-out); unsubscribed hooks do not', () => {
    const hook = vi.fn();
    const gone = vi.fn();
    onAlertsStop(hook);
    const off = onAlertsStop(gone);
    off();
    startAlerts({ accountId: 'u1', open });
    stopAlerts();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    stopAlerts(); // already stopped
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('a new account starts afresh: what waited for the old one is gone', () => {
    startAlerts({ accountId: 'u1', open });
    setPage('hidden', false);
    act(() => postAlert(reply()));
    expect(document.title).toBe('(1) DreamStream');
    startAlerts({ accountId: 'u2', open });
    expect(document.title).toBe('DreamStream');
  });
});

describe('looking', () => {
  it('each source sets and clears its own target; another owner cannot clear it', () => {
    const seen = vi.fn();
    const off = onLookingChange(seen);
    setLooking(SPICE, 'studio');
    expect(lookingTarget()).toEqual(SPICE);
    expect(isLooking(SPICE)).toBe(true);
    expect(isLooking(CHAT)).toBe(false);
    setLooking(null, 'chat');
    expect(lookingTarget()).toEqual(SPICE);
    setLooking(null, 'studio');
    expect(lookingTarget()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it('is false while the tab is hidden or the window unfocused; a change of either is reported', () => {
    startAlerts({ accountId: 'u1', open });
    const seen = vi.fn();
    const off = onLookingChange(seen);
    setLooking(SPICE, 'studio');
    seen.mockClear();
    setPage('visible', false);
    expect(isLooking(SPICE)).toBe(false);
    expect(seen).toHaveBeenCalled();
    setPage('visible', true);
    expect(isLooking(SPICE)).toBe(true);
    off();
  });
});

describe('postAlert', () => {
  it('shows one toast with Open, which only navigates (and counts the open, with the kind only)', () => {
    render(<ToastHost />);
    startAlerts({ accountId: 'u1', open, track });
    act(() => postAlert(reply()));
    expect(screen.getByText('The Director replied')).toBeInTheDocument();
    expect(screen.getByText('Spice Market')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith(SPICE);
    expect(track).toHaveBeenCalledWith('alert_open', { kind: 'reply' });
    expect(cards()).toHaveLength(1); // leaving
  });

  it('is quiet while the person looks at that comic', () => {
    render(<ToastHost />);
    startAlerts({ accountId: 'u1', open });
    setLooking(SPICE, 'studio');
    act(() => postAlert(reply()));
    act(() => void vi.advanceTimersByTime(ALERT_RULES.coalesceMs));
    expect(cards()).toHaveLength(0);
    expect(audio.playChime).not.toHaveBeenCalled();
  });

  it('chimes with the person’s volume, or not at all with the sound off', () => {
    startAlerts({ accountId: 'u1', open });
    saveAlertPrefs({ volume: 'soft' });
    act(() => postAlert(reply()));
    act(() => void vi.advanceTimersByTime(ALERT_RULES.coalesceMs));
    expect(audio.playChime).toHaveBeenCalledWith('ready', 'soft');
    audio.playChime.mockClear();
    saveAlertPrefs({ sound: false });
    act(() => void vi.advanceTimersByTime(ALERT_RULES.chimeGapMs));
    act(() => postAlert(reply(CHAT)));
    act(() => void vi.advanceTimersByTime(ALERT_RULES.coalesceMs));
    expect(audio.playChime).not.toHaveBeenCalled();
  });

  it('while hidden: the title count, then one toast on return; the count clears', () => {
    render(<ToastHost />);
    startAlerts({ accountId: 'u1', open });
    setPage('hidden', false);
    act(() => postAlert(reply()));
    act(() => postAlert(reply(CHAT)));
    expect(document.title).toBe('(2) DreamStream');
    expect(cards()).toHaveLength(0);
    setPage('visible', true);
    expect(document.title).toBe('DreamStream');
    expect(screen.getByText('2 updates')).toBeInTheDocument();
  });

  it('waits for a component toast (a timeline Undo) and shows when it ends', () => {
    render(<ToastHost />);
    startAlerts({ accountId: 'u1', open });
    const undo = claimUndoToast();
    act(() => postAlert(reply()));
    expect(cards()).toHaveLength(0);
    act(() => endToastClaim(undo));
    expect(screen.getByText('The Director replied')).toBeInTheDocument();
  });

  it('an alert toast goes away once the person opens what it is about', () => {
    render(<ToastHost />);
    startAlerts({ accountId: 'u1', open });
    act(() => postAlert(reply()));
    expect(cards()).toHaveLength(1);
    act(() => setLooking(SPICE, 'studio'));
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.queryByText('The Director replied')).toBeNull();
  });
});

describe('playChimeNow (the Play button, the classic generator)', () => {
  it('honours the sound pref and the volume; from a gesture it unlocks the audio first', async () => {
    saveAlertPrefs({ volume: 'soft' });
    expect(await playChimeNow('ready', { gesture: true })).toBe(true);
    expect(audio.unlockAudio).toHaveBeenCalledTimes(1);
    expect(audio.playChime).toHaveBeenCalledWith('ready', 'soft', { after: 0 });
    await playChimeNow('needsYou', { after: 0.75 });
    expect(audio.unlockAudio).toHaveBeenCalledTimes(1);
    expect(audio.playChime).toHaveBeenLastCalledWith('needsYou', 'soft', { after: 0.75 });
    saveAlertPrefs({ sound: false });
    expect(await playChimeNow('ready', { gesture: true })).toBe(false);
    expect(audio.playChime).toHaveBeenCalledTimes(2);
  });
});
