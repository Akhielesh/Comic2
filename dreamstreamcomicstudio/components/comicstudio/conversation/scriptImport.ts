// Script import — turn the files writers actually have into plain text the Comic
// Director can read: Word (.docx via mammoth, BSD-2), PDF (.pdf via pdf.js, Apache-2.0),
// Final Draft (.fdx, XML) and Fountain (.fountain), plus .txt/.md. Everything runs in
// the browser and the parsers load only when such a file is attached, so the studio's
// first load stays light and no document is ever uploaded just to be read.

export type ScriptFileKind = 'docx' | 'pdf' | 'fdx' | 'fountain' | 'text';

export interface ImportedScript {
  name: string;
  kind: ScriptFileKind;
  text: string;
  /** True when the text was cut at MAX_SCRIPT_CHARS. */
  truncated: boolean;
}

export const MAX_SCRIPT_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_SCRIPT_CHARS = 200_000;
const MAX_PDF_PAGES = 300;

export class ScriptImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptImportError';
  }
}

/** Which importer handles a file (by extension first, then MIME). Null = not a script file. */
export const scriptKindOf = (name: string, mimeType = ''): ScriptFileKind | null => {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === 'fdx') return 'fdx';
  if (ext === 'fountain' || ext === 'spmd') return 'fountain';
  if (['txt', 'md', 'markdown', 'text'].includes(ext) || mimeType.startsWith('text/')) return 'text';
  return null;
};

/** File input `accept` list for the composer. */
export const SCRIPT_ACCEPT = '.txt,.md,.markdown,.fountain,.fdx,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Collapse extraction noise: trailing spaces, 3+ blank lines, odd whitespace. */
export const tidyScript = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Final Draft XML → screenplay-style plain text. Scene headings and character cues in
 * caps, dialogue under its speaker, parentheticals kept, transitions right where they are.
 */
export const fdxToText = (xml: string): string => {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length) throw new ScriptImportError('That Final Draft file couldn’t be read.');
  const out: string[] = [];
  const paragraphs = Array.from(parsed.getElementsByTagName('Paragraph'));
  for (const p of paragraphs) {
    // Skip paragraphs inside title pages / headers.
    if (p.closest('TitlePage, HeaderAndFooter')) continue;
    const type = p.getAttribute('Type') || 'Action';
    const text = Array.from(p.getElementsByTagName('Text'))
      .map((t) => t.textContent || '')
      .join('')
      .trim();
    if (!text) continue;
    switch (type) {
      case 'Scene Heading':
        out.push('', text.toUpperCase(), '');
        break;
      case 'Character':
        out.push('', text.toUpperCase());
        break;
      case 'Parenthetical':
        out.push(text.startsWith('(') ? text : `(${text})`);
        break;
      case 'Dialogue':
        out.push(text);
        break;
      case 'Transition':
        out.push('', text.toUpperCase(), '');
        break;
      default:
        out.push('', text);
    }
  }
  return tidyScript(out.join('\n'));
};

const readBuffer = (file: Blob): Promise<ArrayBuffer> =>
  typeof file.arrayBuffer === 'function'
    ? file.arrayBuffer()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });

const readText = async (file: Blob): Promise<string> => new TextDecoder('utf-8').decode(await readBuffer(file));

const docxToText = async (file: Blob): Promise<string> => {
  const mammoth = await import('mammoth');
  const lib = (mammoth as unknown as { default?: typeof mammoth }).default || mammoth;
  const arrayBuffer = await readBuffer(file);
  // The browser build reads `arrayBuffer`; mammoth's Node build (tests, SSR) reads `buffer`.
  const NodeBuffer = (globalThis as { Buffer?: { from(ab: ArrayBuffer): unknown } }).Buffer;
  const input = { arrayBuffer, ...(NodeBuffer ? { buffer: NodeBuffer.from(arrayBuffer) } : {}) } as { arrayBuffer: ArrayBuffer };
  const result = await lib.extractRawText(input);
  return result.value;
};

const pdfToText = async (file: Blob): Promise<string> => {
  // The legacy build polyfills newer JS (Promise.try etc.) for Safari < 18.2 and older engines.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Use a dedicated worker ONLY in a real browser, where the module is served over http(s)
  // and the worker loads cheaply. In Node/test/SSR (a file:// module URL) — and in any
  // context where spawning a worker fails (strict CSP, resource-starved CI) — leave
  // workerSrc unset so pdf.js parses on the main thread. That is deterministic and
  // worker-spawn-free; the worker is only a performance optimization, not a requirement.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    let workerUrl = '';
    try {
      workerUrl = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
    } catch {
      /* URL not resolvable here — fall back to the main thread */
    }
    if (/^https?:/i.test(workerUrl)) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await readBuffer(file)) });
  const pdf = await task.promise;
  try {
    const pages: string[] = [];
    const count = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= count; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      page.cleanup();
    }
    const text = pages.join('\n\n');
    if (!text.trim()) throw new ScriptImportError('That PDF has no selectable text (it may be scanned images). Paste the text instead.');
    return text;
  } finally {
    await task.destroy();
  }
};

/** Extract a script file's text. Throws ScriptImportError with a user-ready message. */
export async function importScriptFile(file: File): Promise<ImportedScript> {
  const kind = scriptKindOf(file.name, file.type);
  if (!kind) throw new ScriptImportError(`“${file.name}” isn’t a script file. Use .docx, .pdf, .fdx, .fountain, .txt or .md.`);
  if (file.size > MAX_SCRIPT_FILE_BYTES) throw new ScriptImportError(`“${file.name}” is larger than 15 MB.`);
  let raw: string;
  try {
    switch (kind) {
      case 'docx':
        raw = await docxToText(file);
        break;
      case 'pdf':
        raw = await pdfToText(file);
        break;
      case 'fdx':
        raw = fdxToText(await readText(file));
        break;
      default:
        raw = await readText(file);
    }
  } catch (err) {
    if (err instanceof ScriptImportError) throw err;
    throw new ScriptImportError(`“${file.name}” couldn’t be read. ${kind === 'docx' ? 'Is it a Word .docx (not .doc)?' : 'Try saving it again or paste the text.'}`);
  }
  const text = tidyScript(raw);
  if (!text) throw new ScriptImportError(`“${file.name}” is empty.`);
  const truncated = text.length > MAX_SCRIPT_CHARS;
  return { name: file.name, kind, text: truncated ? text.slice(0, MAX_SCRIPT_CHARS) : text, truncated };
}
