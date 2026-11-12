// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDevice, OWNER_KEY, purgeLiveAccountData, takeOverDevice } from './accountPurge';
import {
  DiskRecorder,
  discardOrphanUnsaved,
  listUnsavedRecordings,
  opfsSupported,
  orphanUnsaved,
  otherAccountsUnsaved,
  RECORDING_OWNERS_KEY,
  sweepOrphanRecordings,
  UNKNOWN_OWNER,
  unsavedRecordingsOf,
  type UnsavedRecording,
} from './recorder';
import { autoSave, sweepDiscardedRecordings } from './components/SaveSheet';

// Unsaved recordings on a shared device, through the real DiskRecorder and registry over a fake
// private file system (OPFS), recording worker and MediaRecorder. What the Privacy Policy and the
// Cookies notice say about them is what these check.

const HOUR = 60 * 60_000;
/** OPFS: entry name → size and last write (`empty`: a file nothing was ever written to). */
const files = new Map<string, { bytes: number; modified: number; empty?: boolean }>();
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

/** Runs inside the next getDirectory() call: another tab acting while this one awaits it. */
let duringGetDirectory: (() => void) | null = null;
const root = {
  async getFileHandle(name: string) {
    const f = files.get(name);
    if (!f) throw new DOMException('not found', 'NotFoundError');
    return { getFile: async () => new File([new Uint8Array(f.empty ? 0 : f.bytes || 1)], name, { type: 'video/webm', lastModified: f.modified }) };
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
  duringGetDirectory = null;
  const g = globalThis as Record<string, unknown>;
  g.Worker = FakeWorker;
  g.MediaRecorder = FakeMediaRecorder;
  // As on a real page: createSyncAccessHandle is exposed only in dedicated workers, never on a page's prototype.
  g.FileSystemFileHandle = class {};
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => undefined;
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => {
        const other = duringGetDirectory;
        duringGetDirectory = null;
        other?.();
        return root;
      },
      persist: async () => true,
      estimate: async () => ({ quota: 1e12, usage: 0 }),
    },
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

  it('on a page, where FileSystemFileHandle has no createSyncAccessHandle (a worker-only method), a recording still goes to disk and is listed for its account', async () => {
    expect('createSyncAccessHandle' in FileSystemFileHandle.prototype).toBe(false);
    expect(opfsSupported()).toBe(true);
    const name = await recordPart('disk.webm', 'u-a');
    expect(name).toMatch(/^ds-rec-\d+-disk\.webm$/);
    expect(files.has(name)).toBe(true);
    expect(registry().map((r) => [r.name, r.owner])).toEqual([[name, 'u-a']]);
    expect(JSON.parse(localStorage.getItem(RECORDING_OWNERS_KEY) || '{}')).toEqual({ [name]: 'u-a' });
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name)).toEqual([name]);
  });

  it('a recording no account made (owner null) is never stranded: anyone who opens Stream Studio here is offered it', async () => {
    const name = await recordPart('anon.webm', null);
    claimDevice('u-a');
    expect((await listUnsavedRecordings()).map((r) => r.name)).toEqual([name]);
    takeOverDevice('u-b');
    expect((await listUnsavedRecordings()).map((r) => r.name)).toEqual([name]);
  });
});

describe('every unsaved recording stays listed until it is saved or discarded, and one offered to no one can be freed', () => {
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

  it('the next account sees how many recordings another account left and how much space they use (no titles), and can never delete them', async () => {
    takeOverDevice('u-a');
    const as = [await recordPart('a-0.webm'), await recordPart('a-1.webm')];
    takeOverDevice('u-b');
    const mine = await recordPart('b-0.webm');
    const anon = await recordPart('anon.webm', null);
    expect(otherAccountsUnsaved()).toEqual({ count: 2, bytes: registry().filter((r) => r.owner === 'u-a').reduce((n, r) => n + r.bytes, 0) });
    expect(Object.keys(otherAccountsUnsaved())).toEqual(['count', 'bytes']);
    expect(orphanUnsaved()).toEqual({ names: [], bytes: 0 });
    // B naming A's recordings deletes nothing: only one offered to no one can be deleted by someone else.
    expect(await discardOrphanUnsaved(as)).toBe(0);
    expect([...files.keys()].sort()).toEqual([...as, mine, anon].sort());
    expect(otherAccountsUnsaved().count).toBe(2);
  });

  it('a delete of recordings offered to no one removes exactly the confirmed names that are still offered to no one', async () => {
    takeOverDevice('u-a');
    const owned = await recordPart('a.webm', 'u-a');
    const orphan = (name: string) => {
      files.set(name, { bytes: 7, modified: Date.now() - 2 * HOUR });
      localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([...registry(), { ...entry(name), bytes: 7, owner: UNKNOWN_OWNER }]));
    };
    orphan('ds-rec-o1');
    orphan('ds-rec-o2');
    takeOverDevice('u-b');
    expect(orphanUnsaved()).toEqual({ names: ['ds-rec-o1', 'ds-rec-o2'], bytes: 14 });
    expect(otherAccountsUnsaved('u-b')).toEqual({ count: 1, bytes: registry()[0].bytes });
    const confirmed = orphanUnsaved().names;
    orphan('ds-rec-o3'); // listed again after the confirm was shown
    expect(await discardOrphanUnsaved([...confirmed, owned])).toBe(2);
    expect([...files.keys()].sort()).toEqual([owned, 'ds-rec-o3'].sort());
    expect(registry().map((r) => r.name)).toEqual([owned, 'ds-rec-o3']);
  });

  it('on app start, a disk copy no list names (from the old 10-entry cap, or a crash) is listed again, never deleted; only an empty one goes', async () => {
    localStorage.setItem(OWNER_KEY, 'u-a');
    const listed = await recordPart('kept.webm', 'u-a');
    const old = 'ds-rec-1760000000000-streamstudio-ev-42-2025-10-09-08-53-20-part2.webm';
    files.set(old, { bytes: 5, modified: Date.now() - 2 * HOUR }); // pushed off the old list
    files.set('ds-rec-orphan-new', { bytes: 5, modified: Date.now() - 60_000 }); // another tab is still recording it
    files.set('ds-rec-downloading', { bytes: 5, modified: Date.now() - 2 * HOUR }); // waiting on the discard-later list
    files.set('ds-rec-empty', { bytes: 0, modified: Date.now() - 2 * HOUR, empty: true }); // nothing was ever recorded into it
    files.set('not-a-recording', { bytes: 5, modified: 0 });
    localStorage.setItem('ds-live-discard-later', JSON.stringify([{ name: 'ds-rec-downloading', at: Date.now() - 60_000 }]));
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([...registry(), entry('ds-rec-file-gone', 'u-b')]));
    await sweepDiscardedRecordings();
    // Only the empty file is deleted.
    expect([...files.keys()].sort()).toEqual([listed, old, 'ds-rec-downloading', 'ds-rec-orphan-new', 'not-a-recording'].sort());
    // The one pushed off the old list is an unsaved recording again, rebuilt from its name; nothing
    // says whose it is (the earlier version recorded no account), so it is offered to no one, whoever
    // holds the device. An entry whose disk copy is gone is dropped, whoever made it.
    expect(registry().map((r) => r.name)).toEqual([listed, old]);
    expect(registry()[1]).toEqual({
      name: old,
      file: 'streamstudio-ev-42-2025-10-09-08-53-20-part2.webm',
      mime: 'video/webm',
      eventId: 'ev-42',
      title: 'Recovered recording',
      at: 1760000000000,
      durMs: files.get(old)!.modified - 1760000000000,
      bytes: 5,
      owner: UNKNOWN_OWNER,
    });
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name)).toEqual([listed]);
    expect(orphanUnsaved()).toEqual({ names: [old], bytes: 5 });
    expect(otherAccountsUnsaved('u-a')).toEqual({ count: 0, bytes: 0 });
  });

  it('production kept only the 10 newest entries: the first start of this version deletes none; the 10 it listed stay offered to anyone here, as it offered them, and the one it dropped is offered to no one', async () => {
    // As the earlier version left a device: 11 kept recordings (days old), entries without
    // an owner, and the registry naming only the 10 newest.
    const names = Array.from({ length: 11 }, (_, i) => `ds-rec-${1760000000000 + i * HOUR}-streamstudio-e1-2025-10-09-0${i % 10}-00-00.webm`);
    for (const [i, name] of names.entries()) files.set(name, { bytes: 2_000, modified: Date.now() - (3 * 24 - i) * HOUR });
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(names.slice(-10).map((name, i) => ({ ...entry(name), at: 1760000000000 + (i + 1) * HOUR }))));
    localStorage.setItem(OWNER_KEY, 'u-host');
    claimDevice('u-host');
    await sweepDiscardedRecordings();
    expect(files.size).toBe(11);
    expect(registry()).toHaveLength(11);
    expect((await listUnsavedRecordings('u-host')).map((r) => r.name).sort()).toEqual(names.slice(1).sort());
    expect(orphanUnsaved()).toEqual({ names: [names[0]], bytes: 2_000 });
    // A tab still running the earlier version drops an entry again (slice(-10)): the next start lists
    // it again as it was, offered to anyone, also once another account holds the device.
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(registry().slice(-10)));
    takeOverDevice('u-other');
    await sweepDiscardedRecordings();
    expect(files.size).toBe(11);
    expect(registry()).toHaveLength(11);
    expect((await listUnsavedRecordings('u-host')).map((r) => r.name).sort()).toEqual(names.slice(1).sort());
    expect((await listUnsavedRecordings('u-other')).map((r) => r.name).sort()).toEqual(names.slice(1).sort());
  });

  it('a recording an earlier version stopped listing is offered to no one, whoever holds the device as the app starts or takes it over meanwhile', async () => {
    const name = 'ds-rec-1760000000000-streamstudio-e1-2025-10-09-08-00-00.webm';
    files.set(name, { bytes: 5, modified: Date.now() - 3 * 24 * HOUR }); // dropped by the old 10-entry cap
    localStorage.setItem('ds-live-unsaved-recordings', '[]'); // the earlier version's registry (the rest saved since)
    localStorage.setItem(OWNER_KEY, 'u-a');
    // B opens Stream Studio here: the account check claims the device while the sweep awaits the disk.
    duringGetDirectory = () => claimDevice('u-b');
    await sweepDiscardedRecordings();
    expect(registry().map((r) => [r.name, r.owner])).toEqual([[name, UNKNOWN_OWNER]]);
    expect(await listUnsavedRecordings('u-b')).toEqual([]);
    expect(await listUnsavedRecordings('u-a')).toEqual([]);
    expect(orphanUnsaved().names).toEqual([name]);
  });

  it('a download another tab finishes while the sweep starts is never listed again or deleted: the name goes on the discard-later list before it leaves the registry', async () => {
    const name = 'ds-rec-1760000000000-streamstudio-e1-2025-10-09-08-00-00.webm';
    files.set(name, { bytes: 5, modified: Date.now() - 3 * 24 * HOUR }); // a recording kept three days ago
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([{ ...entry(name), owner: 'u-a' }]));
    const writes: string[] = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      writes.push(k);
      return setItem.call(this, k, v);
    };
    try {
      // Tab A downloads it (Unsaved recordings → Save → Download) while tab B's sweep awaits the disk.
      duringGetDirectory = () => {
        void autoSave({ data: new Blob(['x']), file: 'x.webm', mime: 'video/webm', bytes: 5, durMs: 1, opfsName: name, eventId: 'e1', title: 't' }, 'download');
      };
      await sweepDiscardedRecordings();
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(writes.indexOf('ds-live-discard-later')).toBeLessThan(writes.indexOf('ds-live-unsaved-recordings'));
    expect(files.has(name)).toBe(true);
    expect(registry()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('ds-live-discard-later') || '[]').map((i: { name: string }) => i.name)).toEqual([name]);
  });

  it('the start-up sweep never overwrites a name another tab put on the discard-later list meanwhile', async () => {
    files.set('ds-rec-done', { bytes: 5, modified: Date.now() - 3 * HOUR });
    files.set('ds-rec-new-download', { bytes: 5, modified: Date.now() - 3 * HOUR });
    localStorage.setItem('ds-live-discard-later', JSON.stringify([{ name: 'ds-rec-done', at: Date.now() - 2 * HOUR }]));
    // While the sweep deletes the expired copy, another tab adds a download of its own.
    duringGetDirectory = () => {
      const list = JSON.parse(localStorage.getItem('ds-live-discard-later') || '[]');
      localStorage.setItem('ds-live-discard-later', JSON.stringify([...list, { name: 'ds-rec-new-download', at: Date.now() }]));
    };
    await sweepDiscardedRecordings();
    expect(files.has('ds-rec-done')).toBe(false);
    expect(JSON.parse(localStorage.getItem('ds-live-discard-later') || '[]').map((i: { name: string }) => i.name)).toEqual(['ds-rec-new-download']);
    // Still waiting there, so not listed again as an unsaved recording.
    expect(files.has('ds-rec-new-download')).toBe(true);
    expect(registry()).toEqual([]);
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
  it('are no account\'s: whoever holds the device when this version first sees them, the one who made them is still offered them, as is anyone here (as the earlier version offered them)', async () => {
    // A recorded under the earlier version, signed out there (it left the entries), and B opened
    // Stream Studio there before this version: the device is B's, the recording A's.
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry('ds-rec-old'), entry('ds-rec-b', 'u-b')]));
    files.set('ds-rec-old', { bytes: 5, modified: Date.now() - 3 * HOUR });
    files.set('ds-rec-b', { bytes: 5, modified: Date.now() - 3 * HOUR });
    localStorage.setItem(OWNER_KEY, 'u-b');
    claimDevice('u-b');
    await sweepDiscardedRecordings();
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-old', 'ds-rec-b']);
    purgeLiveAccountData(); // B signs out; A signs in
    claimDevice('u-a');
    await sweepDiscardedRecordings();
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-old']);
    expect(otherAccountsUnsaved('u-a').count).toBe(1); // B's own
    takeOverDevice('u-c'); // a switch in the main app gives it to no one either
    expect(unsavedRecordingsOf('u-c').map((r) => r.name)).toEqual(['ds-rec-old']);
    expect(JSON.parse(localStorage.getItem(RECORDING_OWNERS_KEY) || '{}')).toEqual({ 'ds-rec-old': null, 'ds-rec-b': 'u-b' });
    // No note of who held the device is kept for them.
    expect(localStorage.getItem('ds-live-legacy-owner')).toBeNull();
  });

  it('with no account holding the device then (signed out before this release), the same: anyone here is offered them, also before Stream Studio\'s start-up has seen them and by a studio opened for another account than the device\'s, and they stay that way', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry('ds-rec-old')]));
    claimDevice('u-b');
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-old']);
    expect(unsavedRecordingsOf('u-c').map((r) => r.name)).toEqual(['ds-rec-old']); // a studio still open for C lists for C
    expect(otherAccountsUnsaved('u-c').count).toBe(0);
    purgeLiveAccountData(); // B signs out: still nobody's, not B's
    claimDevice('u-a');
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-old']);
    expect(otherAccountsUnsaved('u-a').count).toBe(0);
  });
});

/** Recordings as the earlier version left a device: 11 kept (days old), the registry naming the 10 newest, untagged. */
const oldEra = (i: number) => `ds-rec-${1760000000000 + i * HOUR}-streamstudio-ev-a-2025-10-09-0${i % 10}-00-00.webm`;
function productionDevice(owner: string | null) {
  const names = Array.from({ length: 11 }, (_, i) => oldEra(i));
  for (const [i, name] of names.entries()) files.set(name, { bytes: 2_000, modified: Date.now() - (3 * 24 - i) * HOUR });
  localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(names.slice(-10).map((name) => entry(name))));
  if (owner) localStorage.setItem(OWNER_KEY, owner);
  return { names, orphan: names[0] };
}
/** As if nothing had written these files for two hours (the sweep leaves a file written in the last hour alone). */
const age = () => {
  for (const [name, f] of files) files.set(name, { ...f, modified: Date.now() - 2 * HOUR });
};
/** A tab still running the earlier version writes the registry: it keeps only the 10 newest entries. */
const oldTabWrite = () => localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(registry().slice(-10)));

describe('a recording whose entry is lost is listed again for its own account, never for whoever holds the device then', () => {
  for (const [held, how] of [['u-a', 'still holds the device'], ['u-b', 'had signed out and B had opened Stream Studio there'], [null, 'had signed out']] as const) {
    it(`an earlier version's kept recordings (10 listed, 1 it stopped listing), made by A, where under it A ${how}: A and anyone here are offered the 10, as that version offered them; the one it stopped listing is offered to no one`, async () => {
      const { names, orphan } = productionDevice(held);
      // This version's first loads: B opens Stream Studio (or the main app switches to B), then A.
      takeOverDevice('u-b');
      await sweepDiscardedRecordings();
      const listed = names.slice(1).sort();
      expect((await listUnsavedRecordings('u-b')).map((r) => r.name).sort()).toEqual(listed);
      purgeLiveAccountData(); // B signs out
      claimDevice('u-a');
      await sweepDiscardedRecordings();
      expect((await listUnsavedRecordings('u-a')).map((r) => r.name).sort()).toEqual(listed);
      expect(registry().find((r) => r.name === orphan)?.owner).toBe(UNKNOWN_OWNER);
      expect(unsavedRecordingsOf(UNKNOWN_OWNER).map((r) => r.name)).not.toContain(orphan);
      expect(orphanUnsaved()).toEqual({ names: [orphan], bytes: 2_000 });
      expect(otherAccountsUnsaved('u-a').count).toBe(0);
      // Nothing hands it to anyone later; anyone here can delete it.
      takeOverDevice('u-c');
      await sweepDiscardedRecordings();
      expect(registry().find((r) => r.name === orphan)?.owner).toBe(UNKNOWN_OWNER);
      expect(await discardOrphanUnsaved(orphanUnsaved().names)).toBe(1);
      expect(files.has(orphan)).toBe(false);
      expect(registry()).toHaveLength(10);
      expect(localStorage.getItem('ds-live-legacy-owner')).toBeNull();
    });
  }

  it('a tab still running the earlier version records for A while the main app switches to B, and rewrites its entry with no owner every few seconds: A is still offered it (and so is anyone here, as that version offers it)', async () => {
    localStorage.setItem('ds-live-unsaved-recordings', '[]');
    localStorage.setItem(OWNER_KEY, 'u-a');
    const name = `ds-rec-${Date.now() - 2 * HOUR}-streamstudio-e1-2026-11-12-08-00-00.webm`;
    files.set(name, { bytes: 5, modified: Date.now() });
    // The earlier version's upsertUnsaved: its entry, rebuilt with no owner field.
    const oldTabTouch = () => localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([...registry().filter((r) => r.name !== name), entry(name)]));
    oldTabTouch();
    takeOverDevice('u-b');
    oldTabTouch();
    claimDevice('u-b'); // B opens Stream Studio
    await sweepDiscardedRecordings();
    oldTabTouch();
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual([name]);
    expect(otherAccountsUnsaved('u-a').count).toBe(0);
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual([name]);
  });

  it('an entry rewritten with no owner (a tab still on the earlier version) keeps the owner recorded for it: one offered to no one, or to one account, stays that way', async () => {
    // Recovered with no record of who made it, while a paused tab on the earlier version still holds it.
    const orphan = `ds-rec-${Date.now() - 5 * HOUR}-streamstudio-e1-2026-11-12-04-00-00.webm`;
    files.set(orphan, { bytes: 5, modified: Date.now() - 2 * HOUR });
    localStorage.setItem('ds-live-unsaved-recordings', '[]');
    await sweepDiscardedRecordings();
    expect(registry().map((r) => [r.name, r.owner])).toEqual([[orphan, UNKNOWN_OWNER]]);
    // That tab resumes: its next write replaces the entry with one that has no owner.
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry(orphan)]));
    expect(unsavedRecordingsOf('u-a')).toEqual([]);
    expect(unsavedRecordingsOf(null)).toEqual([]);
    expect(orphanUnsaved().names).toEqual([orphan]);
    // One this version recorded for A, rewritten the same way, is still A's alone.
    const mine = await recordPart('a.webm', 'u-a');
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(registry().map((r) => (r.name === mine ? entry(mine) : r))));
    takeOverDevice('u-b');
    await sweepDiscardedRecordings();
    expect(unsavedRecordingsOf('u-b')).toEqual([]);
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual([mine]);
    expect(otherAccountsUnsaved('u-b').count).toBe(1);
    expect(orphanUnsaved().names).toEqual([orphan]);
  });

  it('a write of the owners\' record that fails (storage full) changes nothing about who is offered what', async () => {
    const run = async (failing: boolean) => {
      localStorage.clear();
      files.clear();
      const { names } = productionDevice('u-a');
      const setItem = Storage.prototype.setItem;
      if (failing) {
        Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
          if (k === RECORDING_OWNERS_KEY) throw new DOMException('full', 'QuotaExceededError');
          return setItem.call(this, k, v);
        };
      }
      try {
        purgeLiveAccountData(); // A signs out in the main app
        claimDevice('u-b');
        await sweepDiscardedRecordings();
      } finally {
        Storage.prototype.setItem = setItem;
      }
      claimDevice('u-b'); // the next start, with room again
      await sweepDiscardedRecordings();
      const offered = async (who: string | null) => (await listUnsavedRecordings(who)).map((r) => r.name).sort();
      return { names, b: await offered('u-b'), a: await offered('u-a'), others: otherAccountsUnsaved('u-b'), orphans: orphanUnsaved() };
    };
    const clean = await run(false);
    expect(clean.b).toEqual(clean.names.slice(1).sort());
    expect(clean.a).toEqual(clean.b);
    expect(clean.others).toEqual({ count: 0, bytes: 0 });
    expect(clean.orphans).toEqual({ names: [clean.names[0]], bytes: 2_000 });
    expect(await run(true)).toEqual(clean);
  });

  it('two accounts, and a tab still running the earlier version drops the oldest entries: each recording comes back for the account it was made for', async () => {
    takeOverDevice('u-b');
    const bs = [await recordPart('b-0.webm', 'u-b'), await recordPart('b-1.webm', 'u-b'), await recordPart('b-2.webm', 'u-b')];
    takeOverDevice('u-a');
    const as: string[] = [];
    for (let i = 0; i < 10; i++) as.push(await recordPart(`a-${i}.webm`, 'u-a'));
    expect(otherAccountsUnsaved('u-a').count).toBe(3);
    age();
    oldTabWrite(); // B's three entries go
    expect(registry().some((r) => bs.includes(r.name))).toBe(false);
    await sweepDiscardedRecordings();
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name).sort()).toEqual([...as].sort());
    expect(otherAccountsUnsaved('u-a').count).toBe(3);
    expect((await listUnsavedRecordings('u-b')).map((r) => r.name).sort()).toEqual([...bs].sort());
    // A's own, dropped the same way after a switch to B, come back as A's.
    oldTabWrite();
    oldTabWrite();
    takeOverDevice('u-b');
    const dropped = as.filter((n) => !registry().some((r) => r.name === n));
    expect(dropped.length).toBeGreaterThan(0);
    await sweepDiscardedRecordings();
    expect((await listUnsavedRecordings('u-b')).map((r) => r.name).sort()).toEqual([...bs].sort());
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name)).toEqual(expect.arrayContaining(dropped));
  });

  it('a registry write that fails while recording: the recording still comes back for the account it was made for', async () => {
    takeOverDevice('u-b');
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (k === 'ds-live-unsaved-recordings') throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, k, v);
    };
    let name: string;
    try {
      name = await recordPart('b.webm', 'u-b');
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(registry()).toEqual([]);
    purgeLiveAccountData(); // B signs out; A signs in
    claimDevice('u-a');
    age();
    await sweepDiscardedRecordings();
    expect(await listUnsavedRecordings('u-a')).toEqual([]);
    expect((await listUnsavedRecordings('u-b')).map((r) => [r.name, r.title])).toEqual([[name, 'Recovered recording']]);
  });

});

describe('a saved recording never comes back as "Recovered recording" when a write or a delete fails', () => {
  it('a download whose discard-later write fails keeps its entry, its title and its owner, instead of leaving a file no list names', async () => {
    takeOverDevice('u-a');
    const r = await DiskRecorder.start({} as MediaStream, 'video/webm', 1_000_000, 'a.webm', { eventId: 'e1', title: 'Stream a' }, 'u-a');
    (r as unknown as { rec: FakeMediaRecorder }).rec.ondataavailable?.({ data: chunk('recorded bytes') });
    const done = await r.stop();
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (k === 'ds-live-discard-later') throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, k, v);
    };
    try {
      expect(await autoSave(done, 'download')).toBe('Downloads');
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(registry().map((e) => [e.name, e.title, e.owner])).toEqual([[done.opfsName, 'Stream a', 'u-a']]);
    age();
    takeOverDevice('u-b');
    await sweepDiscardedRecordings();
    expect(registry().map((e) => [e.name, e.title, e.owner])).toEqual([[done.opfsName, 'Stream a', 'u-a']]);
    expect(await listUnsavedRecordings('u-b')).toEqual([]);
  });

  it('a due discard whose file can\'t be deleted stays on the discard-later list and is tried again at the next start, never listed again', async () => {
    files.set('ds-rec-done', { bytes: 5, modified: Date.now() - 3 * HOUR });
    localStorage.setItem('ds-live-discard-later', JSON.stringify([{ name: 'ds-rec-done', at: Date.now() - 2 * HOUR }]));
    const removeEntry = root.removeEntry;
    root.removeEntry = async () => {
      throw new DOMException('in use', 'NoModificationAllowedError');
    };
    try {
      await sweepDiscardedRecordings();
    } finally {
      root.removeEntry = removeEntry;
    }
    expect(files.has('ds-rec-done')).toBe(true);
    expect(registry()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('ds-live-discard-later') || '[]').map((i: { name: string }) => i.name)).toEqual(['ds-rec-done']);
    await sweepDiscardedRecordings();
    expect(files.has('ds-rec-done')).toBe(false);
    expect(localStorage.getItem('ds-live-discard-later')).toBe('[]');
  });

  it('a recording whose file can\'t be deleted keeps its entry, and is not counted as deleted', async () => {
    const a = 'ds-rec-1760000000000-a.webm';
    files.set(a, { bytes: 5, modified: Date.now() - 2 * HOUR });
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([{ ...entry(a), owner: UNKNOWN_OWNER }]));
    const removeEntry = root.removeEntry;
    root.removeEntry = async () => {
      throw new DOMException('in use', 'NoModificationAllowedError');
    };
    try {
      expect(await discardOrphanUnsaved([a])).toBe(0);
    } finally {
      root.removeEntry = removeEntry;
    }
    expect(registry().map((e) => [e.name, e.owner])).toEqual([[a, UNKNOWN_OWNER]]);
    expect(await discardOrphanUnsaved([a])).toBe(1);
    expect(registry()).toEqual([]);
    expect(files.has(a)).toBe(false);
  });
});
