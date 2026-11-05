import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEvent, openRoomSocket } from '../api';
import { DiskRecorder } from '../recorder';
import type { Nav } from '../nav';
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sent = [];
  nav = { summary: vi.fn(), dashboard: vi.fn(), settings: vi.fn() } as unknown as Nav;
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
  render(<StudioView eventId="ev1" hostKey="hk" nav={nav} push={vi.fn()} />);
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

describe('StudioView hotkeys · ending a stream', () => {
  it('G while live asks before ending; declining keeps the stream on air', async () => {
    await openStudio('live');
    press('g');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith('End the stream for everyone?');
    expect(sent).not.toContainEqual(expect.objectContaining({ t: 'state', status: 'ended' }));
    expect(nav.summary).not.toHaveBeenCalled();
  });

  it('G then confirming ends the stream', async () => {
    await openStudio('live');
    confirmSpy.mockReturnValue(true);
    press('g');
    await waitFor(() => expect(nav.summary).toHaveBeenCalledWith('ev1', 'hk'));
    expect(sent).toContainEqual(expect.objectContaining({ t: 'state', status: 'ended' }));
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

describe('StudioView hotkeys · Space and focus', () => {
  it('Space toggles the mic from the page, but not while a button has focus', async () => {
    const { mic } = await openStudio('idle');
    press(' ');
    expect(mic).toHaveClass('off');
    press(' ');
    expect(mic).not.toHaveClass('off');

    const help = screen.getByRole('button', { name: 'Help & tours' });
    help.focus();
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      help.dispatchEvent(ev);
    });
    expect(mic).not.toHaveClass('off');
    expect(ev.defaultPrevented).toBe(false); // the button's own Space press still happens
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
