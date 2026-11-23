import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistGeneratedImage } from './imageStorage.js';

const setup = vi.hoisted(() => ({
  rpc: vi.fn(),
  storage: vi.fn(),
  insert: vi.fn(),
  upload: vi.fn(),
  createSignedUrl: vi.fn(),
  getPublicUrl: vi.fn()
}));

vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => ({
    rpc: setup.rpc,
    storage: { from: setup.storage },
    from: () => ({ insert: setup.insert })
  })
}));

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generate = async (options: { standalone?: boolean; projectId?: string } = { projectId: project }) => {
  const buffer = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#6482ad' } })
    .webp()
    .toBuffer();
  return persistGeneratedImage({
    userId: owner,
    source: 'gemini',
    dataUrl: 'data:image/webp;base64,' + buffer.toString('base64'),
    ...options
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  setup.rpc.mockReturnValue({ abortSignal: async () => ({ data: [], error: null }) });
  setup.storage.mockReturnValue(setup);
  setup.upload.mockResolvedValue({ error: null });
  setup.insert.mockResolvedValue({ error: null });
  setup.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'signed' }, error: null });
  setup.getPublicUrl.mockReturnValue({ data: { publicUrl: 'public' } });
});
describe('shared Image API project storage', () => {
  it('saves an activated project privately and returns an expiring result even for an uppercase project parameter', async () => {
    setup.rpc.mockReturnValue({ abortSignal: async () => ({ data: [{ project_id: project, owner_id: owner }], error: null }) });
    const result = await generate({ projectId: project.toUpperCase() });
    expect(result.imageId).toMatch(new RegExp('^u/' + owner + '/p/' + project + '/img/'));
    expect(result.imageUrl).toBe('signed');
    expect(setup.storage.mock.calls.map(([bucket]) => bucket)).toEqual(['comic-private', 'comic-private']);
    expect(setup.upload).toHaveBeenCalledWith(
      result.imageId,
      expect.any(Buffer),
      expect.objectContaining({ upsert: false, cacheControl: '0' })
    );
    expect(setup.insert).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'comic-private', user_id: owner, path: result.imageId }));
    expect(setup.createSignedUrl).toHaveBeenCalledWith(result.imageId, 300);
    expect(setup.getPublicUrl).not.toHaveBeenCalled();
  });
  it('retains the ordinary public classic result and private standalone result', async () => {
    expect((await generate()).imageUrl).toBe('public');
    expect(setup.storage).toHaveBeenCalledWith('comic-assets');
    const standalone = await generate({ standalone: true });
    expect(standalone.imageUrl).toBe('signed');
    expect(setup.createSignedUrl).toHaveBeenCalledWith(standalone.imageId, 3600);
    expect(setup.rpc).toHaveBeenCalledTimes(1);
  });
  it('never writes or publishes a project image when its bucket cannot be verified', async () => {
    setup.rpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: { code: 'unavailable' } }) });
    await expect(generate()).rejects.toMatchObject({ status: 503 });
    expect(setup.storage).not.toHaveBeenCalled();
    expect(setup.insert).not.toHaveBeenCalled();
  });
});
