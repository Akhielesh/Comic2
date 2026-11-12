// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDevice, OWNER_KEY, purgeLiveAccountData, takeOverDevice } from './accountPurge';
import {
  DiskRecorder,
  discardOtherAccountsUnsaved,
  listUnsavedRecordings,
  otherAccountsUnsaved,
  sweepOrphanRecordings,
  unsavedRecordingsOf,
  type UnsavedRecording,
} from './recorder';
import { sweepDiscardedRecordings } from './components/SaveSheet';

// Unsaved recordings on a shared device, through the real DiskRecorder and registry over a fake
// private file system (OPFS), recording worker and MediaRecorder. What the Privacy Policy and the
// Cookies notice say about them is what these check.

const HOUR = 60 * 60_000;
/** OPFS: entry name → size and last write. */
const files = new Map<string, { bytes: number; modified: number }>();
const chunk = (text: string) => ({ size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as unknown as Blob;

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  name = '';
  bytes = 0;
  postMessage(m: { op: string; name?: string; buf?: ArrayBuffer }) {
    queueMicrotask(() => {
      if (m.op === 'open') {
        this.name = m.name as string;
        files.set(this.name, { bytes: 0, modified: Date.now() });
        this.onmessage?.({ data: { op: 'opened' } });
      } else if (m.op === 'write') {
        this.bytes += (m.buf as ArrayBuffer).byteLength;
        files.set(this.name, { bytes: this.bytes, modified: Date.now() });
        this.onmessage?.({ data: { op: 'wrote', bytes: this.bytes } });
      } else if (m.op === 'close') {
        this.onmessage?.({ data: { op: 'closed', bytes: this.bytes } });
      }
    });
  }
  terminate() {}
}

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.ondataavailable?.({ data: chunk('tail') });
    this.state = 'inactive';
    queueMicrotask(() => this.dispatchEvent(new Event('stop')));
  }
}

const root = {
  async getFileHandle(name: string) {
    const f = files.get(name);
    if (!f) throw new DOMException('not found', 'NotFoundError');
    return { getFile: async () => new File([new Uint8Array(f.bytes || 1)], name, { type: 'video/webm', lastModified: f.modified }) };
  },
  async removeEntry(name: string) {
    files.delete(name);
  },
  async *keys() {
    yield* [...files.keys()];
  },
};

beforeEach(() => {
  localStorage.clear();
  files.clear();
  const g = globalThis as Record<string, unknown>;
  g.Worker = FakeWorker;
  g.MediaRecorder = FakeMediaRecorder;
  g.FileSystemFileHandle = class {
    createSyncAccessHandle() {}
  };
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => undefined;
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root, persist: async () => true, estimate: async () => ({ quota: 1e12, usage: 0 }) },
  });
});

/** Record one part and leave it unsaved (a closed tab, "Keep for later"). */
async function recordPart(file: string, owner?: string | null): Promise<string> {
  const r = await DiskRecorder.start({} as MediaStream, 'video/webm', 1_000_000, file, { eventId: 'e1', title: `Stream ${file}` }, ...(owner === undefined ? [] : [owner]));
  (r as unknown as { rec: FakeMediaRecorder }).rec.ondataavailable?.({ data: chunk('recorded bytes') });
  const done = await r.stop();
  return done.opfsName as string;
}
const registry = () => JSON.parse(localStorage.getItem('ds-live-unsaved-recordings') || '[]') as UnsavedRecording[];
const entry = (name: string, owner?: string | null): UnsavedRecording => ({
  name, file: `${name}.webm`, mime: 'video/webm', eventId: 'e1', title: `Stream ${name}`, at: 1, durMs: 1000, bytes: 10,
  ...(owner === undefined ? {} : { owner }),
});

describe('a recording belongs to the account the studio was opened for', () => {
  it('a part recorded after a sign-out elsewhere (the studio keeps running) is still the host\'s, and offered to them when they sign back in', async () => {
    localStorage.setItem(OWNER_KEY, 'u-a');
    const first = await recordPart('part1.webm', 'u-a');
    purgeLiveAccountData(); // signed out of DreamStream in another tab mid-stream
    const second = await recordPart('part2.webm', 'u-a'); // the studio passes the account it opened for
    expect(registry().map((r) => r.owner)).toEqual(['u-a', 'u-a']);
    // The studio still lists both parts for its account...
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name).sort()).toEqual([first, second].sort());
    // ...and once the host signs back in, the dashboard offers both; the next person doesn't see them.
    claimDevice('u-a');
    expect((await listUnsavedRecordings()).map((r) => r.name).sort()).toEqual([first, second].sort());
    takeOverDevice('u-b');
    expect(await listUnsavedRecordings()).toEqual([]);
  });

  it('the studio passes that account to the recorder and to its own list of unsaved recordings', () => {
    const studio = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'views/StudioView.tsx'), 'utf8');
    expect(studio).toContain('const recOwnerRef = useRef<string | null>(getAccount().userId ?? deviceOwner());');
    expect(studio).toMatch(/DiskRecorder\.start\([\s\S]*?\}, recOwnerRef\.current\);/);
    expect(studio.match(/listUnsavedRecordings\(recOwnerRef\.current\)/g)).toHaveLength(2);
    expect(studio).not.toMatch(/listUnsavedRecordings\(\)/);
  });

  it('a recording no account made (owner null) is never stranded: anyone who opens Stream Studio here is offered it', async () => {
    const name = await recordPart('anon.webm', null);
    claimDevice('u-a');
    expect((await listUnsavedRecordings()).map((r) => r.name)).toEqual([name]);
    takeOverDevice('u-b');
    expect((await listUnsavedRecordings()).map((r) => r.name)).toEqual([name]);
  });
});

describe('every unsaved recording stays listed until it is saved or discarded, and another account\'s can be freed', () => {
  it('more than 10 unsaved recordings: each keeps its entry, so no file is left that nothing names', async () => {
    takeOverDevice('u-a');
    for (let i = 0; i < 10; i++) await recordPart(`a-${i}.webm`);
    takeOverDevice('u-b');
    await recordPart('b-0.webm');
    expect(files.size).toBe(11);
    expect(registry()).toHaveLength(11);
    expect([...files.keys()].every((n) => registry().some((r) => r.name === n))).toBe(true);
    // A is still offered all ten when they come back.
    takeOverDevice('u-a');
    expect(await listUnsavedRecordings()).toHaveLength(10);
  });

  it('the next account sees how many recordings another account left and how much space they use (no titles), and can delete them', async () => {
    takeOverDevice('u-a');
    await recordPart('a-0.webm');
    await recordPart('a-1.webm');
    takeOverDevice('u-b');
    const mine = await recordPart('b-0.webm');
    const anon = await recordPart('anon.webm', null);
    expect(otherAccountsUnsaved()).toEqual({ count: 2, bytes: registry().filter((r) => r.owner === 'u-a').reduce((n, r) => n + r.bytes, 0) });
    expect(Object.keys(otherAccountsUnsaved())).toEqual(['count', 'bytes']);
    expect(await discardOtherAccountsUnsaved()).toBe(2);
    expect([...files.keys()].sort()).toEqual([mine, anon].sort());
    expect(registry().map((r) => r.name).sort()).toEqual([mine, anon].sort());
    expect(otherAccountsUnsaved()).toEqual({ count: 0, bytes: 0 });
  });

  it('on app start, a disk copy no list names (from the old 10-entry cap, or a crash) is deleted once nothing has written it for an hour', async () => {
    const listed = await recordPart('kept.webm', 'u-a');
    files.set('ds-rec-orphan-old', { bytes: 5, modified: Date.now() - 2 * HOUR }); // pushed off the old list
    files.set('ds-rec-orphan-new', { bytes: 5, modified: Date.now() - 60_000 }); // another tab is still recording it
    files.set('ds-rec-downloading', { bytes: 5, modified: Date.now() - 2 * HOUR }); // waiting on the discard-later list
    files.set('not-a-recording', { bytes: 5, modified: 0 });
    localStorage.setItem('ds-live-discard-later', JSON.stringify([{ name: 'ds-rec-downloading', at: Date.now() - 60_000 }]));
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([...registry(), entry('ds-rec-file-gone', 'u-b')]));
    await sweepDiscardedRecordings();
    expect([...files.keys()].sort()).toEqual([listed, 'ds-rec-downloading', 'ds-rec-orphan-new', 'not-a-recording'].sort());
    // An entry whose disk copy is gone is dropped, whoever made it.
    expect(registry().map((r) => r.name)).toEqual([listed]);
  });

  it('with a list it can\'t read, the sweep touches nothing', async () => {
    files.set('ds-rec-x', { bytes: 5, modified: 0 });
    localStorage.setItem('ds-live-unsaved-recordings', '{not json');
    await sweepOrphanRecordings();
    expect(files.has('ds-rec-x')).toBe(true);
    localStorage.setItem('ds-live-unsaved-recordings', '[]');
    localStorage.setItem('ds-live-discard-later', '{not json');
    await sweepDiscardedRecordings();
    expect(files.has('ds-rec-x')).toBe(true);
  });
});

describe('recordings left unsaved before entries carried an owner', () => {
  it('go to the account that holds the device the first time this code sees it, never to whoever signs in or lists them first', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry('ds-rec-old'), entry('ds-rec-b', 'u-b')]));
    localStorage.setItem(OWNER_KEY, 'u-a');
    takeOverDevice('u-b'); // B signs in on the main app: A's device data goes, the old entry becomes A's
    expect(registry().map((r) => r.owner)).toEqual(['u-a', 'u-b']);
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-b']);
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-old']);
  });

  it('with no account holding the device then (signed out before this release), they go to no account: anyone here is offered them, and they stay that way', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry('ds-rec-old')]));
    claimDevice('u-b');
    expect(registry()[0].owner).toBeNull();
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-old']);
    purgeLiveAccountData(); // B signs out: still nobody's, not B's
    expect(registry()[0].owner).toBeNull();
    claimDevice('u-a');
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-old']);
  });
});
