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

export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof Worker !== 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createSyncAccessHandle' in FileSystemFileHandle.prototype
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

  /** Opens the disk sink (when available) and starts recording. */
  static async start(
    stream: MediaStream,
    mime: string,
    videoBps: number,
    file: string,
    meta: { eventId: string; title: string },
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
    const r = new DiskRecorder(stream, mime, videoBps, file, meta, sink);
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

function readUnsaved(): UnsavedRecording[] {
  try {
    const raw = localStorage.getItem(UNSAVED_KEY);
    const arr = raw ? (JSON.parse(raw) as UnsavedRecording[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeUnsaved(list: UnsavedRecording[]): void {
  try {
    localStorage.setItem(UNSAVED_KEY, JSON.stringify(list.slice(-10)));
  } catch {
    /* storage unavailable */
  }
}

function upsertUnsaved(r: UnsavedRecording): void {
  writeUnsaved([...readUnsaved().filter((x) => x.name !== r.name), r]);
}

function updateUnsaved(name: string, patch: Partial<UnsavedRecording>): void {
  writeUnsaved(readUnsaved().map((x) => (x.name === name ? { ...x, ...patch } : x)));
}

export function removeUnsaved(name: string): void {
  writeUnsaved(readUnsaved().filter((x) => x.name !== name));
}

/** Recordings that reached disk but were never saved (crash, closed tab, dismissed sheet). */
export async function listUnsavedRecordings(): Promise<UnsavedRecording[]> {
  const list = readUnsaved();
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

/** Free the disk copy once the user saved it somewhere (or discarded it). */
export async function discardOpfsRecording(name: string | null): Promise<void> {
  if (!name) return;
  removeUnsaved(name);
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    /* already gone */
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
