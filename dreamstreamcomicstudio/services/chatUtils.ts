// Small helpers for the chat UI: rough context-token estimation, code-block
// extraction (for download / zip), and client-side file downloads.

export interface ExtractedCodeBlock {
  lang: string;
  code: string;
  filename?: string;
}

/** Rough token estimate (~4 chars/token). Good enough for a context-usage gauge. */
export const estimateTokens = (text: string): number => Math.ceil((text || '').length / 4);

/** Map a fenced-code language hint to a sensible file extension. */
export const languageToExt = (lang: string): string => {
  const l = (lang || '').toLowerCase();
  const map: Record<string, string> = {
    javascript: 'js', js: 'js', jsx: 'jsx',
    typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py',
    json: 'json', html: 'html', xml: 'xml', css: 'css', scss: 'scss',
    bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
    java: 'java', kotlin: 'kt', swift: 'swift',
    go: 'go', golang: 'go', rust: 'rs', rs: 'rs',
    ruby: 'rb', rb: 'rb', php: 'php',
    'c++': 'cpp', cpp: 'cpp', c: 'c', 'c#': 'cs', csharp: 'cs',
    sql: 'sql', yaml: 'yaml', yml: 'yml', toml: 'toml', ini: 'ini',
    markdown: 'md', md: 'md', text: 'txt', plaintext: 'txt'
  };
  return map[l] || 'txt';
};

// A model often names a file with a leading comment, e.g. `// src/app.ts` or `# main.py`.
const FILENAME_HINT = /^\s*(?:\/\/|#|<!--|;|--)\s*([\w./-]+\.[A-Za-z0-9]+)\s*(?:-->)?\s*$/;

/** Extract fenced code blocks from a markdown string, with optional filename hints. */
export const extractCodeBlocks = (markdown: string): ExtractedCodeBlock[] => {
  const blocks: ExtractedCodeBlock[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const lang = (match[1] || '').trim().split(/\s+/)[0] || '';
    const code = match[2].replace(/\n$/, '');
    const firstLine = code.split('\n')[0] || '';
    const hint = firstLine.match(FILENAME_HINT);
    blocks.push({ lang, code, filename: hint ? hint[1] : undefined });
  }
  return blocks;
};

export const downloadTextFile = (filename: string, content: string, mime = 'text/plain'): void => {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  triggerDownload(filename, blob);
};

export const triggerDownload = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Default file name for a code block based on its language + index. */
export const codeBlockFilename = (block: ExtractedCodeBlock, index: number): string =>
  block.filename || `snippet-${index + 1}.${languageToExt(block.lang)}`;

export type SandpackTemplate = 'react' | 'react-ts' | 'vanilla' | 'vanilla-ts';

/** Build a Sandpack files map + template from a message's code blocks (multi-file playground). */
export const buildPlaygroundFiles = (
  blocks: ExtractedCodeBlock[]
): { files: Record<string, string>; template: SandpackTemplate } => {
  const files: Record<string, string> = {};
  let hasTs = false;
  let hasReact = false;

  blocks.forEach((b, i) => {
    const name = codeBlockFilename(b, i);
    const path = name.startsWith('/') ? name : `/${name}`;
    files[path] = b.code;
    const l = (b.lang || '').toLowerCase();
    if (l === 'tsx' || l === 'ts' || l === 'typescript') hasTs = true;
    if (l === 'tsx' || l === 'jsx' || /from\s+['"]react['"]|import\s+React/.test(b.code)) hasReact = true;
  });

  const template: SandpackTemplate = hasReact ? (hasTs ? 'react-ts' : 'react') : hasTs ? 'vanilla-ts' : 'vanilla';

  // React templates render /App.(js|tsx). If the model didn't name one, promote the first
  // React-looking file so the preview has an entry.
  if (hasReact) {
    const appPath = hasTs ? '/App.tsx' : '/App.js';
    const hasApp = Object.keys(files).some((p) => /\/App\.(jsx?|tsx?)$/.test(p));
    if (!hasApp) {
      const firstReact =
        Object.keys(files).find((p) => /from\s+['"]react['"]|export\s+default/.test(files[p])) ||
        Object.keys(files)[0];
      if (firstReact) {
        files[appPath] = files[firstReact];
        if (firstReact !== appPath) delete files[firstReact];
      }
    }
  }

  return { files, template };
};
