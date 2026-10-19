// "Your recording is ready — where should it go?"
// Replaces the old silent auto-download (which dumped multi-GB files into
// Downloads mid-stream and stalled the tab). Every option streams from the
// disk-backed recording, so even hour-long masters save without a RAM spike.
import React, { useEffect, useRef, useState } from 'react';
import { uploadRecording } from '../api';
import { addMyRecording } from '../events';
import { fmtBytes, fmtDuration } from '../metrics';
import { loadPrefs, savePrefs, type StudioPrefs } from '../prefs';
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

export function SaveSheet({
  rec,
  hostKey,
  push,
  onClose,
}: {
  rec: FinishedRecording;
  hostKey?: string;
  push: PushToast;
  onClose: () => void;
}) {
  const [name, setName] = useState(rec.file);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [driveName, setDriveName] = useState<string | null>(null);
  const [cloud, setCloud] = useState<{ state: 'idle' | 'up' | 'done' | 'err'; frac: number }>({ state: 'idle', frac: 0 });
  const [remember, setRemember] = useState(loadPrefs().saveTarget !== 'ask');
  const phone = isPhoneLike();
  const canShare = canShareFile(rec.data, name);
  const uploadingRef = useRef(false);

  useEffect(() => {
    void getDriveFolder().then((d) => setDriveName(d?.name ?? null));
    // "Keep a cloud copy" preference: start the 7-day upload right away.
    if (hostKey && loadPrefs().cloudRecordings) toCloud();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (where: string, target: Target, deleteNow: boolean) => {
    setSaved((s) => [...s, where]);
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

  const toDrive = () =>
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
        if (ok) finish('Shared (choose Drive in the menu)', 'drive', false);
        return;
      }
      downloadFile(rec.data, name);
      window.open(DRIVE_UPLOAD_URL, '_blank', 'noopener');
      finish('Downloads → drag it into the Drive tab that just opened', 'drive', false);
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
      .then(() => {
        setCloud({ state: 'done', frac: 1 });
        push('Cloud copy stored — downloadable from the recap for 7 days', { icon: 'check' });
      })
      .catch(() => setCloud({ state: 'err', frac: 0 }))
      .finally(() => {
        uploadingRef.current = false;
      });
  };

  const keepForLater = () => {
    push('Kept on this device — find it under “Unsaved recordings” on the dashboard', { icon: 'info', duration: 3600 });
    onClose();
  };

  const discard = () => {
    if (!window.confirm('Delete this recording? This cannot be undone.')) return;
    void discardOpfsRecording(rec.opfsName);
    onClose();
  };

  const opts: { id: string; icon: string; title: string; sub: string; onClick: () => void; show: boolean; primary?: boolean }[] = [
    {
      id: 'picker',
      icon: 'download',
      title: 'Choose where to save…',
      sub: 'Any folder on this computer — Desktop, Videos, an external drive, or your Google Drive folder',
      onClick: toPicker,
      show: canPickSaveLocation(),
      primary: true,
    },
    {
      id: 'drive',
      icon: 'cloud',
      title: driveName ? `Save to Google Drive · ${driveName}` : 'Save to Google Drive',
      sub: canPickFolder()
        ? driveName
          ? 'Straight into your synced Drive folder — no Google sign-in needed here'
          : 'One-time setup: pick your Drive folder (Google Drive for desktop). No Google sign-in needed here'
        : canShare
          ? 'Opens your share menu — tap Drive. No Google sign-in needed here'
          : 'Downloads the file and opens Drive so you can drop it in',
      onClick: toDrive,
      show: true,
    },
    {
      id: 'share',
      icon: 'share',
      title: 'Share or save to Photos / Files…',
      sub: 'AirDrop, Photos, Files, messaging apps',
      onClick: toShare,
      show: canShare && phone,
    },
    {
      id: 'download',
      icon: 'download',
      title: 'Download',
      sub: 'To your browser’s Downloads folder',
      onClick: toDownload,
      show: true,
    },
  ];

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
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value.replace(/[\\/:*?"<>|]/g, '_'))} aria-label="File name" />
        </label>

        {saved.length > 0 && (
          <div className="banner info" style={{ marginBottom: 12 }}>
            <Icon name="check" size={15} />
            <div>{saved.map((s, i) => <div key={i}>{s}</div>)}</div>
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
              </span>
              <Icon name="chevronRight" size={16} className="faint" />
            </button>
          ))}
        </div>

        {hostKey && (
          <div className="save-cloud">
            <div className="row" style={{ gap: 10 }}>
              <Icon name="globe" size={16} className="faint" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>7-day cloud copy</b>
                <div className="faint" style={{ fontSize: 12 }}>
                  {cloud.state === 'done' ? 'Stored — download it from the recap on any device.' : cloud.state === 'err' ? 'Upload failed — your device copy is safe.' : 'Grab it later from any device; auto-deleted after 7 days.'}
                </div>
              </div>
              {cloud.state === 'idle' || cloud.state === 'err' ? (
                <Btn variant="soft" size="sm" icon="refresh" onClick={toCloud}>{cloud.state === 'err' ? 'Retry' : 'Upload'}</Btn>
              ) : cloud.state === 'done' ? (
                <span className="pill pill-ok">Done</span>
              ) : (
                <span className="mono faint" style={{ fontSize: 12 }}>{Math.round(cloud.frac * 100)}%</span>
              )}
            </div>
            {cloud.state === 'up' && <div style={{ marginTop: 8 }}><Meter value={cloud.frac * 100} tone="accent" height={5} /></div>}
          </div>
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
              <Btn variant="solid" icon="check" onClick={onClose}>Done</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
