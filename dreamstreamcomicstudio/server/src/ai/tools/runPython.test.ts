import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { makeRunPythonTool } from './runPython.js';
import type { ToolContext } from './types.js';

// These use the REAL Pyodide runtime, which lazy-loads CPython/WASM (and fetches the
// Pillow wheel on first use) — that takes ~10-30s, so the timeouts below are generous.

const pngAttachmentCtx = async (name = 'in.png'): Promise<ToolContext> => {
  const buf = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();
  return { attachments: [{ name, mimeType: 'image/png', dataUri: `data:image/png;base64,${buf.toString('base64')}` }] };
};

const decode = (dataUri: string): Buffer => Buffer.from(dataUri.split(',')[1], 'base64');

describe('run_python tool', () => {
  it(
    'reads an attached PNG and writes a real JPEG to /output',
    async () => {
      const ctx = await pngAttachmentCtx();
      const res = await makeRunPythonTool(ctx).execute({
        code: "from PIL import Image; Image.open('/input/in.png').save('/output/out.jpg')"
      });
      expect(res.images?.[0].url).toMatch(/^data:image\/jpeg;base64,/);
      const meta = await sharp(decode(res.images![0].url)).metadata();
      expect(meta.format).toBe('jpeg');
    },
    60000
  );

  it(
    'returns stdout from print()',
    async () => {
      const res = await makeRunPythonTool().execute({ code: "print('hello world')" });
      expect(res.content).toContain('hello world');
    },
    60000
  );

  it(
    'surfaces a Python error with an error notice',
    async () => {
      const res = await makeRunPythonTool().execute({ code: "raise ValueError('boom')" });
      expect(res.notice?.level).toBe('error');
      expect(res.content).toMatch(/boom|ValueError/);
    },
    60000
  );
});
