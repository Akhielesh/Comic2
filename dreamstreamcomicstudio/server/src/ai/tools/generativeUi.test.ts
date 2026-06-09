import { describe, it, expect } from 'vitest';
import { generativeUiTool } from './generativeUi.js';

const run = (args: Record<string, unknown>) => generativeUiTool.execute(args, new AbortController().signal);

describe('render_ui tool', () => {
  it('returns a generative_ui artifact for a valid root', async () => {
    const res = await run({ title: 'X', root: { kind: 'stack', children: [{ kind: 'heading', text: 'Hi' }] } });
    expect(res.artifacts?.[0]).toMatchObject({ type: 'generative_ui' });
    const data = res.artifacts![0].data as { root: { kind: string }; title?: string };
    expect(data.root.kind).toBe('stack');
    expect(data.title).toBe('X');
  });

  it('rejects a missing root without producing an artifact', async () => {
    const res = await run({});
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/root/i);
  });

  it('rejects an oversized tree (node cap)', async () => {
    const children = Array.from({ length: 300 }, () => ({ kind: 'divider' }));
    const res = await run({ root: { kind: 'stack', children } });
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/too large/i);
  });
});
