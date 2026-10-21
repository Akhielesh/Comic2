// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinishedRecording } from '../recorder';

const h = vi.hoisted(() => ({
  account: { status: 'member', userId: 'u1', email: 'me@example.com' } as { status: string; userId?: string },
  drive: null as null | Record<string, unknown>,
}));

vi.mock('../account', () => ({
  useAccount: () => h.account,
  openAuth: vi.fn(),
}));
vi.mock('../api', () => ({ uploadRecording: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('../events', () => ({ addMyRecording: vi.fn() }));
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

import { connectDrive, DriveError, openConsentWindow, saveRecordingToDrive } from '../driveUpload';
import { discardOpfsRecording } from '../recorder';
import { savePrefs, loadPrefs } from '../prefs';
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
