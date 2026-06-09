import type { ChatTool, ToolContext } from './types.js';
import { runPython, type RunPythonFile } from '../../services/pyodideRunner.js';

// `run_python` — the model AUTHORS Python; it runs in a sandboxed Pyodide (CPython/WASM)
// runtime that can compute, convert/transform data, and convert/resize/modify images
// (Pillow, numpy, pandas available). User-attached files are exposed read-only at
// /input/<name>; whatever the code writes to /output/ is returned (text inline, images
// shown to the user). Pyodide is memory-sandboxed — no host filesystem or network access.

const MAX_FILES = 6;
const MAX_FILE_BYTES = 16 * 1024 * 1024; // 16MB per attachment
const STDOUT_CAP = 6_000; // chars of stdout fed back to the model
const INLINE_TEXT_CAP = 2_000; // small text/data outputs are echoed inline

const DESCRIPTION =
  "Write and run Python to solve a task with real code — compute, convert/transform data, or convert/resize/modify images. Pillow, numpy and pandas are available. READ attached files from /input/ (their names are listed for you), WRITE result files to /output/, and print logs to stdout. Returns your stdout and any images/files you wrote to /output. Use for 'convert this image to png', 'process/transform this file', or custom calculations. Example: `from PIL import Image; Image.open('/input/photo.jpg').save('/output/photo.png')`.";

const IMAGE_MIME = /^image\//;

// Decode a base64 data URI ("data:<mime>;base64,<...>") into bytes. Returns null if
// the input isn't a base64 data URI we can decode.
const decodeDataUri = (dataUri: string): Uint8Array | null => {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(dataUri);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], 'base64');
    return buf.length ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  } catch {
    return null;
  }
};

export const makeRunPythonTool = (ctx?: ToolContext): ChatTool => ({
  name: 'run_python',
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The Python to run.' }
    },
    required: ['code']
  },
  execute: async (args) => {
    const code = typeof args?.code === 'string' ? args.code : '';
    if (!code.trim()) return { content: 'No Python code was provided to run.' };

    // Decode the current turn's attachments into sandbox input files.
    const files: RunPythonFile[] = [];
    for (const att of ctx?.attachments ?? []) {
      if (files.length >= MAX_FILES) break;
      if (!att || typeof att.name !== 'string' || typeof att.dataUri !== 'string') continue;
      const bytes = decodeDataUri(att.dataUri);
      if (!bytes || bytes.length > MAX_FILE_BYTES) continue;
      files.push({ name: att.name, bytes });
    }

    // Tell the model exactly which files it can open (it can't see the disk otherwise).
    const codeWithFiles = files.length
      ? `# Available input files: ${files.map((f) => `/input/${f.name}`).join(', ')}\n${code}`
      : code;

    let res;
    try {
      res = await runPython({ code: codeWithFiles, files, timeoutMs: 15_000 });
    } catch (err) {
      return {
        content: `The Python runtime could not start: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Python runtime unavailable' }
      };
    }

    const parts: string[] = [];
    const images: { url: string; title?: string }[] = [];

    const stdout = res.stdout.trim();
    if (stdout) parts.push(stdout.length > STDOUT_CAP ? `${stdout.slice(0, STDOUT_CAP)}\n…(stdout truncated)` : stdout);

    if (res.outputs.length) {
      parts.push(`Wrote ${res.outputs.length} file(s) to /output: ${res.outputs.map((o) => o.name).join(', ')}.`);
    }

    for (const out of res.outputs) {
      const b64 = Buffer.from(out.bytes).toString('base64');
      if (IMAGE_MIME.test(out.mimeType)) {
        images.push({ url: `data:${out.mimeType};base64,${b64}`, title: out.name });
      } else if (out.bytes.length <= INLINE_TEXT_CAP && /^(text\/|application\/json)/.test(out.mimeType)) {
        // Echo small text/data results inline so the model can reason over them.
        const text = Buffer.from(out.bytes).toString('utf8');
        parts.push(`--- ${out.name} ---\n${text}`);
      }
    }

    let notice: { level: 'info' | 'warn' | 'error'; message: string } | undefined;
    if (res.error) {
      parts.push(`Python error:\n${res.error}`);
      if (res.stderr && !res.stderr.includes(res.error)) parts.push(res.stderr);
      notice = { level: 'error', message: 'Python error' };
    }

    if (!parts.length) {
      parts.push('The code ran but printed nothing and produced no /output files.');
    }

    const result: {
      content: string;
      images?: { url: string; title?: string }[];
      notice?: { level: 'info' | 'warn' | 'error'; message: string };
    } = { content: parts.join('\n\n') };
    if (images.length) result.images = images;
    if (notice) result.notice = notice;
    return result;
  }
});

export const runPythonTool = makeRunPythonTool();
