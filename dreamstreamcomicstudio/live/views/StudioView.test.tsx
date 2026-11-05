import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEvent, openRoomSocket } from '../api';
import { DiskRecorder } from '../recorder';
import type { Nav } from '../nav';
import type { PushToast } from '../ui/primitives';
import { StudioView } from './StudioView';

/* Media fakes: the studio's camera → compositor → recorder pipeline, without a browser. */
const fakes = vi.hoisted(() => {
  class FakeTrack {
    enabled = true;
    label = 'Test camera';
    constructor(public kind: string) {}
    stop() {}
    getSettings() {
      return {};
    }
  }
  class FakeStream {
    id = Math.random().toString(36).slice(2);
    private t = [new FakeTrack('video'), new FakeTrack('audio')];
    getTracks() {
      return this.t;
    }
    getVideoTracks() {
      return this.t.filter((x) => x.kind === 'video');
    }
    getAudioTracks() {
      return this.t.filter((x) => x.kind === 'audio');
    }
    clone() {
      return new FakeStream();
    }
  }
  class FakeCompositor {
    screenActive = false;
    onScreenEnded: (() => void) | null = null;
    setHostInitial() {}
    setLook() {}
    setPipLayout() {}
    setCamera() {}
    setScene() {}
    setPlaceholder() {}
    setRemoteTiles() {}
    setSpeaking() {}
    setFocus() {}
    setCamEnabled() {}
    allTiles() {
      return [];
    }
    start() {}
    stop() {}
    async startScreenShare() {
      return false;
    }
    stopScreenShare() {}
    buildOutput() {
      return new FakeStream();
    }
  }
  return { FakeStream, FakeCompositor };
});

vi.mock('../api', () => ({
  getEvent: vi.fn(),
  openRoomSocket: vi.fn(),
  sendHostExitBeacon: vi.fn(),
  uploadSegment: vi.fn(),
}));
vi.mock('../sync', () => ({ pushEventToCloud: vi.fn(async () => undefined) }));
vi.mock('../account', async (importOriginal) => {
  const signedOut = { status: 'signed_out' as const };
  return {
    ...(await importOriginal<typeof import('../account')>()),
    useAccount: () => signedOut,
    getAccount: () => signedOut,
    accountSettled: async () => signedOut,
  };
});
vi.mock('../media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media')>()),
  pickSupportedMime: () => 'video/webm',
  openCamera: vi.fn(async () => new fakes.FakeStream()),
  takePrimedCamera: () => null,
  listVideoInputs: async () => [],
  zoomCapability: () => null,
}));
vi.mock('../studio/compositor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../studio/compositor')>()),
  ProgramCompositor: fakes.FakeCompositor,
}));
vi.mock('../recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recorder')>()),
  DiskRecorder: { start: vi.fn() },
  freeSpaceBytes: async () => null,
  listUnsavedRecordings: async () => [],
}));

const meta = (status: 'idle' | 'live') => ({
  id: 'ev1', title: 'Friday show', host: 'Akhil', desc: '', cover: 0, access: 'open', quality: '720p', mime: 'video/webm',
  segMs: 2000, status, createdAt: 1, scheduledAt: null, startedAt: status === 'live' ? Date.now() - 60_000 : null, endedAt: null,
  firstSeq: 1, latestSeq: 0, lastIngestAt: null, pinned: null, slowSec: 0, reactionsOn: true, maxViewers: 100, kind: 'broadcast',
  viewers: 0, rsvpCount: 0, rsvpNames: [],
});

let sent: Record<string, unknown>[];
let nav: Nav;
let confirmSpy: ReturnType<typeof vi.spyOn>;
let push: ReturnType<typeof vi.fn<PushToast>>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sent = [];
  nav = { summary: vi.fn(), dashboard: vi.fn(), settings: vi.fn() } as unknown as Nav;
  push = vi.fn<PushToast>();
  vi.stubGlobal('MediaStream', fakes.FakeStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.mocked(openRoomSocket).mockImplementation(() => ({ send: (m: Record<string, unknown>) => void sent.push(m), close: () => undefined }));
  vi.mocked(DiskRecorder.start).mockResolvedValue({ bytes: 0, elapsedMs: 0, onDisk: false, stop: async () => ({ bytes: 0 }) } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Opens the studio and waits for the camera pipeline (the mic button + program stream). */
async function openStudio(status: 'idle' | 'live') {
  vi.mocked(getEvent).mockResolvedValue(meta(status) as never);
  render(<StudioView eventId="ev1" hostKey="hk" nav={nav} push={push} />);
  const mic = await screen.findByRole('button', { name: 'Microphone (Space)' });
  await waitFor(() => expect(openRoomSocket).toHaveBeenCalled());
  // Media is up once the camera button no longer says it is waiting.
  await waitFor(() => expect(screen.queryByText(/Waiting for permission/)).toBeNull());
  return { mic, cam: screen.getByRole('button', { name: 'Camera (V)' }) };
}

/** Lets the studio's async handlers (scene cuts, recording start) run. */
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

const press = (key: string, init: KeyboardEventInit = {}, target: Window | Element = window) =>
  act(() => {
    fireEvent.keyDown(target, { key, ...init });
  });

const ended = () => sent.some((m) => m.t === 'state' && m.status === 'ended');

describe('StudioView hotkeys · ending a stream', () => {
  it('no key ends a live stream: a stray “gg⏎” never reaches a confirm, G says to use End stream', async () => {
    await openStudio('live');
    // Even if a confirm were up, its default answer (OK) would be taken by the Enter.
    confirmSpy.mockReturnValue(true);
    press('g');
    press('g');
    press('Enter');
    await settle();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ended()).toBe(false);
    expect(nav.summary).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('Use “End stream” to finish — G won’t end a live stream', { icon: 'info' });
  });

  it('G while paused (BRB) does not end it either', async () => {
    await openStudio('live');
    press('b');
    await waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ t: 'state', status: 'paused' })));
    confirmSpy.mockReturnValue(true);
    press('g');
    await settle();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ended()).toBe(false);
  });

  it('the End stream button still asks first, and ends on OK', async () => {
    await openStudio('live');
    const end = screen.getByRole('button', { name: 'End stream' });
    fireEvent.click(end);
    expect(confirmSpy).toHaveBeenCalledWith('End the stream for everyone?');
    expect(ended()).toBe(false);
    confirmSpy.mockReturnValue(true);
    fireEvent.click(end);
    await waitFor(() => expect(nav.summary).toHaveBeenCalledWith('ev1', 'hk'));
    expect(ended()).toBe(true);
  });

  it('G when idle opens the ready check (go live keeps its countdown)', async () => {
    await openStudio('idle');
    press('g');
    expect(await screen.findByText('Ready check')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('⌘G / Ctrl+G (Find next), a held-down G and an IME keystroke never reach the end-stream confirm', async () => {
    await openStudio('live');
    press('g', { metaKey: true });
    press('g', { ctrlKey: true });
    press('g', { altKey: true });
    press('g', { repeat: true });
    press('g', { isComposing: true });
    press('g', { keyCode: 229 });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(nav.summary).not.toHaveBeenCalled();
  });
});

describe('StudioView hotkeys · browser shortcuts do nothing', () => {
  it('Ctrl+R (reload) does not start a recording; plain R does', async () => {
    await openStudio('idle');
    press('r', { ctrlKey: true });
    await settle(); // a recording would start after the async free-space check
    expect(DiskRecorder.start).not.toHaveBeenCalled();
    press('r', { metaKey: true });
    await settle();
    expect(DiskRecorder.start).not.toHaveBeenCalled();
    press('r');
    await waitFor(() => expect(DiskRecorder.start).toHaveBeenCalledTimes(1));
  });

  it('⌘V / Ctrl+V (paste) leaves the camera on; plain V toggles it', async () => {
    const { cam } = await openStudio('idle');
    press('v', { metaKey: true });
    expect(cam).not.toHaveClass('off');
    press('v', { ctrlKey: true });
    expect(cam).not.toHaveClass('off');
    press('v');
    expect(cam).toHaveClass('off');
  });

  it('Ctrl+B, Ctrl+M and Ctrl+digit leave the scene and metrics alone', async () => {
    await openStudio('live');
    press('b', { ctrlKey: true });
    press('m', { metaKey: true });
    press('2', { ctrlKey: true });
    await settle();
    expect(sent).not.toContainEqual(expect.objectContaining({ t: 'state', status: 'paused' }));
    expect(sent).not.toContainEqual(expect.objectContaining({ t: 'log', tag: 'SCENE' }));
    expect(screen.queryByText('Studio metrics')).toBeNull();
    press('m');
    expect(screen.getByText('Studio metrics')).toBeInTheDocument();
    press('b');
    await waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ t: 'state', status: 'paused' })));
  });
});

/** A real Space press on whatever has focus: keydown then keyup, both cancelable (as in a browser). */
const space = (target: Element) => {
  const down = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  const up = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(down);
    target.dispatchEvent(up);
  });
  // A browser presses a focused button unless the keydown or keyup was cancelled.
  return { pressedControl: !down.defaultPrevented && !up.defaultPrevented };
};
/** A mouse click: Chrome, Edge and Firefox (Windows/Linux) leave focus on the clicked button. */
const click = (b: HTMLElement) => {
  fireEvent.pointerDown(b);
  fireEvent.mouseDown(b);
  b.focus();
  fireEvent.mouseUp(b);
  fireEvent.click(b);
};

describe('StudioView hotkeys · Space and focus', () => {
  it('Space toggles the mic from the page', async () => {
    const { mic } = await openStudio('idle');
    press(' ');
    expect(mic).toHaveClass('off');
    press(' ');
    expect(mic).not.toHaveClass('off');
  });

  it('after clicking Record, Space still mutes — it does not press Record again', async () => {
    const { mic } = await openStudio('idle');
    const rec = screen.getByRole('button', { name: 'Record' });
    click(rec);
    await waitFor(() => expect(DiskRecorder.start).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(rec);
    expect(space(rec).pressedControl).toBe(false);
    expect(mic).toHaveClass('off');
    expect(space(rec).pressedControl).toBe(false);
    expect(mic).not.toHaveClass('off');
  });

  it('after clicking a rail tab or End stream (then Cancel), Space mutes and presses neither', async () => {
    const { mic } = await openStudio('live');
    const tab = screen.getAllByRole('tab')[0];
    click(tab);
    expect(space(tab).pressedControl).toBe(false);
    expect(mic).toHaveClass('off');
    const end = screen.getByRole('button', { name: 'End stream' });
    click(end); // confirm → Cancel; focus comes back to the button
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(space(end).pressedControl).toBe(false);
    expect(mic).not.toHaveClass('off');
  });

  it('holding Space after a click: the auto-repeat and the keyup never press the clicked button', async () => {
    const { mic } = await openStudio('idle');
    const metrics = screen.getByRole('button', { name: 'Metrics' });
    click(metrics);
    const shown = !!screen.queryByText('Studio metrics');
    const down = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    const held = new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true });
    const up = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      metrics.dispatchEvent(down);
      metrics.dispatchEvent(held);
      metrics.dispatchEvent(up);
    });
    expect([down.defaultPrevented, held.defaultPrevented, up.defaultPrevented]).toEqual([true, true, true]);
    expect(mic).toHaveClass('off'); // one press, one toggle
    expect(!!screen.queryByText('Studio metrics')).toBe(shown);
  });

  it('a control the host tabbed to keeps Space as its own press', async () => {
    const { mic } = await openStudio('idle');
    const help = screen.getByRole('button', { name: 'Help & tours' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    help.focus();
    expect(space(help).pressedControl).toBe(true); // the button's own Space press still happens
    expect(mic).not.toHaveClass('off');
    // Clicked afterwards, Space is the mute key again.
    click(help);
    expect(space(help).pressedControl).toBe(false);
    expect(mic).toHaveClass('off');
  });

  it('typing in a contentEditable region is not a hotkey', async () => {
    const { cam } = await openStudio('idle');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    press('v', {}, editor);
    expect(cam).not.toHaveClass('off');
  });

  it('hotkeys rest while a sheet is open over the studio (Invite)', async () => {
    const { cam } = await openStudio('idle');
    press('i');
    expect(await screen.findByRole('dialog', { name: 'Invite people' })).toBeInTheDocument();
    press('v');
    press(' ');
    expect(cam).not.toHaveClass('off');
    expect(screen.getByRole('button', { name: 'Microphone (Space)' })).not.toHaveClass('off');
  });
});

describe('StudioView hotkeys · under a call', () => {
  it('a call ringing or open over the studio (CallHost, full-screen aria-modal) takes the keys; minimized, the studio has them back', async () => {
    const { mic, cam } = await openStudio('live');
    const call = document.createElement('div');
    call.className = 'call-root';
    call.setAttribute('role', 'dialog');
    call.setAttribute('aria-modal', 'true');
    document.body.appendChild(call);
    press(' ', {}, call);
    press('v', {}, call);
    press('r', {}, call);
    press('2', {}, call);
    await settle();
    expect(mic).not.toHaveClass('off');
    expect(cam).not.toHaveClass('off');
    expect(DiskRecorder.start).not.toHaveBeenCalled();
    expect(sent).not.toContainEqual(expect.objectContaining({ t: 'log', tag: 'SCENE' }));
    call.removeAttribute('aria-modal'); // the call's mini window
    press('v');
    expect(cam).toHaveClass('off');
  });
});

describe('StudioView · phone chat', () => {
  it('Enter that confirms an IME candidate does not send the half-typed message', async () => {
    await openStudio('idle');
    fireEvent.click(screen.getByRole('radio', { name: /Phone/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }));
    const input = screen.getByRole('textbox', { name: 'Chat message', hidden: false });
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(sent.filter((m) => m.t === 'chat')).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent.filter((m) => m.t === 'chat')).toEqual([{ t: 'chat', text: 'こんにちは' }]);
  });
});
