/**
 * Where a finished recording goes — the user picks, every time (or a
 * remembered default).
 *
 * Google Drive WITHOUT Google OAuth:
 *  - Desktop (Chrome/Edge): Google Drive for desktop mounts "My Drive" as a
 *    normal folder. The File System Access API lets the user pick that folder
 *    ONCE; we remember the handle (IndexedDB) and later saves write straight
 *    into it — Drive syncs it to the cloud. No Google sign-in in our app.
 *  - Phones: the OS share sheet hands the file to the Google Drive app
 *    ("Save to Drive" on Android, "Drive" on iOS) — again no OAuth here.
 *  - Anything else: download + open drive.google.com to drop it in.
 *
 * Everything streams from the (disk-backed) Blob, so multi-GB files never get
 * copied into memory.
 */

type SaveFilePickerOpts = {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
  id?: string;
  startIn?: string | FileSystemHandle;
};

type PickerWindow = Window & {
  showSaveFilePicker?: (o?: SaveFilePickerOpts) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
};

type PermHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

const w = (): PickerWindow | null => (typeof window === 'undefined' ? null : (window as PickerWindow));

export const canPickSaveLocation = (): boolean => typeof w()?.showSaveFilePicker === 'function';
export const canPickFolder = (): boolean => typeof w()?.showDirectoryPicker === 'function';

export function canShareFile(blob: Blob, name: string): boolean {
  try {
    const file = new File([blob], name, { type: blob.type });
    return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

export const isPhoneLike = (): boolean =>
  typeof navigator !== 'undefined' && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

const extOf = (name: string) => (name.split('.').pop() || 'webm').toLowerCase();

/** Desktop "Save as…" — the user chooses any folder (incl. their Drive folder). */
export async function saveWithPicker(blob: Blob, suggestedName: string): Promise<string | null> {
  const picker = w()?.showSaveFilePicker;
  if (!picker) return null;
  const ext = extOf(suggestedName);
  try {
    const handle = await picker({
      suggestedName,
      id: 'ds-recordings',
      startIn: 'videos',
      types: [{ description: ext === 'mp4' ? 'MP4 video' : 'WebM video', accept: { [ext === 'mp4' ? 'video/mp4' : 'video/webm']: [`.${ext}`] } }],
    });
    await writeTo(handle, blob);
    return handle.name;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null; // user cancelled
    throw e;
  }
}

async function writeTo(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  try {
    await blob.stream().pipeTo(writable as unknown as WritableStream<Uint8Array>);
  } catch (e) {
    try {
      await writable.abort();
    } catch { /* closed */ }
    throw e;
  }
}

/* ----------------------------------------------- remembered Drive folder */

const DB = 'ds-live-save';
const STORE = 'handles';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

export async function getDriveFolder(): Promise<FileSystemDirectoryHandle | null> {
  return ((await idb('readonly', (s) => s.get('drive'))) as FileSystemDirectoryHandle | undefined) ?? null;
}

export async function forgetDriveFolder(): Promise<void> {
  await idb('readwrite', (s) => s.delete('drive'));
}

/** Ask once for the Google Drive (desktop) folder and remember it. */
export async function pickDriveFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = w()?.showDirectoryPicker;
  if (!picker) return null;
  try {
    const dir = await picker({ id: 'ds-drive', mode: 'readwrite', startIn: 'documents' });
    await idb('readwrite', (s) => s.put(dir, 'drive'));
    return dir;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}

/** Heuristic for UI copy only — users can pick any folder. */
export const looksLikeDrive = (dir: FileSystemDirectoryHandle | null): boolean =>
  !!dir && /drive/i.test(dir.name);

async function ensureWritable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const h = dir as PermHandle;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

/** Save into the remembered folder (inside a "DreamStream Recordings" subfolder). */
export async function saveToFolder(dir: FileSystemDirectoryHandle, blob: Blob, name: string): Promise<string> {
  if (!(await ensureWritable(dir))) throw new Error('Folder permission was not granted.');
  const sub = await dir.getDirectoryHandle('DreamStream Recordings', { create: true });
  const fh = await sub.getFileHandle(await uniqueName(sub, name), { create: true });
  await writeTo(fh, blob);
  return `${dir.name}/DreamStream Recordings/${fh.name}`;
}

async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

/* ------------------------------------------------------------ fallbacks */

export async function shareFile(blob: Blob, name: string, title: string): Promise<boolean> {
  try {
    const file = new File([blob], name, { type: blob.type });
    await navigator.share({ files: [file], title });
    return true;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return false;
    throw e;
  }
}

export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for multi-GB disk-backed blobs to start streaming.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export const DRIVE_UPLOAD_URL = 'https://drive.google.com/drive/my-drive';
