import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadingRecorder, readingSettings } from './libraryReadingSync';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { rpc } }));
const slug = 'Story000000000001';
const enabled = { enabled: true, epoch: 'epoch-1', reads: [] };
const result = (data: unknown) => ({ data, error: null });
beforeEach(() => rpc.mockReset());

describe('private reading sync', () => {
  it('requires consent and never sends covers or out-of-range positions', async () => {
    rpc.mockResolvedValue(result({ ...enabled, enabled: false, epoch: null }));
    const recorder = createReadingRecorder('member', slug);
    await recorder.record(0, 5);
    await recorder.record(6, 5);
    expect(rpc).not.toHaveBeenCalled();
    await recorder.record(2, 5);
    await recorder.record(3, 5);
    expect(rpc.mock.calls.map((c) => c[1])).toEqual([{ p_owner: 'member', p_action: 'get', p_epoch: null }]);
  });
  it('restores versioned progress and never revives an old epoch after another device clears or disables sync', async () => {
    rpc
      .mockResolvedValueOnce(
        result({ ...enabled, reads: [{ slug, page: 2, lastPage: 5, at: Date.now(), revision: 7 }] })
      )
      .mockResolvedValueOnce(result({ saved: true, revision: 8 }))
      .mockResolvedValueOnce(result({ saved: false }));
    const reader = createReadingRecorder('member', slug);
    await reader.record(2, 5);
    await reader.record(3, 5);
    await reader.record(4, 5);
    await reader.record(5, 5);
    expect(rpc.mock.calls.map((c) => [c[1].p_action, c[1].p_revision])).toEqual([
      ['get', undefined],
      ['save', 7],
      ['save', 8]
    ]);
    expect(rpc.mock.calls[1][1]).toEqual({
      p_owner: 'member',
      p_action: 'save',
      p_slug: slug,
      p_page: 3,
      p_last_page: 5,
      p_revision: 7,
      p_epoch: 'epoch-1'
    });
    expect(JSON.stringify(localStorage)).not.toContain(slug);
  });
  it('coalesces overlapping turns into the latest known page and closes pending writes on identity change', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    rpc
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        })
      )
      .mockResolvedValueOnce(result({ saved: true, revision: 1 }));
    const reader = createReadingRecorder('member', slug);
    const first = reader.record(1, 5);
    await reader.record(3, 5);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    resolve(result(enabled));
    await first;
    expect(rpc.mock.calls[1][1].p_page).toBe(3);
    reader.close();
    await reader.record(4, 5);
    expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockClear();
    rpc.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    const another = createReadingRecorder('different', slug);
    const pending = another.record(2, 5);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    another.close();
    resolve(result(enabled));
    await pending;
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed or inaccessible settings and does not expose unexpected server fields', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: '42501' } })
      .mockResolvedValueOnce(result({}))
      .mockResolvedValueOnce(
        result({
          ...enabled,
          reads: [
            { slug: 'bad', at: 1, revision: 2 },
            { slug, page: 2, lastPage: 4, at: 11, revision: 1, extra: 'secret' }
          ]
        })
      );
    await expect(readingSettings('someone')).rejects.toThrow();
    await expect(readingSettings('someone')).rejects.toThrow();
    expect((await readingSettings('member')).reads).toEqual([{ slug, page: 2, lastPage: 4, at: 11, revision: 1 }]);
  });
});
