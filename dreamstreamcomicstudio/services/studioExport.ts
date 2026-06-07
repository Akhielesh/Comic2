// Code Studio export helpers — richer "take it with you" options beyond the .zip download.
// projectToMarkdown is pure (unit-tested); the DOM helpers are best-effort and no-op server-side.

import type { CodeStudioArtifact } from '../apiTypes';

const slug = (s: string): string =>
  (s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

const langOf = (path: string, fallback?: string): string =>
  fallback || path.split('.').pop()?.toLowerCase() || '';

/** Render the whole project as a single Markdown document (great for sharing / pasting into a chat). */
export const projectToMarkdown = (artifact: CodeStudioArtifact): string => {
  const header =
    `# ${artifact.title || 'Project'}\n\n` +
    (artifact.description ? `${artifact.description}\n\n` : '') +
    `_Template: ${artifact.template} · ${artifact.files.length} file${artifact.files.length === 1 ? '' : 's'}_\n`;
  const toc = artifact.files.length > 1
    ? `\n## Files\n${artifact.files.map((f) => `- \`${f.path}\``).join('\n')}\n`
    : '';
  const body = artifact.files
    .map((f) => `\n## ${f.path}\n\n\`\`\`${langOf(f.path, f.language)}\n${f.content}\n\`\`\``)
    .join('\n');
  return `${header}${toc}${body}\n`;
};

/** Trigger a client-side download of text content. No-op outside the browser. */
export const downloadText = (filename: string, text: string, mime = 'text/plain'): void => {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch { /* best-effort */ }
};

/** Download the project as one Markdown file. */
export const exportProjectMarkdown = (artifact: CodeStudioArtifact): void =>
  downloadText(`${slug(artifact.title)}.md`, projectToMarkdown(artifact), 'text/markdown');

/** Open the live preview in a new tab and invoke the browser's print dialog (→ "Save as PDF"). */
export const printPreview = (previewUrl?: string | null): void => {
  if (typeof window === 'undefined') return;
  try {
    if (previewUrl) {
      const w = window.open(previewUrl, '_blank', 'noopener');
      // Give the preview a moment to render before printing.
      if (w) setTimeout(() => { try { w.print(); } catch { /* cross-origin: user prints manually */ } }, 1200);
    } else {
      window.print();
    }
  } catch { /* best-effort */ }
};
