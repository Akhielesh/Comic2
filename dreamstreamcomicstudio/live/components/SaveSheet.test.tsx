// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinishedRecording } from '../recorder';

const h = vi.hoisted(() => ({
  account: { status: 'member', userId: 'u1', email: 'me@example.com' } as { status: string; userId?: string },
  drive: null as null | Record<string, unknown>,
  quota: null as null | { usedBytes: number; limitBytes: number; copies: number; nextFreeAt: number | null },
}));

vi.mock('../account', () => ({
  useAccount: () => h.account,
  openAuth: vi.fn(),
}));
vi.mock('../api', () => ({ uploadRecording: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('../events', () => ({ addMyRecording: vi.fn() }));
vi.mock('../cloudCopy', async (orig) => {
  const real = await orig<typeof import('../cloudCopy')>();
  return { ...real, fetchCloudCopyQuota: vi.fn(async () => h.quota) };
});
vi.mock('../recorder', () => ({ discardOpfsRecording: vi.fn(async () => undefined), removeUnsaved: vi.fn() }));
vi.mock('../driveUpload', async (orig) => {
  const real = await orig<typeof import('../driveUpload')>();
  return {
    ...real,
    useDriveStatus: () => h.drive,
    getDriveStatus: vi.fn(async () => h.drive),
    openConsentWindow: vi.fn(() => ({ close: vi.fn() }) as unknown as Window),
    connectDrive: vi.fn(),
    saveRecordingToDrive: vi.fn(),
  };
});

import { uploadRecording } from '../api';
import { CloudCopyError, fetchCloudCopyQuota } from '../cloudCopy';
import { connectDrive, DriveError, getDriveStatus, openConsentWindow, saveRecordingToDrive } from '../driveUpload';
import { discardOpfsRecording } from '../recorder';
import { cloudCopyNoticePending, savePrefs, loadPrefs } from '../prefs';
import { SaveSheet } from './SaveSheet';

const rec = (): FinishedRecording => ({
  data: new Blob([new Uint8Array(4096)], { type: 'video/webm' }),
  file: 'Friday show.webm',
  mime: 'video/webm;codecs=vp9,opus',
  bytes: 4096,
  durMs: 65_000,
  opfsName: 'rec-1',
  eventId: 'ev1',
  title: 'Friday show',
});

const connected = { signedIn: true, available: true, connected: true, expired: false, email: 'me@example.com' };
const notConnected = { signedIn: true, available: true, connected: false, expired: false };

const SAVED = { id: 'f1', name: 'Friday show.webm', webViewLink: 'https://drive.google.com/file/d/f1/view', folderUrl: 'https://drive.google.com/drive/folders/fold' };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.account = { status: 'member', userId: 'u1' };
  h.drive = null;
  h.quota = null;
});

const renderSheet = (props: Partial<React.ComponentProps<typeof SaveSheet>> = {}) => {
  const push = vi.fn();
  const onClose = vi.fn();
  render(<SaveSheet rec={rec()} push={push} onClose={onClose} {...props} />);
  return { push, onClose };
};

describe('SaveSheet — Google Drive', () => {
  it('connected: uploads with progress, then offers "Open in Drive"', async () => {
    h.drive = connected;
    let release!: () => void;
    vi.mocked(saveRecordingToDrive).mockImplementation(async (_b, _n, o = {}) => {
      o.onSession?.({ uploadUrl: 'u', folderId: 'fold' });
      o.onProgress?.(2048, 4096);
      await new Promise<void>((r) => (release = r));
      return SAVED;
    });
    const { push } = renderSheet();

    fireEvent.click(screen.getByRole('button', { name: /Save to Google Drive/ }));
    expect(await screen.findByText(/Uploading to Google Drive · 50%/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB of 4\.0 KB|2 KB of 4 KB/)).toBeInTheDocument();
    expect(vi.mocked(saveRecordingToDrive).mock.calls[0][1]).toBe('Friday show.webm');
    expect(vi.mocked(saveRecordingToDrive).mock.calls[0][2]).toMatchObject({ mimeType: 'video/webm;codecs=vp9,opus' });

    await act(async () => release());
    const link = await screen.findByRole('link', { name: /Open in Drive/ });
    expect(link).toHaveAttribute('href', SAVED.webViewLink);
    expect(link).toHaveAttribute('target', '_blank');
    expect(push).toHaveBeenCalledWith(expect.stringContaining('Google Drive · DreamStream Recordings/Friday show.webm'), expect.anything());
    expect(discardOpfsRecording).toHaveBeenCalledWith('rec-1');
  });

  it('not connected: one tap connects (popup opened inside the tap), then uploads', async () => {
    h.drive = notConnected;
    vi.mocked(connectDrive).mockResolvedValue(connected as never);
    vi.mocked(saveRecordingToDrive).mockResolvedValue(SAVED);
    renderSheet();

    const opt = screen.getByRole('button', { name: /Connect Google Drive/ });
    expect(opt).toHaveTextContent('Stream Studio can only see files it saves — never the rest of your Drive.');
    fireEvent.click(opt);
    expect(openConsentWindow).toHaveBeenCalledTimes(1);
    await screen.findByRole('link', { name: /Open in Drive/ });
    expect(connectDrive).toHaveBeenCalledWith(expect.objectContaining({ popup: expect.anything() }));
    expect(saveRecordingToDrive).toHaveBeenCalled();
  });

  it('popup blocked: explains how to fix it without leaving the page', async () => {
    h.drive = notConnected;
    vi.mocked(openConsentWindow).mockReturnValueOnce(null);
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /Connect Google Drive/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked the Google sign-in window/);
    expect(connectDrive).not.toHaveBeenCalled();
  });

  it('shows a specific error for a full Drive, with a storage link and the fallbacks still available', async () => {
    h.drive = connected;
    vi.mocked(saveRecordingToDrive).mockRejectedValue(new DriveError('quota'));
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /Save to Google Drive/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Google Drive is full/);
    expect(screen.getByRole('link', { name: /Manage Drive storage/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /To your browser’s Downloads folder/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Download, then add to Drive/ })).toBeInTheDocument();
  });

  it('reconnect needed: offers Reconnect', async () => {
    h.drive = { ...connected, expired: true };
    renderSheet();
    expect(screen.getByRole('button', { name: /Reconnect Google Drive/ })).toBeInTheDocument();
  });

  it('signed out: keeps the no-sign-in Drive route and suggests signing in', () => {
    h.account = { status: 'signed_out' };
    h.drive = { signedIn: false, available: true, connected: false, expired: false };
    renderSheet();
    expect(screen.queryByRole('button', { name: /Connect Google Drive/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Save to Google Drive/ })).toBeInTheDocument();
    expect(screen.getByText(/to upload recordings straight to Google Drive/)).toBeInTheDocument();
  });

  it('server without Google OAuth: only the fallbacks, with their original wording', () => {
    h.drive = { signedIn: true, available: false, connected: false, expired: false };
    renderSheet();
    expect(screen.queryByRole('button', { name: /Connect Google Drive/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Save to Google Drive/ })).toHaveLength(1);
  });

  it('remembered “Google Drive” + connected: starts the upload by itself when autoStart', async () => {
    savePrefs({ ...loadPrefs(), saveTarget: 'drive' });
    h.drive = connected;
    vi.mocked(saveRecordingToDrive).mockResolvedValue(SAVED);
    renderSheet({ autoStart: true });
    await waitFor(() => expect(saveRecordingToDrive).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('link', { name: /Open in Drive/ })).toBeInTheDocument();
  });

  it('asks before closing mid-upload, and stops the upload if you leave', async () => {
    h.drive = connected;
    let signal: AbortSignal | undefined;
    vi.mocked(saveRecordingToDrive).mockImplementation(async (_b, _n, o = {}) => {
      signal = o.signal;
      o.onSession?.({ uploadUrl: 'u', folderId: 'f' });
      return new Promise((_r, reject) => o.signal?.addEventListener('abort', () => reject(new DriveError('aborted'))));
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /Save to Google Drive/ }));
    await screen.findByText(/Uploading to Google Drive/);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });
});

const GB = 1024 ** 3;
const quotaOf = (usedGb: number, extra: Partial<{ copies: number; nextFreeAt: number | null }> = {}) => ({
  usedBytes: usedGb * GB,
  limitBytes: 10 * GB,
  copies: 2,
  nextFreeAt: null,
  ...extra,
});
const cloudRow = () => screen.getByRole('region', { name: /7-day copy on our servers/ });

describe('SaveSheet — free first, the 7-day copy only when chosen (ADR 0007 C1)', () => {
  it('every Drive and device option says it is free; the copy on our servers never does', async () => {
    h.drive = connected;
    h.quota = quotaOf(3.1);
    renderSheet({ hostKey: 'hk' });
    expect(screen.getByRole('button', { name: /Save to Google Drive/ })).toHaveTextContent('Free · yours to keep');
    expect(screen.getByRole('button', { name: /To your browser’s Downloads folder/ })).toHaveTextContent('Free · on this device');
    await waitFor(() => expect(cloudRow()).toHaveTextContent('kept 7 days · 3.1 of 10 GB used'));
    expect(cloudRow()).toHaveTextContent('7-day copy · 4 KB');
    expect(cloudRow()).toHaveTextContent(/Uses our storage/);
    expect(cloudRow().textContent).not.toMatch(/free/i);
    // The copy sits below the free choices.
    const order = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(order.findIndex((t) => /Keep a 7-day copy/.test(t))).toBeGreaterThan(order.findIndex((t) => /To your browser’s Downloads folder/.test(t)));
  });

  it('by default nothing uploads to our servers until the host taps “Keep a 7-day copy”', async () => {
    h.quota = quotaOf(1);
    vi.mocked(uploadRecording).mockResolvedValue({ key: 'k', quota: quotaOf(1.5) });
    const { push } = renderSheet({ hostKey: 'hk' });
    const keep = await screen.findByRole('button', { name: /Keep a 7-day copy/ });
    await waitFor(() => expect(keep).not.toBeDisabled());
    expect(uploadRecording).not.toHaveBeenCalled();
    expect(fetchCloudCopyQuota).toHaveBeenCalledWith('ev1', 'hk');

    fireEvent.click(keep);
    await waitFor(() => expect(cloudRow()).toHaveTextContent('Stored'));
    expect(uploadRecording).toHaveBeenCalledTimes(1);
    expect(cloudRow()).toHaveTextContent('1.5 of 10 GB used');
    expect(push).toHaveBeenCalledWith(expect.stringContaining('7-day copy stored'), expect.anything());
  });

  it('without a studio link there is no 7-day copy at all (and no quota read)', () => {
    renderSheet();
    expect(screen.queryByRole('region', { name: /7-day copy on our servers/ })).toBeNull();
    expect(fetchCloudCopyQuota).not.toHaveBeenCalled();
  });

  it('a host who turned on “Also keep a 7-day cloud copy” still gets it right away', async () => {
    savePrefs({ ...loadPrefs(), cloudRecordings: true });
    h.quota = quotaOf(2);
    renderSheet({ hostKey: 'hk' });
    await waitFor(() => expect(uploadRecording).toHaveBeenCalledTimes(1));
    expect(cloudRow()).toHaveTextContent(/Started because “Also keep a 7-day cloud copy” is on/);
  });

  it('opted in but no room left: says so (and when space frees up) instead of uploading', async () => {
    savePrefs({ ...loadPrefs(), cloudRecordings: true });
    const at = Date.UTC(2026, 9, 29, 12);
    h.quota = quotaOf(10, { nextFreeAt: at });
    renderSheet({ hostKey: 'hk' });
    await waitFor(() => expect(cloudRow()).toHaveTextContent(/doesn’t have room for this one/));
    expect(cloudRow()).toHaveTextContent(/Google Drive and this device are free/);
    expect(cloudRow()).toHaveTextContent(new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
    expect(uploadRecording).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Keep a 7-day copy/ })).toBeNull();
  });

  it('the server’s “full” answer is shown as-is, with the day space frees up — no pointless retry', async () => {
    h.quota = quotaOf(5);
    const at = Date.UTC(2026, 9, 27, 9);
    const msg = 'Your 10 GB of 7-day copies is full (9.0 GB used; this recording is 3.0 GB). Save it to Google Drive (free, yours to keep) or to this device instead — or wait for an older copy to expire.';
    vi.mocked(uploadRecording).mockRejectedValue(new CloudCopyError('cloud_copy_full', msg, { freesAt: at, usedBytes: 9 * GB, limitBytes: 10 * GB }));
    renderSheet({ hostKey: 'hk' });
    const keep = await screen.findByRole('button', { name: /Keep a 7-day copy/ });
    await waitFor(() => expect(keep).not.toBeDisabled());
    fireEvent.click(keep);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(msg);
    expect(alert).toHaveTextContent(/Space frees up/);
    expect(cloudRow()).toHaveTextContent('9.0 of 10 GB used');
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByRole('button', { name: /To your browser’s Downloads folder/ })).not.toBeDisabled();
  });

  it('any other failure keeps the device copy safe and offers a retry', async () => {
    h.quota = quotaOf(1);
    vi.mocked(uploadRecording).mockRejectedValue(new Error('part 3 failed (502)'));
    renderSheet({ hostKey: 'hk' });
    const keep = await screen.findByRole('button', { name: /Keep a 7-day copy/ });
    await waitFor(() => expect(keep).not.toBeDisabled());
    fireEvent.click(keep);
    expect(await screen.findByRole('alert')).toHaveTextContent(/still safe on this device/);
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('tells a host whose old default was switched off — once', async () => {
    localStorage.setItem('ds-live-prefs', JSON.stringify({ ...loadPrefs(), cloudRecordings: true, prefsVersion: undefined }));
    expect(loadPrefs().cloudRecordings).toBe(false); // migration (see prefs.unit.test.ts)
    expect(cloudCopyNoticePending()).toBe(true);
    h.quota = quotaOf(0);
    const first = render(<SaveSheet rec={rec()} hostKey="hk" push={vi.fn()} onClose={vi.fn()} />);
    expect(cloudRow()).toHaveTextContent(/7-day copies are now made only when you choose one/);
    expect(uploadRecording).not.toHaveBeenCalled();
    await waitFor(() => expect(cloudCopyNoticePending()).toBe(false));
    first.unmount();
    renderSheet({ hostKey: 'hk' });
    expect(cloudRow()).not.toHaveTextContent(/now made only when you choose one/);
  });

  it('signed out: the copy asks for sign-in first (no upload, no quota read)', () => {
    h.account = { status: 'signed_out' };
    h.drive = { signedIn: false, available: true, connected: false, expired: false };
    renderSheet({ hostKey: 'hk' });
    expect(fetchCloudCopyQuota).not.toHaveBeenCalled();
    expect(cloudRow()).toHaveTextContent('Sign in');
  });

  it('a Drive save asks the backend nothing more once the upload finishes (≤ 1 backend wake per save)', async () => {
    h.drive = connected;
    vi.mocked(saveRecordingToDrive).mockResolvedValue(SAVED);
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /Save to Google Drive/ }));
    await screen.findByRole('link', { name: /Open in Drive/ });
    expect(screen.getByText(/DreamStream Recordings · me@example\.com/)).toBeInTheDocument();
    expect(getDriveStatus).not.toHaveBeenCalled();
  });
});
