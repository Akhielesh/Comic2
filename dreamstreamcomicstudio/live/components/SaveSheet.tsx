// "Your recording is ready — where should it go?"
// Replaces the old silent auto-download (which dumped multi-GB files into
// Downloads mid-stream and stalled the tab). Every option streams from the
// disk-backed recording, so even hour-long masters save without a RAM spike.
//
// Free first (ADR 0007): Google Drive and this device cost nobody anything and the
// file is yours to keep. The 7-day copy on our servers is the one option that uses
// our storage (and your upload), so it's an explicit opt-in below them, with its
// size and the account's 10 GB allowance shown before anything uploads.
//
// Google Drive has two routes:
//  - Connected (Google's API, drive.file scope): uploads straight into
//    "DreamStream Recordings" in the user's Drive, resumable, with progress
//    and an "Open in Drive" link. Bytes go browser → Google, never via us.
//  - Fallbacks that need no Google sign-in here: a Drive-for-desktop folder,
//    the phone share sheet, or download + open drive.google.com.
import React, { useEffect, useRef, useState } from 'react';
import { openAuth, useAccount } from '../account';
import { uploadRecording } from '../api';
import {
  CloudCopyError,
  fetchCloudCopyQuota,
  fitsQuota,
  fmtFreeDay,
  quotaLine,
  quotaPct,
  type CloudCopyErrorCode,
  type CloudCopyQuota,
} from '../cloudCopy';
import {
  DRIVE_PRIVACY_NOTE,
  DriveError,
  connectDrive,
  driveErrorMessage,
  getDriveStatus,
  openConsentWindow,
  peekDriveStatus,
  saveRecordingToDrive,
  useDriveStatus,
  type DriveErrorCode,
} from '../driveUpload';
import { addMyRecording } from '../events';
import { CLOUD_COPY_DRIVE_TIP, CLOUD_COPY_HEAD, FREE_CHIP, allowanceLevel, cloudCopyNotice } from '../costCopy';
import { addSave, type SaveDest } from '../usage/ledger';
import { fmtBytes, fmtDuration } from '../metrics';
import { cloudCopyNoticePending, loadPrefs, markCloudCopyNoticeSeen, savePrefs, type StudioPrefs } from '../prefs';
import { discardOpfsRecording, removeUnsaved, type FinishedRecording } from '../recorder';
import {
  DRIVE_UPLOAD_URL,
  canPickFolder,
  canPickSaveLocation,
  canShareFile,
  downloadFile,
  getDriveFolder,
  isPhoneLike,
  pickDriveFolder,
  saveToFolder,
  saveWithPicker,
  shareFile,
} from '../saveTargets';
import { Icon } from '../ui/icons';
import { Btn, Meter, cx, type PushToast } from '../ui/primitives';

const DISCARD_KEY = 'ds-live-discard-later';

/** Downloads read the disk copy lazily — delete it later, not right away. */
function discardLater(name: string | null): void {
  if (!name) return;
  removeUnsaved(name);
  try {
    const list = JSON.parse(localStorage.getItem(DISCARD_KEY) || '[]') as { name: string; at: number }[];
    list.push({ name, at: Date.now() });
    localStorage.setItem(DISCARD_KEY, JSON.stringify(list.slice(-20)));
  } catch { /* storage unavailable */ }
}

/** Run on app start: purge disk copies of recordings downloaded >1 h ago. */
export async function sweepDiscardedRecordings(): Promise<void> {
  try {
    const list = JSON.parse(localStorage.getItem(DISCARD_KEY) || '[]') as { name: string; at: number }[];
    const keep: typeof list = [];
    for (const item of list) {
      if (Date.now() - item.at > 60 * 60_000) await discardOpfsRecording(item.name);
      else keep.push(item);
    }
    localStorage.setItem(DISCARD_KEY, JSON.stringify(keep));
  } catch { /* storage unavailable */ }
}

type Target = StudioPrefs['saveTarget'];

/**
 * Silent save for a remembered destination (used after an auto-stop, when
 * there's no click to open a picker). Returns where it went, or null → show
 * the sheet.
 */
export async function autoSave(rec: FinishedRecording, target: Target): Promise<string | null> {
  try {
    if (target === 'download') {
      downloadFile(rec.data, rec.file);
      discardLater(rec.opfsName);
      return 'Downloads';
    }
    if (target === 'drive') {
      // Connected through Google's API: open the sheet, which starts the upload
      // itself (pass autoStart) so its progress and "Open in Drive" are visible —
      // an hour-long master takes a while, and a silent background upload would hide that.
      const api = await getDriveStatus().catch(() => null);
      if (api?.connected && !api.expired) return null;
      const dir = await getDriveFolder();
      const perm = dir && (dir as FileSystemHandle & { queryPermission?: (d: { mode: string }) => Promise<string> }).queryPermission;
      if (dir && perm && (await perm.call(dir, { mode: 'readwrite' })) === 'granted') {
        const where = await saveToFolder(dir, rec.data, rec.file);
        await discardOpfsRecording(rec.opfsName);
        return where;
      }
    }
  } catch {
    /* fall through to the sheet */
  }
  return null;
}

type DriveUp =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'preparing' }
  | { state: 'uploading'; sent: number; total: number; startedAt: number }
  | { state: 'done'; link: string; folderUrl?: string; email?: string }
  | { state: 'error'; code: DriveErrorCode; message: string };

type CloudUp =
  | { state: 'idle' }
  | { state: 'up'; frac: number }
  | { state: 'done' }
  /** The allowance said no — retrying won't help; the free options will. */
  | { state: 'full'; message: string; freesAt: number | null }
  | { state: 'err'; code: CloudCopyErrorCode; message: string };

/** "about 3 min left" — only once there's enough signal to be honest about it. */
export function etaText(sent: number, total: number, elapsedMs: number): string {
  if (sent <= 0 || elapsedMs < 2500) return 'starting…';
  const rate = sent / (elapsedMs / 1000);
  const secs = (total - sent) / Math.max(1, rate);
  if (secs < 45) return 'less than a minute left';
  if (secs < 90 * 60) return `about ${Math.round(secs / 60)} min left`;
  return `about ${(secs / 3600).toFixed(1)} h left`;
}

export function SaveSheet({
  rec,
  hostKey,
  push,
  onClose,
  autoStart = false,
}: {
  rec: FinishedRecording;
  hostKey?: string;
  push: PushToast;
  onClose: () => void;
  /** Start the Drive upload right away when "Google Drive" is the remembered choice and connected. */
  autoStart?: boolean;
}) {
  const [name, setName] = useState(rec.file);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [driveName, setDriveName] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudUp>({ state: 'idle' });
  /** undefined = still asking the server; null = unknown (the server decides at upload). */
  const [quota, setQuota] = useState<CloudCopyQuota | null | undefined>(undefined);
  /** Set in Customize → Recording ("Also keep a 7-day cloud copy") — the host's own choice. */
  const [autoCloud] = useState(() => !!hostKey && loadPrefs().cloudRecordings);
  const [cloudNotice] = useState(() => !!hostKey && cloudCopyNoticePending());
  const autoCloudStarted = useRef(false);
  const copyBytes = rec.data.size || rec.bytes;
  const [gdrive, setGdrive] = useState<DriveUp>({ state: 'idle' });
  const [remember, setRemember] = useState(loadPrefs().saveTarget !== 'ask');
  const phone = isPhoneLike();
  const canShare = canShareFile(rec.data, name);
  const uploadingRef = useRef(false);
  const driveAbort = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);

  const account = useAccount();
  const drive = useDriveStatus(account.status === 'loading' ? null : account.userId);
  // The API route is offered to signed-in users on a server with Google OAuth set up.
  // An unknown status (still loading, or the check failed) still offers it — the save
  // itself tells us if Drive isn't connected.
  const apiOffered =
    account.status !== 'signed_out' && account.status !== 'loading' && (!drive || (drive.signedIn && drive.available));
  const apiConnected = !!drive && drive.connected && !drive.expired && !drive.error;
  const apiNeedsConnect = !!drive && !drive.error && drive.signedIn && drive.available && !drive.connected;
  const apiNeedsReconnect = !!drive && !drive.error && drive.connected && drive.expired;
  const driveActive = gdrive.state === 'connecting' || gdrive.state === 'preparing' || gdrive.state === 'uploading';

  useEffect(() => {
    void getDriveFolder().then((d) => setDriveName(d?.name ?? null));
    return () => driveAbort.current?.abort();
  }, []);

  // The 7-day copy's meter: one read of this account's usage when the sheet opens
  // (an explicit moment, never a timer). Signed out → no copy without signing in.
  useEffect(() => {
    if (!hostKey || account.status === 'loading') return;
    if (account.status === 'signed_out') {
      setQuota(null);
      return;
    }
    let alive = true;
    // With this recording's size: an unfinished earlier try of it isn't counted twice.
    void fetchCloudCopyQuota(rec.eventId, hostKey, copyBytes).then((q) => alive && setQuota(q));
    return () => {
      alive = false;
    };
  }, [hostKey, rec.eventId, account.status, copyBytes]);

  // Nothing uploads to our servers unless the host chose it. Hosts who turned on "Also
  // keep a 7-day cloud copy" get it right away — unless it can't fit, which is said instead.
  useEffect(() => {
    if (!autoCloud || autoCloudStarted.current || quota === undefined) return;
    autoCloudStarted.current = true;
    if (fitsQuota(quota, copyBytes)) toCloud();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCloud, quota]);

  // "Cloud copies are now opt-in" is said once per device.
  useEffect(() => {
    if (cloudNotice) markCloudCopyNoticeSeen();
  }, [cloudNotice]);

  // Remembered "Google Drive" + connected: start uploading as soon as we know.
  useEffect(() => {
    if (!autoStart || autoStarted.current || !apiConnected) return;
    if (loadPrefs().saveTarget !== 'drive') return;
    autoStarted.current = true;
    void runDrive('upload', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, apiConnected]);

  // Closing the tab mid-upload would kill it — ask first.
  useEffect(() => {
    if (!driveActive) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [driveActive]);

  const finish = (where: string, target: Target, deleteNow: boolean, dest: SaveDest = target === 'drive' ? 'drive' : 'device') => {
    setSaved((s) => [...s, where]);
    // This device's Usage card: "Saved to Google Drive 6.2 GB · yours to keep".
    addSave(dest, rec.data.size || rec.bytes);
    addMyRecording({ eventId: rec.eventId, title: rec.title, file: name, bytes: rec.bytes, at: Date.now() });
    if (remember) savePrefs({ ...loadPrefs(), saveTarget: target });
    push(`Saved · ${where}`, { icon: 'check', duration: 3200 });
    // Never pull the disk copy out from under a running cloud upload.
    if (deleteNow && !uploadingRef.current) void discardOpfsRecording(rec.opfsName);
    else discardLater(rec.opfsName);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      push(e instanceof Error ? e.message : 'Saving failed — try another option', { icon: 'alert', duration: 4000 });
    } finally {
      setBusy(null);
    }
  };

  const toPicker = () =>
    run('picker', async () => {
      const where = await saveWithPicker(rec.data, name);
      if (where) finish(where, 'picker', true);
    });

  /* ------------------------------------------- Google Drive (Google's API) */

  async function runDrive(mode: 'upload' | 'connect', popup: Window | null) {
    const ac = new AbortController();
    driveAbort.current = ac;
    setBusy('gdrive');
    let connecting = mode === 'connect';
    try {
      if (connecting) {
        setGdrive({ state: 'connecting' });
        const s = await connectDrive({ popup, signal: ac.signal });
        connecting = false;
        push(`Google Drive connected${s.email ? ` · ${s.email}` : ''}`, { icon: 'check', duration: 3000 });
      }
      setGdrive({ state: 'preparing' });
      const file = await saveRecordingToDrive(rec.data, name, {
        mimeType: rec.mime,
        signal: ac.signal,
        onSession: () => setGdrive({ state: 'uploading', sent: 0, total: rec.data.size, startedAt: Date.now() }),
        onProgress: (sent, total) =>
          setGdrive((g) => (g.state === 'uploading' ? { ...g, sent, total } : { state: 'uploading', sent, total, startedAt: Date.now() })),
      });
      // The connection's email is already known — asking again could wake the backend
      // after a long upload (≤ 1 backend wake per Drive save; ADR 0007 C11).
      const email = peekDriveStatus()?.email ?? drive?.email;
      setGdrive({ state: 'done', link: file.webViewLink, folderUrl: file.folderUrl, email });
      finish(`Google Drive · DreamStream Recordings/${file.name || name}`, 'drive', true);
    } catch (e) {
      const code: DriveErrorCode = e instanceof DriveError ? e.code : 'server';
      if (code === 'aborted') {
        setGdrive({ state: 'idle' });
        push(connecting ? 'Google Drive connection cancelled' : 'Drive upload stopped — the recording is still on this device', { icon: 'info', duration: 3200 });
      } else {
        setGdrive({ state: 'error', code, message: driveErrorMessage(e) });
      }
      if (code === 'not_connected' || code === 'reconnect') void getDriveStatus({ force: true });
    } finally {
      if (driveAbort.current === ac) driveAbort.current = null;
      setBusy(null);
    }
  }

  /** One tap: connect first if needed (the consent window must open inside the tap). */
  const startDrive = (mode: 'upload' | 'connect') => {
    if (mode === 'connect') {
      const popup = openConsentWindow();
      if (!popup) {
        setGdrive({ state: 'error', code: 'popup_blocked', message: driveErrorMessage(new DriveError('popup_blocked')) });
        return;
      }
      void runDrive('connect', popup);
      return;
    }
    void runDrive('upload', null);
  };

  const stopDrive = () => driveAbort.current?.abort();

  /* ------------------------------------- Google Drive without Google's API */

  const toDriveFolder = () =>
    run('drive', async () => {
      if (canPickFolder()) {
        let dir = await getDriveFolder();
        if (!dir) {
          push('Pick your Google Drive folder (e.g. “My Drive” from Google Drive for desktop) — we remember it', { icon: 'info', duration: 5000 });
          dir = await pickDriveFolder();
          if (!dir) return;
          setDriveName(dir.name);
        }
        const where = await saveToFolder(dir, rec.data, name);
        finish(`Google Drive · ${where}`, 'drive', true);
        return;
      }
      if (canShare) {
        const ok = await shareFile(rec.data, name, rec.title);
        if (ok) finish('Shared (choose Drive in the menu)', 'drive', false, 'device');
        return;
      }
      downloadFile(rec.data, name);
      window.open(DRIVE_UPLOAD_URL, '_blank', 'noopener');
      finish('Downloads → drag it into the Drive tab that just opened', 'drive', false, 'device');
    });

  const toDownload = () =>
    run('download', async () => {
      downloadFile(rec.data, name);
      finish('Downloads folder', 'download', false);
    });

  const toShare = () =>
    run('share', async () => {
      const ok = await shareFile(rec.data, name, rec.title);
      if (ok) finish('Shared', 'ask', false);
    });

  const toCloud = () => {
    if (!hostKey || uploadingRef.current) return;
    uploadingRef.current = true;
    setCloud({ state: 'up', frac: 0 });
    uploadRecording(rec.eventId, hostKey, rec.data, {
      file: name,
      durMs: rec.durMs,
      onProgress: (frac) => setCloud({ state: 'up', frac }),
    })
      .then((res) => {
        setCloud({ state: 'done' });
        addSave('cloud', copyBytes);
        // The server counted this copy when it started (in place of any unfinished earlier
        // try of it); fall back to doing the same locally.
        setQuota(
          (q) =>
            res?.quota ??
            (q ? { ...q, usedBytes: q.usedBytes - (q.retryBytes ?? 0) + copyBytes, copies: q.copies + (q.retryBytes ? 0 : 1), retryBytes: undefined } : q),
        );
        push('7-day copy stored — download it from the recap on any device', { icon: 'check' });
        // At 80% and 100% of the 10 GB, say so in the app (ADR 0007 B7) — Drive and this device stay free.
        const now = res?.quota ?? (quota ? { ...quota, usedBytes: quota.usedBytes - (quota.retryBytes ?? 0) + copyBytes } : null);
        const note = now && cloudCopyNotice(allowanceLevel(now.usedBytes, now.limitBytes), now.usedBytes, now.limitBytes);
        if (note) push(note, { icon: 'info', duration: 8000 });
      })
      .catch((e) => {
        if (e instanceof CloudCopyError && e.isLimit) {
          setCloud({ state: 'full', message: e.message, freesAt: e.freesAt });
          const { usedBytes, limitBytes } = e;
          if (usedBytes != null && limitBytes != null) {
            // The server's "used" already leaves out an unfinished try this one would replace.
            setQuota((q) => ({ copies: q?.copies ?? 0, nextFreeAt: q?.nextFreeAt ?? null, usedBytes, limitBytes }));
          }
        } else if (e instanceof CloudCopyError) {
          setCloud({ state: 'err', code: e.code, message: e.message });
        } else {
          setCloud({ state: 'err', code: 'failed', message: 'Upload failed — your recording is still safe on this device.' });
        }
      })
      .finally(() => {
        uploadingRef.current = false;
      });
  };

  /** Leaving mid-upload stops it — confirm, so a stray tap can't lose an hour of uploading. */
  const okToLeave = () => {
    if (!driveActive) return true;
    if (!window.confirm('Stop uploading to Google Drive? The recording stays on this device.')) return false;
    stopDrive();
    return true;
  };

  const keepForLater = () => {
    if (!okToLeave()) return;
    if (!saved.length) push('Kept on this device — find it under “Unsaved recordings” on the dashboard', { icon: 'info', duration: 3600 });
    onClose();
  };

  const discard = () => {
    if (!window.confirm('Delete this recording? This cannot be undone.')) return;
    stopDrive();
    void discardOpfsRecording(rec.opfsName);
    onClose();
  };

  /* ---------------------------------------------------------------- options */

  const folderTitle = driveName ? `Drive for desktop folder · ${driveName}` : 'Save to a Google Drive for desktop folder';
  const fallback = canPickFolder()
    ? {
        title: apiOffered ? folderTitle : driveName ? `Save to Google Drive · ${driveName}` : 'Save to Google Drive',
        sub: driveName
          ? 'Straight into your synced Drive folder on this computer — works offline; Drive uploads it later'
          : 'One-time setup: pick your “My Drive” folder from Google Drive for desktop — works offline',
      }
    : canShare
      ? { title: apiOffered ? 'Send to the Google Drive app' : 'Save to Google Drive', sub: 'Opens your share menu — tap Drive' }
      : { title: apiOffered ? 'Download, then add to Drive' : 'Save to Google Drive', sub: 'Downloads the file and opens drive.google.com so you can drop it in' };

  const driveApiOpt = apiConnected
    ? {
        title: 'Save to Google Drive',
        sub: `Uploads straight to “DreamStream Recordings”${drive?.email ? ` in ${drive.email}` : ''} — resumes if your connection drops`,
        onClick: () => startDrive('upload'),
        note: undefined as string | undefined,
      }
    : apiNeedsReconnect
      ? {
          title: 'Reconnect Google Drive',
          sub: 'Google needs you to sign in again — one tap, then it uploads',
          onClick: () => startDrive('connect'),
          note: DRIVE_PRIVACY_NOTE,
        }
      : apiNeedsConnect
        ? {
            title: 'Connect Google Drive',
            sub: 'One tap to sign in with Google, then this recording uploads straight to your Drive',
            onClick: () => startDrive('connect'),
            note: DRIVE_PRIVACY_NOTE,
          }
        : {
            title: 'Save to Google Drive',
            sub: drive ? 'Uploads straight to your Drive' : 'Checking your Google Drive connection…',
            onClick: () => startDrive('upload'),
            note: undefined,
          };

  const opts: { id: string; icon: string; title: string; sub: string; note?: string; onClick: () => void; show: boolean; primary?: boolean; free: keyof typeof FREE_CHIP }[] = [
    {
      id: 'gdrive',
      icon: 'cloud',
      ...driveApiOpt,
      show: apiOffered,
      primary: apiConnected,
      free: 'drive',
    },
    {
      id: 'picker',
      icon: 'download',
      title: 'Choose where to save…',
      sub: 'Any folder on this computer — Desktop, Videos, an external drive, or your Google Drive folder',
      onClick: toPicker,
      show: canPickSaveLocation(),
      primary: !apiConnected,
      free: 'device',
    },
    {
      id: 'drive',
      icon: apiOffered ? 'download' : 'cloud',
      title: fallback.title,
      sub: fallback.sub,
      onClick: toDriveFolder,
      show: true,
      free: 'drive',
    },
    {
      id: 'share',
      icon: 'share',
      title: 'Share or save to Photos / Files…',
      sub: 'AirDrop, Photos, Files, messaging apps',
      onClick: toShare,
      show: canShare && phone,
      free: 'device',
    },
    {
      id: 'download',
      icon: 'download',
      title: 'Download',
      sub: 'To your browser’s Downloads folder',
      onClick: toDownload,
      show: true,
      free: 'device',
    },
  ];
  const cloudFits = fitsQuota(quota, copyBytes);
  const limitGb = Math.round((quota?.limitBytes ?? 0) / 1024 ** 3);

  const retryable: DriveErrorCode[] = ['network', 'server', 'stalled', 'rate_limited', 'session_expired', 'bad_request'];
  const pct = gdrive.state === 'uploading' && gdrive.total > 0 ? Math.min(100, (gdrive.sent / gdrive.total) * 100) : 0;

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-labelledby="save-title" onClick={(e) => e.target === e.currentTarget && keepForLater()}>
      <div className="sheet fade-in">
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name="record" size={18} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id="save-title" className="sheet-title serif">{saved.length ? 'Saved' : 'Your recording is ready'}</h2>
            <div className="sheet-sub">
              {fmtBytes(rec.bytes)} · {fmtDuration(rec.durMs / 1000)} · {rec.mime.includes('mp4') ? 'MP4' : 'WebM'}
            </div>
          </div>
          <button className="iconbtn" onClick={keepForLater} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>

        <label className="field" style={{ marginBottom: 14 }}>
          <span className="field-label">File name</span>
          <input className="input mono" value={name} disabled={driveActive} onChange={(e) => setName(e.target.value.replace(/[\\/:*?"<>|]/g, '_'))} aria-label="File name" />
        </label>

        {saved.length > 0 && (
          <div className="banner info" style={{ marginBottom: 12 }}>
            <Icon name="check" size={15} />
            <div>{saved.map((s, i) => <div key={i}>{s}</div>)}</div>
          </div>
        )}

        {driveActive && (
          <div className="save-drive" role="status" aria-live="polite">
            <div className="row" style={{ gap: 10 }}>
              <span className="save-opt-icon"><Icon name="cloud" size={18} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>
                  {gdrive.state === 'connecting'
                    ? 'Waiting for Google…'
                    : gdrive.state === 'preparing'
                      ? 'Getting your Drive folder ready…'
                      : `Uploading to Google Drive · ${Math.floor(pct)}%`}
                </b>
                <div className="faint save-drive-sub">
                  {gdrive.state === 'connecting'
                    ? 'Finish signing in in the window that opened — the upload starts right after.'
                    : gdrive.state === 'uploading'
                      ? `${fmtBytes(gdrive.sent)} of ${fmtBytes(gdrive.total)} · ${etaText(gdrive.sent, gdrive.total, Date.now() - gdrive.startedAt)}`
                      : '“DreamStream Recordings” in your Drive'}
                </div>
              </div>
              <Btn variant="subtle" size="sm" onClick={stopDrive}>{gdrive.state === 'connecting' ? 'Cancel' : 'Stop'}</Btn>
            </div>
            {gdrive.state !== 'connecting' && (
              <div style={{ marginTop: 10 }}>
                <Meter value={gdrive.state === 'uploading' ? pct : 2} tone="accent" height={6} />
              </div>
            )}
            {gdrive.state === 'uploading' && <div className="save-drive-hint faint">Keep this tab open until it finishes. If the connection drops, it picks up where it left off.</div>}
          </div>
        )}

        {gdrive.state === 'done' && (
          <div className="save-drive done" role="status">
            <div className="row" style={{ gap: 10 }}>
              <span className="save-opt-icon ok"><Icon name="check" size={18} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>In your Google Drive</b>
                <div className="faint save-drive-sub">DreamStream Recordings{gdrive.email ? ` · ${gdrive.email}` : ''}</div>
              </div>
              <a className="btn btn-soft btn-sm" href={gdrive.link} target="_blank" rel="noopener noreferrer">
                <Icon name="link" size={15} />
                <span>Open in Drive</span>
              </a>
            </div>
          </div>
        )}

        {gdrive.state === 'error' && (
          <div className="banner err save-drive-err" role="alert">
            <Icon name="alert" size={15} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{gdrive.message}</div>
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {(gdrive.code === 'not_connected' || gdrive.code === 'reconnect' || gdrive.code === 'popup_blocked' || gdrive.code === 'consent_closed' || gdrive.code === 'consent_declined') && (
                  <Btn variant="soft" size="sm" icon="cloud" onClick={() => startDrive('connect')}>
                    {gdrive.code === 'reconnect' ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                  </Btn>
                )}
                {retryable.includes(gdrive.code) && (
                  <Btn variant="soft" size="sm" icon="refresh" onClick={() => startDrive('upload')}>Try again</Btn>
                )}
                {gdrive.code === 'quota' && (
                  <a className="btn btn-soft btn-sm" href="https://one.google.com/storage" target="_blank" rel="noopener noreferrer">
                    <span>Manage Drive storage</span>
                  </a>
                )}
                {gdrive.code === 'signed_out' && (
                  <Btn variant="soft" size="sm" onClick={() => openAuth('signin', 'Sign in to save recordings to Google Drive')}>Sign in</Btn>
                )}
                <span className="faint" style={{ fontSize: 12 }}>Or pick another option below — nothing is lost.</span>
              </div>
            </div>
          </div>
        )}

        <div className="save-label">{saved.length ? 'Also save it…' : 'Where should it go?'}</div>
        <div className="save-opts">
          {opts.filter((o) => o.show).map((o) => (
            <button key={o.id} className={cx('save-opt', o.primary && 'primary')} disabled={busy != null} onClick={o.onClick}>
              <span className="save-opt-icon"><Icon name={o.icon} size={18} /></span>
              <span className="save-opt-text">
                <b>{busy === o.id ? 'Saving…' : o.title}</b>
                <small>{o.sub}</small>
                <small className="save-free" style={{ color: 'var(--green)', fontWeight: 600 }}>{FREE_CHIP[o.free]}</small>
                {o.note && (
                  <small className="save-privacy">
                    <Icon name="shield" size={12} />
                    {o.note}
                  </small>
                )}
              </span>
              <Icon name="chevronRight" size={16} className="faint" />
            </button>
          ))}
        </div>
        {account.status === 'signed_out' && drive?.available !== false && (
          <div className="save-hint">
            <button type="button" className="linkish" onClick={() => openAuth('signin', 'Sign in to save recordings straight to Google Drive')}>Sign in</button>
            {' '}to upload recordings straight to Google Drive — no Drive app or folder needed.
          </div>
        )}

        {hostKey && (
          <>
            <div className="save-label" style={{ marginTop: 16 }}>{CLOUD_COPY_HEAD}</div>
            {/* One tip, outside the copy's own box: the copy itself is never called free. */}
            {apiConnected && cloud.state === 'idle' && saved.length === 0 && <div className="save-hint" style={{ marginTop: 0, marginBottom: 6 }}>{CLOUD_COPY_DRIVE_TIP}</div>}
            <section className="save-cloud" aria-label="7-day copy on our servers">
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <Icon name="globe" size={16} className="faint" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>7-day copy · {fmtBytes(copyBytes)}</b>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {cloud.state === 'done'
                      ? `Stored — download it from the recap on any device · ${quotaLine(quota)}`
                      : cloud.state === 'full' || cloud.state === 'err'
                        ? quotaLine(quota)
                        : `A download link for any device, deleted after 7 days. Uses our storage and ${fmtBytes(copyBytes)} of your upload · ${quotaLine(quota)}`}
                  </div>
                </div>
                {cloud.state === 'done' ? (
                  <span className="pill pill-ok">Stored</span>
                ) : cloud.state === 'up' ? (
                  <span className="mono faint" style={{ fontSize: 12 }}>{Math.round(cloud.frac * 100)}%</span>
                ) : cloud.state === 'full' ? null : account.status === 'signed_out' ? (
                  <Btn variant="soft" size="sm" onClick={() => openAuth('signin', 'Sign in to keep a 7-day copy of your recording')}>Sign in</Btn>
                ) : cloudFits ? (
                  <Btn variant="soft" size="sm" icon={cloud.state === 'err' ? 'refresh' : undefined} onClick={toCloud} disabled={quota === undefined}>
                    {cloud.state === 'err' ? 'Try again' : 'Keep a 7-day copy'}
                  </Btn>
                ) : null}
              </div>
              {quota && cloud.state !== 'up' && (
                <div style={{ marginTop: 8 }}>
                  <Meter value={quotaPct(quota)} tone={quotaPct(quota) >= 80 ? 'amber' : 'accent'} height={4} />
                </div>
              )}
              {cloud.state === 'up' && <div style={{ marginTop: 8 }}><Meter value={cloud.frac * 100} tone="accent" height={5} /></div>}
              {(cloud.state === 'idle' || cloud.state === 'err') && cloudFits && !!quota?.retryBytes && (
                <div className="save-hint">
                  {fmtBytes(quota.retryBytes)} of that is an unfinished try of this recording. Starting it again replaces that try, so it isn’t counted twice.
                </div>
              )}
              {cloud.state !== 'full' && cloud.state !== 'done' && cloud.state !== 'up' && !cloudFits && (
                <div className="save-hint" role="status">
                  Your {limitGb} GB of 7-day copies doesn’t have room for this one. Google Drive and this device are free, and the file is yours to keep
                  {quota?.nextFreeAt ? ` — or wait: the oldest copy expires ${fmtFreeDay(quota.nextFreeAt)}` : ''}.
                </div>
              )}
              {cloud.state === 'full' && (
                <div className="save-hint" role="alert">
                  {cloud.message}
                  {cloud.freesAt ? ` Space frees up ${fmtFreeDay(cloud.freesAt)}.` : ''}
                </div>
              )}
              {cloud.state === 'err' && (
                <div className="save-hint" role="alert">
                  {cloud.message}
                  {cloud.code === 'sign_in_required' && (
                    <>
                      {' '}
                      <button type="button" className="linkish" onClick={() => openAuth('signin', 'Sign in to keep a 7-day copy of your recording')}>Sign in</button>
                    </>
                  )}
                </div>
              )}
              {autoCloud && (cloud.state === 'up' || cloud.state === 'done') && (
                <div className="save-hint">Started because “Also keep a 7-day cloud copy” is on in Customize → Recording.</div>
              )}
              {cloudNotice && !autoCloud && cloud.state === 'idle' && (
                <div className="save-hint">7-day copies are now made only when you choose one. To copy every recording again, turn it on in Customize → Recording.</div>
              )}
            </section>
          </>
        )}

        <label className="save-remember">
          <input type="checkbox" checked={remember} onChange={(e) => {
            setRemember(e.target.checked);
            if (!e.target.checked) savePrefs({ ...loadPrefs(), saveTarget: 'ask' });
          }} />
          Remember my choice for next time (change it in Customize → Recording)
        </label>

        <div className="sheet-foot">
          {saved.length === 0 ? (
            <>
              <Btn variant="subtle" icon="trash" onClick={discard}>Discard</Btn>
              <span className="spacer" />
              <Btn variant="ghost" onClick={keepForLater}>Decide later</Btn>
            </>
          ) : (
            <>
              <span className="spacer" />
              <Btn variant="solid" icon="check" onClick={keepForLater}>Done</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
