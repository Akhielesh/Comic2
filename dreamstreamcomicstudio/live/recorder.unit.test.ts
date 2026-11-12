// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDevice, LEGACY_OWNER_KEY, OWNER_KEY, purgeLiveAccountData, RECORDING_OWNERS_KEY, takeOverDevice, UNKNOWN_OWNER } from './accountPurge';
import {
  DiskRecorder,
  discardOtherAccountsUnsaved,
  listUnsavedRecordings,
  otherAccountsUnsaved,
  sweepOrphanRecordings,
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
  g.FileSystemFileHandle = class {
    createSyncAccessHandle() {}
  };
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
    // The one pushed off the old list is an unsaved recording again, rebuilt from its name, for the
    // account that holds the device (as settleUnownedRecordings would give it); an entry whose disk
    // copy is gone is dropped, whoever made it.
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
      owner: 'u-a',
    });
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name)).toEqual([listed, old]);
  });

  it('production kept only the 10 newest entries: the first start of this version offers all 11 kept recordings again, none is deleted', async () => {
    // As the earlier version left a device: 11 kept recordings (days old), entries without
    // an owner, and the registry naming only the 10 newest.
    const names = Array.from({ length: 11 }, (_, i) => `ds-rec-${1760000000000 + i * HOUR}-streamstudio-e1-2025-10-09-0${i % 10}-00-00.webm`);
    for (const [i, name] of names.entries()) files.set(name, { bytes: 2_000, modified: Date.now() - (3 * 24 - i) * HOUR });
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(names.slice(-10).map((name, i) => ({ ...entry(name), at: 1760000000000 + (i + 1) * HOUR }))));
    localStorage.setItem(OWNER_KEY, 'u-host');
    claimDevice('u-host');
    await sweepDiscardedRecordings();
    expect(files.size).toBe(11);
    expect((await listUnsavedRecordings('u-host')).map((r) => r.name).sort()).toEqual([...names].sort());
    expect(registry().every((r) => r.owner === 'u-host')).toBe(true);
    // A tab still running the earlier version drops the overflow again (slice(-10)): the next start
    // lists it again, for the account it was settled to, also once another account holds the device.
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify(registry().slice(-10)));
    takeOverDevice('u-other');
    await sweepDiscardedRecordings();
    expect(files.size).toBe(11);
    expect(registry()).toHaveLength(11);
    expect(await listUnsavedRecordings('u-host')).toHaveLength(11);
    expect(await listUnsavedRecordings('u-other')).toEqual([]);
  });

  it('a recording listed again goes to the account whose data the device held as the app started, even when this load\'s account check hands the device to someone else meanwhile (as settleUnownedRecordings decides)', async () => {
    const name = 'ds-rec-1760000000000-streamstudio-e1-2025-10-09-08-00-00.webm';
    files.set(name, { bytes: 5, modified: Date.now() - 3 * 24 * HOUR }); // dropped by the old 10-entry cap
    localStorage.setItem('ds-live-unsaved-recordings', '[]'); // the earlier version's registry (the rest saved since)
    localStorage.setItem(OWNER_KEY, 'u-a'); // A never signed out under the earlier version
    // B opens Stream Studio here: the account check claims the device while the sweep awaits the disk.
    duringGetDirectory = () => claimDevice('u-b');
    await sweepDiscardedRecordings();
    expect(registry().map((r) => [r.name, r.owner])).toEqual([[name, 'u-a']]);
    expect(await listUnsavedRecordings('u-b')).toEqual([]);
    expect(otherAccountsUnsaved('u-b').count).toBe(1);
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
  it('go to the account that holds the device the first time this code sees it, never to whoever signs in or lists them first', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry('ds-rec-old'), entry('ds-rec-b', 'u-b')]));
    localStorage.setItem(OWNER_KEY, 'u-a');
    takeOverDevice('u-b'); // B signs in on the main app: A's device data goes, the old entry becomes A's
    expect(registry().map((r) => r.owner)).toEqual(['u-a', 'u-b']);
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-b']);
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-old']);
  });

  it('go to the account whose data the device held when this version first ran, even when another account is the one signing in to Stream Studio at that moment (the Privacy Policy\'s wording)', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([entry('ds-rec-old')]));
    localStorage.setItem(OWNER_KEY, 'u-a'); // A never signed out under the earlier version
    expect(claimDevice('u-b')).toBe(true); // B opens Stream Studio here first: A's data goes, the old entry is A's
    expect(registry()[0].owner).toBe('u-a');
    expect(unsavedRecordingsOf('u-b')).toEqual([]);
    expect(otherAccountsUnsaved('u-b').count).toBe(1);
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
const legacy = () => JSON.parse(localStorage.getItem(LEGACY_OWNER_KEY) || 'null') as { owner: string | null; at: number } | null;

describe('a recording whose entry is lost is listed again for its own account, never for whoever holds the device then', () => {
  it('the main app switches accounts before Stream Studio first opens under this version: the kept recording the earlier version stopped listing goes to the account whose data the device held then', async () => {
    const { names, orphan } = productionDevice('u-a');
    takeOverDevice('u-b'); // A to B in the main app (same origin): A's listed entries become A's, the device B's
    await sweepDiscardedRecordings(); // B opens Stream Studio
    expect(await listUnsavedRecordings('u-b')).toEqual([]);
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name).sort()).toEqual([...names].sort());
    expect(registry().find((r) => r.name === orphan)?.owner).toBe('u-a');
    expect(otherAccountsUnsaved('u-b').count).toBe(11);
  });

  it('the account signs out in the main app first: the recording still goes to that account, not to no one (which would offer it to everyone)', async () => {
    const { orphan } = productionDevice('u-a');
    purgeLiveAccountData(); // A signs out (or the 30-day idle sign-out)
    await sweepDiscardedRecordings(); // the next Stream Studio load, nobody signed in
    expect(registry().find((r) => r.name === orphan)?.owner).toBe('u-a');
    expect(await listUnsavedRecordings(null)).toEqual([]);
    claimDevice('u-b');
    expect(await listUnsavedRecordings('u-b')).toEqual([]);
    takeOverDevice('u-c');
    expect(await listUnsavedRecordings('u-c')).toEqual([]);
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name)).toContain(orphan);
  });

  it('on a device no account held when this version first ran, such a recording is offered to no one: anyone here sees it counted, with its size, and can delete it', async () => {
    const { names, orphan } = productionDevice(null);
    await sweepDiscardedRecordings();
    expect(registry().find((r) => r.name === orphan)?.owner).toBe(UNKNOWN_OWNER);
    // The entries the earlier version still listed are no one's, as before: offered to anyone.
    expect((await listUnsavedRecordings(null)).map((r) => r.name).sort()).toEqual(names.slice(1).sort());
    claimDevice('u-b');
    expect((await listUnsavedRecordings('u-b')).map((r) => r.name)).not.toContain(orphan);
    expect(unsavedRecordingsOf(UNKNOWN_OWNER).map((r) => r.name)).not.toContain(orphan);
    expect(otherAccountsUnsaved(null)).toEqual({ count: 1, bytes: 2_000 });
    expect(otherAccountsUnsaved('u-b')).toEqual({ count: 1, bytes: 2_000 });
    // Settling never hands it to anyone later either.
    takeOverDevice('u-c');
    expect(registry().find((r) => r.name === orphan)?.owner).toBe(UNKNOWN_OWNER);
    expect(await discardOtherAccountsUnsaved('u-c')).toBe(1);
    expect(files.has(orphan)).toBe(false);
    expect(registry()).toHaveLength(10);
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

  it('one with no record of who made it, from after this version first ran here (a tab still on the earlier version, whose entry it dropped before it was settled), is offered to no one', async () => {
    localStorage.setItem('ds-live-unsaved-recordings', '[]');
    localStorage.setItem(OWNER_KEY, 'u-a');
    const firstRan = Date.now() - 5 * HOUR;
    localStorage.setItem(LEGACY_OWNER_KEY, JSON.stringify({ owner: 'u-a', at: firstRan }));
    const before = `ds-rec-${Date.now() - 6 * HOUR}-streamstudio-e1-2026-11-12-00-00-00.webm`;
    const after = `ds-rec-${Date.now() - 4 * HOUR}-streamstudio-e1-2026-11-12-02-00-00.webm`;
    files.set(before, { bytes: 5, modified: Date.now() - 5.5 * HOUR });
    files.set(after, { bytes: 7, modified: Date.now() - 3 * HOUR });
    await sweepDiscardedRecordings();
    expect(registry().map((r) => [r.name, r.owner])).toEqual([[before, 'u-a'], [after, UNKNOWN_OWNER]]);
    expect((await listUnsavedRecordings('u-a')).map((r) => r.name)).toEqual([before]);
    expect(otherAccountsUnsaved('u-a')).toEqual({ count: 1, bytes: 7 });
    // Each now has its own recorded owner, so the account that held the device then is forgotten.
    expect(JSON.parse(localStorage.getItem(RECORDING_OWNERS_KEY) || '{}')).toEqual({ [before]: 'u-a', [after]: UNKNOWN_OWNER });
    expect(legacy()).toEqual({ owner: null, at: firstRan });
  });

  it('the account that held the device when this version first ran is noted only where an earlier version kept recordings, and kept until each of its recordings has its own owner', async () => {
    localStorage.setItem(OWNER_KEY, 'u-a');
    claimDevice('u-a'); // no registry: the earlier version never kept a recording here
    expect(legacy()?.owner).toBeNull();
    localStorage.clear();
    // One the earlier version dropped from its list moments ago (another tab may still be writing it).
    const { orphan } = productionDevice('u-a');
    files.set(orphan, { bytes: 2_000, modified: Date.now() - 10 * 60_000 });
    claimDevice('u-a');
    await sweepDiscardedRecordings();
    expect(registry().some((r) => r.name === orphan)).toBe(false);
    expect(legacy()?.owner).toBe('u-a');
    purgeLiveAccountData();
    claimDevice('u-b');
    files.set(orphan, { bytes: 2_000, modified: Date.now() - 2 * HOUR });
    await sweepDiscardedRecordings();
    expect(registry().find((r) => r.name === orphan)?.owner).toBe('u-a');
    expect(legacy()?.owner).toBeNull();
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
    takeOverDevice('u-a');
    const a = await recordPart('a.webm', 'u-a');
    takeOverDevice('u-b');
    const removeEntry = root.removeEntry;
    root.removeEntry = async () => {
      throw new DOMException('in use', 'NoModificationAllowedError');
    };
    try {
      expect(await discardOtherAccountsUnsaved()).toBe(0);
    } finally {
      root.removeEntry = removeEntry;
    }
    expect(registry().map((e) => [e.name, e.owner])).toEqual([[a, 'u-a']]);
    expect(await discardOtherAccountsUnsaved()).toBe(1);
    expect(registry()).toEqual([]);
    expect(files.has(a)).toBe(false);
  });
});
