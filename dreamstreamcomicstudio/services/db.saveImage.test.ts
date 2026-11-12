// Avatar / client image uploads: the comic-assets storage policies ("Authenticated Upload",
// "Authenticated Manage", read from the live catalog 2026-11-05) only let a signed-in user write
// where `(storage.foldername(name))[1] = auth.uid()`. saveImage used `u/<uid>/tmp/<id>.<ext>`,
// whose first folder is "u", so every browser upload was refused. The fake storage below applies
// that policy, so the test fails on any path shape the bucket would refuse.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const UID = '0f0e0d0c-0b0a-4908-8706-050403020100';

const sb = vi.hoisted(() => ({
  uploads: [] as { path: string; contentType?: string }[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[]
}));

/** storage.foldername(name): the folder segments of an object name (the file name dropped). */
const foldername = (name: string): string[] => name.split('/').slice(0, -1);

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: UID } } }) },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _blob: Blob, opts: { contentType?: string }) => {
          // The live INSERT policy for comic-assets.
          if (bucket !== 'comic-assets' || foldername(path)[0] !== UID) {
            return { error: { message: 'new row violates row-level security policy' } };
          }
          sb.uploads.push({ path, contentType: opts?.contentType });
          return { error: null };
        }
      })
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      sb.rpcs.push({ fn, args });
      return { error: null };
    }
  }
}));

const { saveImage, saveAvatarImage, clientUploadPath, AVATAR_MAX_BYTES } = await import('./db');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  sb.uploads.length = 0;
  sb.rpcs.length = 0;
});

describe('clientUploadPath', () => {
  it('puts the uid first, as the bucket policy requires, in the lane every reader resolves', () => {
    const p = clientUploadPath(UID, 'abc-123', 'image/png');
    expect(p).toBe(`${UID}/abc-123.png`);
    expect(foldername(p)[0]).toBe(UID);
    // The classic <uid>/<file> lane (services/db.ts buildImagePathCandidates, /api/system/image-url).
    expect(p).toMatch(/^[0-9a-f-]{36}\/[^/]+$/i);
    expect(clientUploadPath(UID, 'abc-123', 'image/jpeg', 'avatar')).toBe(`${UID}/avatar-abc-123.jpeg`);
  });

  it('refuses types a picture should never be (SVG can carry script) and malformed ids', () => {
    expect(() => clientUploadPath(UID, 'x', 'image/svg+xml')).toThrow(/not supported/);
    expect(() => clientUploadPath(UID, 'x', 'text/html')).toThrow(/not supported/);
    expect(() => clientUploadPath('u', 'x', 'image/png')).toThrow(/user id/);
    expect(() => clientUploadPath(UID, '../x', 'image/png')).toThrow(/upload id/);
  });
});

describe('saveImage', () => {
  it('an avatar upload is accepted by the bucket policy and is not registered for retention', async () => {
    const path = await saveAvatarImage(PNG);
    expect(sb.uploads).toEqual([{ path, contentType: 'image/png' }]);
    expect(foldername(path)[0]).toBe(UID);
    expect(path.startsWith(`${UID}/avatar-`)).toBe(true);
    // profiles.avatar_url is not an "active image path": registering would let retention purge it.
    expect(sb.rpcs).toEqual([]);
  });

  it('a studio image upload is accepted and registered as before', async () => {
    const path = await saveImage(PNG);
    expect(sb.uploads.map((u) => u.path)).toEqual([path]);
    expect(sb.rpcs).toEqual([expect.objectContaining({ fn: 'register_image_asset', args: expect.objectContaining({ p_path: path }) })]);
  });

  it('refuses an avatar above the size cap before uploading', async () => {
    const big = `data:image/png;base64,${btoa('x'.repeat(AVATAR_MAX_BYTES + 3))}`;
    await expect(saveAvatarImage(big)).rejects.toThrow(/larger than 5 MB/);
    expect(sb.uploads).toEqual([]);
  });
});
