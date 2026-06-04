// Small helpers for the chat UI: rough context-token estimation, code-block
// extraction (for download / zip), and client-side file downloads.

import type { CodeStudioArtifact, CodeStudioFile, CodeStudioTemplate } from '../apiTypes';

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

// Web-runnable code that the live Studio (WebContainer/Sandpack) can actually build.
const WEB_RUNNABLE_LANGS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'html', 'htm', 'css'
]);

const langToStudioLanguage = (lang: string): string => {
  const l = (lang || '').toLowerCase();
  if (l === 'tsx' || l === 'ts' || l === 'typescript') return 'typescript';
  if (l === 'jsx' || l === 'js' || l === 'javascript') return 'javascript';
  if (l === 'htm' || l === 'html') return 'html';
  if (l === 'css' || l === 'scss' || l === 'less') return 'css';
  return l || 'text';
};

const looksLikeHtmlDoc = (block: ExtractedCodeBlock): boolean =>
  /^(html|htm)$/.test((block.lang || '').toLowerCase()) || /^\s*<(?:!doctype|html)/i.test(block.code);

/**
 * Build a runnable CodeStudio project from a message's fenced code blocks.
 *
 * This is the fallback path for when a model writes an app as Markdown code blocks
 * instead of calling the `generate_app` tool — which is the common case for NVIDIA
 * and the many free models that can't function-call. It lets the chat surface the
 * SAME "Build in Studio / Quick preview / .zip" affordances regardless of whether the
 * tool fired, so the full Code Studio is reachable from every model.
 *
 * Returns null when the blocks don't constitute a web-runnable app (e.g. a lone bash
 * or Python snippet), so we never offer a misleading "Build in Studio" CTA.
 */
export const buildStudioArtifact = (
  blocks: ExtractedCodeBlock[],
  title = 'Generated app'
): CodeStudioArtifact | null => {
  const web = blocks.filter((b) => WEB_RUNNABLE_LANGS.has((b.lang || '').toLowerCase()) || looksLikeHtmlDoc(b));
  if (!web.length) return null;

  // Require something that actually looks like an app, not a throwaway 3-line snippet,
  // so the CTA only appears when building it is genuinely useful.
  const totalLen = web.reduce((n, b) => n + b.code.length, 0);
  const looksLikeApp =
    web.length > 1 ||
    totalLen >= 200 ||
    web.some((b) => /export\s+default|createRoot|ReactDOM|<[A-Za-z][^>]*>/.test(b.code));
  if (!looksLikeApp) return null;

  // A self-contained HTML document → a static site whose index.html is the entry.
  const htmlBlock = web.find(looksLikeHtmlDoc);
  if (htmlBlock) {
    const files: CodeStudioFile[] = [{ path: '/index.html', content: htmlBlock.code, language: 'html' }];
    web
      .filter((b) => b !== htmlBlock && !looksLikeHtmlDoc(b))
      .forEach((b, i) => {
        const name = codeBlockFilename(b, i);
        files.push({
          path: name.startsWith('/') ? name : `/${name}`,
          content: b.code,
          language: langToStudioLanguage(b.lang)
        });
      });
    return { title, files, template: 'static' };
  }

  // Otherwise reuse the playground packer (it promotes a React entry to /App.tsx) and
  // map the resulting files into the CodeStudio shape.
  const { files, template } = buildPlaygroundFiles(web);
  const studioFiles: CodeStudioFile[] = Object.entries(files).map(([path, content]) => ({
    path,
    content,
    language: langToStudioLanguage(path.split('.').pop() || '')
  }));
  return { title, files: studioFiles, template: template as CodeStudioTemplate };
};
