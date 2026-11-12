/**
 * Disk-backed local recording.
 *
 * The old LocalRecorder kept every chunk in RAM and built one giant Blob at
 * the end — a one-hour 720p master at 2.5× bitrate is ~2.8 GB, which made
 * long streams stutter and could crash the tab (taking the stream with it).
 *
 * Now chunks stream into the Origin Private File System from a worker using a
 * SyncAccessHandle (Chrome 102+, Safari 15.2+, Firefox 111+): flat memory, and
 * the data is on disk as it's recorded, so a crash or accidental close leaves
 * a recoverable file. Browsers without OPFS fall back to the in-memory path.
 */

import { deviceOwner } from './accountPurge';

const UNSAVED_KEY = 'ds-live-unsaved-recordings';
const PREFIX = 'ds-rec-';

export interface UnsavedRecording {
  name: string;
  file: string;
  mime: string;
  eventId: string;
  title: string;
  at: number;
  durMs: number;
  bytes: number;
  /**
   * The Stream Studio account the studio that recorded it was opened for (null: no account was
   * signed in on this device then). Signing out leaves unsaved recordings on the device (they are
   * the host's work), so a recording with an owner is offered only to that account: never the next
   * person who signs in here. One with no owner is offered to whoever opens Stream Studio here
   * (unsavedRecordingsOf). Missing on an entry an earlier version of Stream Studio wrote: that version
   * recorded no account, and none is ever guessed for it (it counts as no account's, null).
   * UNKNOWN_OWNER: a recording listed again whose account can't be told, offered to no one
   * (sweepOrphanRecordings). The owner is also recorded apart from this list (RECORDING_OWNERS_KEY),
   * and that record is the one that counts (ownerOf).
   */
  owner?: string | null;
}

export interface FinishedRecording {
  /** Disk-backed File (OPFS) or in-memory Blob — both stream without copying. */
  data: Blob;
  file: string;
  mime: string;
  bytes: number;
  durMs: number;
  /** OPFS entry name — delete it once the user has saved the file. */
  opfsName: string | null;
  eventId: string;
  title: string;
}

const WORKER_SRC = `
let handle = null, offset = 0, writes = 0;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.op === 'open') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
      postMessage({ op: 'opened' });
    } else if (m.op === 'write') {
      offset += handle.write(new Uint8Array(m.buf), { at: offset });
      if (++writes % 5 === 0) handle.flush();
      postMessage({ op: 'wrote', bytes: offset });
    } else if (m.op === 'close') {
      if (handle) { handle.flush(); handle.close(); handle = null; }
      postMessage({ op: 'closed', bytes: offset });
    }
  } catch (err) {
    postMessage({ op: 'error', msg: String(err && err.message || err) });
  }
};
`;

/**
 * Whether this page can try the disk path. Not whether a sync access handle exists: createSyncAccessHandle is exposed
 * only in dedicated workers, never on a page's FileSystemFileHandle, so a check for it here is false in every browser.
 * The worker finds out (it posts 'error' when it can't open one), and the recording falls back to memory.
 */
export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof Worker !== 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

/** One-shot worker round trip helper. */
class OpfsSink {
  private worker: Worker;
  private waiters: ((m: { op: string; bytes?: number; msg?: string }) => void)[] = [];
  failed = false;
  bytes = 0;

  constructor(readonly name: string) {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);
    this.worker.onmessage = (e) => {
      const m = e.data as { op: string; bytes?: number; msg?: string };
      if (m.op === 'error') this.failed = true;
      if (typeof m.bytes === 'number') this.bytes = m.bytes;
      if (m.op === 'opened' || m.op === 'closed' || m.op === 'error') this.waiters.shift()?.(m);
    };
  }

  open(): Promise<boolean> {
    return new Promise((res) => {
      this.waiters.push((m) => res(m.op === 'opened'));
      this.worker.postMessage({ op: 'open', name: this.name });
    });
  }

  write(buf: ArrayBuffer): void {
    this.worker.postMessage({ op: 'write', buf }, [buf]);
  }

  close(): Promise<void> {
    return new Promise((res) => {
      this.waiters.push(() => res());
      this.worker.postMessage({ op: 'close' });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export class DiskRecorder {
  private rec: MediaRecorder;
  private sink: OpfsSink | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private writeChain: Promise<void> = Promise.resolve();
  bytes = 0;
  readonly onDisk: boolean;

  private constructor(
    stream: MediaStream,
    readonly mime: string,
    videoBps: number,
    readonly file: string,
    private meta: { eventId: string; title: string },
    sink: OpfsSink | null,
    private readonly owner: string | null,
  ) {
    this.sink = sink;
    this.onDisk = !!sink;
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBps, audioBitsPerSecond: 192_000 });
    this.rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.bytes += e.data.size;
      if (this.sink && !this.sink.failed) {
        const sink = this.sink;
        const blob = e.data;
        // Serialize: chunks must land in order even though arrayBuffer() is async.
        this.writeChain = this.writeChain.then(async () => sink.write(await blob.arrayBuffer()));
      } else {
        this.chunks.push(e.data);
      }
      this.touchUnsaved();
    };
  }

  /**
   * Opens the disk sink (when available) and starts recording. `owner`: the account the studio was
   * opened for (StudioView passes it), not whoever owns the device when Record is pressed: a sign-out
   * in another tab clears the device's owner while the stream keeps going, and a part recorded after
   * that must still be offered to the host.
   */
  static async start(
    stream: MediaStream,
    mime: string,
    videoBps: number,
    file: string,
    meta: { eventId: string; title: string },
    owner: string | null = deviceOwner(),
  ): Promise<DiskRecorder> {
    let sink: OpfsSink | null = null;
    if (opfsSupported()) {
      try {
        void navigator.storage.persist?.().catch(() => undefined);
        const s = new OpfsSink(`${PREFIX}${Date.now()}-${file.replace(/[^\w.-]/g, '_')}`);
        if (await s.open()) sink = s;
        else s.terminate();
      } catch {
        sink = null;
      }
    }
    const r = new DiskRecorder(stream, mime, videoBps, file, meta, sink, owner);
    r.startedAt = Date.now();
    r.rec.start(1000);
    r.touchUnsaved();
    return r;
  }

  get state(): RecordingState {
    return this.rec.state;
  }

  /** Recorded time, excluding pauses. */
  get elapsedMs(): number {
    if (!this.startedAt) return 0;
    const now = this.pausedAt ?? Date.now();
    return Math.max(0, now - this.startedAt - this.pausedTotal);
  }

  pause(): void {
    if (this.rec.state === 'recording') {
      this.rec.pause();
      this.pausedAt = Date.now();
    }
  }

  resume(): void {
    if (this.rec.state === 'paused') {
      this.rec.resume();
      if (this.pausedAt) this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }

  async stop(): Promise<FinishedRecording> {
    const durMs = this.elapsedMs;
    await new Promise<void>((resolve) => {
      this.rec.addEventListener('stop', () => resolve(), { once: true });
      if (this.rec.state !== 'inactive') this.rec.stop();
      else resolve();
    });
    // The final dataavailable fires before 'stop'; let its write finish.
    await this.writeChain;
    let data: Blob;
    let opfsName: string | null = null;
    if (this.sink) {
      await this.sink.close();
      this.sink.terminate();
      opfsName = this.sink.name;
      try {
        const onDisk = await readOpfsFile(opfsName, this.mime);
        // If the disk sink failed mid-way, the tail went to memory — join them.
        data = this.chunks.length ? new Blob([onDisk, ...this.chunks], { type: this.mime }) : onDisk;
      } catch {
        data = new Blob(this.chunks, { type: this.mime });
        removeUnsaved(opfsName);
        opfsName = null;
      }
      if (opfsName) updateUnsaved(opfsName, { durMs, bytes: data.size });
    } else {
      data = new Blob(this.chunks, { type: this.mime });
    }
    this.chunks = [];
    return { data, file: this.file, mime: this.mime, bytes: data.size, durMs, opfsName, eventId: this.meta.eventId, title: this.meta.title };
  }

  private lastTouch = 0;
  private touchUnsaved(): void {
    if (!this.sink) return;
    const now = Date.now();
    if (now - this.lastTouch < 5000 && this.bytes > 0) return;
    this.lastTouch = now;
    upsertUnsaved({
      name: this.sink.name,
      file: this.file,
      mime: this.mime,
      eventId: this.meta.eventId,
      title: this.meta.title,
      at: this.startedAt || now,
      durMs: this.elapsedMs,
      bytes: this.bytes,
      owner: this.owner,
    });
  }
}

async function readOpfsFile(name: string, mime: string): Promise<Blob> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name);
  const f = await fh.getFile();
  // Re-type so downloads/shares get the right container.
  return f.type === mime ? f : new File([f], f.name, { type: mime });
}

/* ------------------------------------------------------ unsaved registry */

/**
 * Who made each unsaved recording, by its disk name ({name: account or null}), kept apart from the
 * registry: written with every entry this version adds, and the first record of a name is the one
 * kept. A Stream Studio tab still running an earlier version never touches it, though it drops
 * registry entries (it kept only the 10 newest) and rewrites its own entry with no owner every few
 * seconds while it records; so a recording that loses its entry that way, or to a registry write that
 * failed, is listed again for the account it was made for, and an entry rewritten that way keeps its
 * owner (ownerOf). Never purged: the recordings it describes stay too.
 */
export const RECORDING_OWNERS_KEY = 'ds-live-rec-owners';

/**
 * The owner of an unsaved recording whose account can't be told: a disk copy no list names and no
 * record says who made it (an earlier version made it and stopped listing it before this version saw
 * it listed, or the records couldn't be written). It is offered to no one; anyone here sees it
 * counted, with its size, and can delete it (orphanUnsaved, discardOrphanUnsaved).
 */
export const UNKNOWN_OWNER = '?unknown';

type Owner = string | null;
const isOwner = (v: unknown): v is Owner => v === null || typeof v === 'string';
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** RECORDING_OWNERS_KEY as stored ({} when absent), or null when it can't be read. */
export function readRecordingOwners(): Record<string, Owner> | null {
  try {
    const raw = localStorage.getItem(RECORDING_OWNERS_KEY);
    const map = raw ? (JSON.parse(raw) as unknown) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, Owner>) : null;
  } catch {
    return null;
  }
}

function writeRecordingOwners(map: Record<string, Owner>): void {
  try {
    localStorage.setItem(RECORDING_OWNERS_KEY, JSON.stringify(map));
  } catch { /* storage unavailable */ }
}

/** Remember who made the recording on disk as `name`; a record already there is kept (it was first). */
function noteRecordingOwner(name: string, owner: Owner): void {
  const map = readRecordingOwners();
  if (!map || hasOwn(map, name)) return;
  writeRecordingOwners({ ...map, [name]: owner });
}

/** Forget the owners of recordings whose disk copies are gone. */
function forgetRecordingOwners(names: Iterable<string>): void {
  const map = readRecordingOwners();
  if (!map) return;
  let changed = false;
  for (const name of names) {
    if (hasOwn(map, name)) {
      delete map[name];
      changed = true;
    }
  }
  if (changed) writeRecordingOwners(map);
}

/**
 * Who `r` is for: the owner recorded apart from the list (the first record of it), else the entry's
 * own, else no account (null: an entry an earlier version wrote, which carries none). Never the
 * device's owner: nothing tells whose an earlier version's recording is (that version's sign-out left
 * its recordings for whoever signed in next, and offered them to everyone).
 */
function ownerOf(r: UnsavedRecording, owners: Record<string, Owner> | null): Owner {
  if (owners && hasOwn(owners, r.name) && isOwner(owners[r.name])) return owners[r.name];
  return isOwner(r.owner) ? r.owner : null;
}

/**
 * Record, apart from the list, the owner of every listed entry that has no record yet: its own, or no
 * account (null) for an entry an earlier version wrote. So a recording that version still listed
 * stays offered to anyone here, as that version offered it, once that version's tab drops it from
 * the list, and one whose record failed to write when it was added keeps its account. The start-up
 * sweep runs it before it reads the disk.
 */
export function recordListedOwners(): void {
  const list = readUnsavedOrNull();
  const owners = list && readRecordingOwners();
  if (!list || !owners) return;
  let added = false;
  for (const r of list) {
    if (!r || typeof r.name !== 'string' || hasOwn(owners, r.name)) continue;
    owners[r.name] = isOwner(r.owner) ? r.owner : null;
    added = true;
  }
  if (added) writeRecordingOwners(owners);
}

/** The registry as stored, or null when it can't be read (storage blocked, not JSON, not a list). */
function readUnsavedOrNull(): UnsavedRecording[] | null {
  try {
    const raw = localStorage.getItem(UNSAVED_KEY);
    const arr = raw ? (JSON.parse(raw) as UnsavedRecording[]) : [];
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function readUnsaved(): UnsavedRecording[] {
  return readUnsavedOrNull() ?? [];
}

/**
 * Every entry stays until its recording is saved or discarded, or its file is gone: no cap on the
 * count, since an entry pushed off the list would leave its file on disk with nothing that names it
 * (the browser's quota, and the studio's low-storage warning, bound the files themselves).
 */
function writeUnsaved(list: UnsavedRecording[]): void {
  try {
    localStorage.setItem(UNSAVED_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Add or replace an entry. Its owner is recorded first, apart from the list (noteRecordingOwner), so a
 * file whose entry is lost (a write here that fails, or a tab still running an earlier version that
 * drops entries) is listed again for the same account.
 */
function upsertUnsaved(r: UnsavedRecording): void {
  if (r.owner !== undefined) noteRecordingOwner(r.name, r.owner);
  writeUnsaved([...readUnsaved().filter((x) => x.name !== r.name), r]);
}

function updateUnsaved(name: string, patch: Partial<UnsavedRecording>): void {
  writeUnsaved(readUnsaved().map((x) => (x.name === name ? { ...x, ...patch } : x)));
}

export function removeUnsaved(name: string): void {
  writeUnsaved(readUnsaved().filter((x) => x.name !== name));
}

/** The registry's entries with who each is for (ownerOf). */
const withOwners = (): Array<{ r: UnsavedRecording; owner: Owner }> => {
  const owners = readRecordingOwners();
  return readUnsaved()
    .filter((r) => !!r && typeof r === 'object' && typeof r.name === 'string')
    .map((r) => ({ r, owner: ownerOf(r, owners) }));
};

/**
 * The unsaved recordings `owner` may be offered: the ones recorded for that account, and the ones no
 * account made (recorded with no one signed in here, or by an earlier version of Stream Studio, which
 * offered every one to whoever opened it here). One whose account can't be told (UNKNOWN_OWNER) is
 * offered to no one.
 */
export function unsavedRecordingsOf(owner: string | null): UnsavedRecording[] {
  return withOwners()
    .filter((x) => x.owner === null || (x.owner === owner && owner !== UNKNOWN_OWNER))
    .map((x) => x.r);
}

/**
 * Recordings that reached disk but were never saved (crash, closed tab, dismissed sheet) and that
 * the account signed in on this device now may be offered (unsavedRecordingsOf). The studio passes
 * the account it was opened for instead.
 */
export async function listUnsavedRecordings(owner: string | null = deviceOwner()): Promise<UnsavedRecording[]> {
  const list = unsavedRecordingsOf(owner);
  if (!list.length || !opfsSupported()) return [];
  const out: UnsavedRecording[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    for (const r of list) {
      try {
        const f = await (await root.getFileHandle(r.name)).getFile();
        if (f.size > 0) out.push({ ...r, bytes: f.size });
        else removeUnsaved(r.name);
      } catch {
        removeUnsaved(r.name);
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function openUnsavedRecording(r: UnsavedRecording): Promise<FinishedRecording> {
  const data = await readOpfsFile(r.name, r.mime);
  return { data, file: r.file, mime: r.mime, bytes: data.size, durMs: r.durMs, opfsName: r.name, eventId: r.eventId, title: r.title };
}

/**
 * Free the disk copy once the user saved it somewhere (or discarded it). Its entry goes only once the
 * file is gone: a file that can't be deleted keeps its entry (its title and owner), so it is never
 * left on disk with nothing that names it. Returns whether the file is gone.
 */
export async function discardOpfsRecording(name: string | null): Promise<boolean> {
  if (!name) return true;
  let gone: boolean;
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    gone = true; // no private file storage in this browser, so nothing of it on disk
  } else {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name);
      gone = true;
    } catch (err) {
      gone = (err as { name?: string } | null)?.name === 'NotFoundError';
    }
  }
  if (gone) {
    removeUnsaved(name);
    forgetRecordingOwners([name]);
  }
  return gone;
}

/**
 * Unsaved recordings on this device that other signed-in accounts made: how many, and how much space they take (as
 * last recorded); never their titles or events. Only those accounts can open or delete them.
 */
export function otherAccountsUnsaved(owner: string | null = deviceOwner()): { count: number; bytes: number } {
  const others = withOwners().filter((x) => x.owner !== null && x.owner !== UNKNOWN_OWNER && x.owner !== owner);
  return { count: others.length, bytes: others.reduce((sum, x) => sum + (Number(x.r.bytes) || 0), 0) };
}

/** Unsaved recordings offered to no one (UNKNOWN_OWNER): their names, for the delete anyone here may confirm, and their size. */
export function orphanUnsaved(): { names: string[]; bytes: number } {
  const orphans = withOwners().filter((x) => x.owner === UNKNOWN_OWNER).map((x) => x.r);
  return { names: orphans.map((r) => r.name), bytes: orphans.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0) };
}

/** Deletes the confirmed names that are still offered to no one (never one that has an owner by then). Returns how many went. */
export async function discardOrphanUnsaved(names: readonly string[]): Promise<number> {
  const still = new Set(orphanUnsaved().names);
  let n = 0;
  for (const name of names) if (still.has(name) && (await discardOpfsRecording(name))) n++;
  return n;
}

/** A disk copy no list names is left alone until nothing has written it for this long. */
const ORPHAN_AFTER_MS = 60 * 60_000;

/** `ds-rec-<ms>-<file>`: DiskRecorder.start's name, and StudioView's file name in it (media.ts recordingFilename). */
const DISK_NAME = /^ds-rec-(\d{10,})-(.+)$/;
const FILE_NAME = /^streamstudio-(.+)-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(?:-part\d+)?\.(webm|mp4)$/;

/**
 * An entry for a disk copy no list names, rebuilt from its name (when it started, the event, the file
 * name) and the file (its size; its last write, for a duration). Its owner is the one recorded for it
 * apart from the lists, else UNKNOWN_OWNER: never whoever holds the device when the sweep runs.
 */
function recoveredEntry(name: string, f: File): UnsavedRecording {
  const owners = readRecordingOwners();
  const m = DISK_NAME.exec(name);
  const file = m ? m[2] : name.slice(PREFIX.length) || name;
  const at = m ? Number(m[1]) : f.lastModified;
  const parts = FILE_NAME.exec(file);
  const ext = parts?.[2] ?? (/\.mp4$/i.test(file) ? 'mp4' : 'webm');
  return {
    name,
    file,
    mime: `video/${ext}`,
    eventId: parts?.[1] ?? '',
    title: 'Recovered recording',
    at,
    durMs: Math.max(0, f.lastModified - at),
    bytes: f.size,
    owner: owners && hasOwn(owners, name) && isOwner(owners[name]) ? owners[name] : UNKNOWN_OWNER,
  };
}

/**
 * Run on app start (SaveSheet's sweepDiscardedRecordings calls it). A disk copy no list names is
 * listed again, never deleted: it is a recording someone kept (the registry once held only the 10
 * newest and dropped the rest without their files, and a tab still running that version keeps doing
 * so), or one left by a crash or a disk copy that couldn't be read back. Only an empty file is
 * deleted. `discardLater` reads the names SaveSheet still holds to delete itself (after a download had
 * time to read them); those are left to it. Both lists are read after the disk is enumerated, and
 * again right before each file is touched, so a name moving from one list to the other in another
 * tab meanwhile is always seen (SaveSheet's discardLater adds to its list before it leaves the
 * registry). A file written in the last hour is left alone (another tab may be recording into it),
 * and when either list can't be read nothing is touched. Entries whose disk copy is gone are dropped,
 * and so are their recorded owners. A recording listed again goes to its own account, or to none
 * (recoveredEntry); the owners of the listed entries are recorded first (recordListedOwners).
 */
export async function sweepOrphanRecordings(discardLater: () => readonly string[] | null = () => []): Promise<void> {
  if (!opfsSupported()) return;
  recordListedOwners();
  try {
    const root = await navigator.storage.getDirectory();
    const names = (root as unknown as { keys?: () => AsyncIterable<string> }).keys?.();
    if (!names) return;
    // The registry and the recorded owners as they were before the disk is read, to tell which lost
    // their disk copy: a recording another tab starts meanwhile is on disk but not in this read, so
    // it is never taken for a missing one.
    const before = readUnsavedOrNull();
    const ownersBefore = readRecordingOwners();
    if (!before) return;
    const onDisk = new Set<string>();
    for await (const name of names) if (name.startsWith(PREFIX)) onDisk.add(name);
    /** Every name either list holds now, or null when one can't be read. */
    const namedNow = (): Set<string> | null => {
      const listed = readUnsavedOrNull();
      const waiting = listed && discardLater();
      return listed && waiting ? new Set([...listed.map((r) => r.name), ...waiting]) : null;
    };
    const named = namedNow();
    if (!named) return;
    for (const r of before) named.add(r.name);
    for (const name of onDisk) {
      if (named.has(name)) continue;
      try {
        const f = await (await root.getFileHandle(name)).getFile();
        if (Date.now() - f.lastModified <= ORPHAN_AFTER_MS) continue;
        const current = namedNow();
        if (!current || current.has(name)) continue;
        if (f.size === 0) await root.removeEntry(name);
        else upsertUnsaved(recoveredEntry(name, f));
      } catch {
        /* in use (another tab is recording into it), unreadable or already gone: left as it is */
      }
    }
    // Entries whose disk copy is gone (whoever made them) are dropped, re-reading the list so an
    // entry another tab added meanwhile stays.
    if (before.some((r) => !onDisk.has(r.name))) {
      const gone = new Set(before.filter((r) => !onDisk.has(r.name)).map((r) => r.name));
      writeUnsaved(readUnsaved().filter((r) => !gone.has(r.name)));
    }
    if (ownersBefore) forgetRecordingOwners(Object.keys(ownersBefore).filter((name) => !onDisk.has(name)));
  } catch {
    /* storage unavailable */
  }
}

/** Free space check before a long recording. */
export async function freeSpaceBytes(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota == null || est.usage == null) return null;
    return Math.max(0, est.quota - est.usage);
  } catch {
    return null;
  }
}
