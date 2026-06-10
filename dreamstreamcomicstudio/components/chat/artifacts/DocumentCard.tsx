import React, { useRef, useState } from 'react';
import { FileText, Download, Printer, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { downloadTextFile } from '../../../services/chatUtils';
import type { DocumentArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// A custom document the AI authored, in two densities:
//  • compact — title + subtitle + word count/preview line + a download affordance.
//  • detailed — the full document rendered inline with download/print actions so the
//    user keeps it as a real resource (.md / .html / PDF).

const safeName = (s: string) =>
  (s || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

const buildHtml = (title: string, bodyHtml: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>` +
  `<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}` +
  `h1,h2,h3{line-height:1.25}pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto}` +
  `code{background:#f4f4f5;padding:2px 4px;border-radius:4px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}` +
  `blockquote{border-left:4px solid #ddd;margin:0;padding-left:16px;color:#555}img{max-width:100%}</style></head>` +
  `<body><h1>${title.replace(/</g, '&lt;')}</h1>${bodyHtml}</body></html>`;

/** Approximate word count of the markdown body. */
const wordCount = (content: string): number => (content.trim() ? content.trim().split(/\s+/).length : 0);

/** First plain-text line of the document for the compact preview. */
const previewLine = (content: string): string => {
  const line = (content || '')
    .split('\n')
    .map((l) => l.replace(/[#>*_`~\-[\]()!]/g, ' ').replace(/\s+/g, ' ').trim())
    .find((l) => l.length > 0);
  return line || '';
};

const ActionButton: React.FC<{ onClick: () => void; title?: string; children: React.ReactNode }> = ({ onClick, title, children }) => (
  <button
    onClick={onClick}
    title={title}
    className="flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-well)]"
  >
    {children}
  </button>
);

export const DocumentCard: React.FC<{ data: DocumentArtifact }> = ({ data }) => {
  const compact = useCompact();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const base = safeName(data.filename || data.title);

  const downloadMd = () =>
    downloadTextFile(`${base}.md`, `# ${data.title}\n\n${data.content || ''}`, 'text/markdown');

  const downloadHtml = () => {
    const body = bodyRef.current?.innerHTML || '';
    downloadTextFile(`${base}.html`, buildHtml(data.title, body), 'text/html');
  };

  const printPdf = () => {
    const body = bodyRef.current?.innerHTML || '';
    const w = window.open('', '_blank', 'noopener,width=820,height=900');
    if (!w) return;
    w.document.write(buildHtml(data.title, body));
    w.document.close();
    // Give the new window a tick to lay out before invoking the print dialog.
    setTimeout(() => { w.focus(); w.print(); }, 250);
  };

  const copyMd = async () => {
    try { await navigator.clipboard.writeText(`# ${data.title}\n\n${data.content || ''}`); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/[0.05] text-[var(--ds-ink)]">
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <SurfaceTitle>{data.title}</SurfaceTitle>
        {data.subtitle && <SurfaceSubtitle>{data.subtitle}</SurfaceSubtitle>}
      </div>
    </div>
  );

  // ── Compact: title + preview + word count + download. ───────────────────────
  if (compact) {
    const preview = previewLine(data.content || '');
    return (
      <Surface
        header={header}
        right={
          <button
            onClick={downloadMd}
            title={`Download ${base}.md`}
            className="flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-well)]"
          >
            <Download className="h-3.5 w-3.5" /> .md
          </button>
        }
      >
        <div className="px-3 pb-3 pt-0.5">
          {preview && <p className="text-[11px] leading-snug text-[var(--ds-muted)] line-clamp-2">{preview}</p>}
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
            {wordCount(data.content || '').toLocaleString()} words
          </p>
        </div>
      </Surface>
    );
  }

  // ── Detailed: the full document + download/print/copy actions. ──────────────
  return (
    <Surface
      header={header}
      right={
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-lg p-1 text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-well)] hover:text-[var(--ds-ink)]"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Download</span>
          <ActionButton onClick={downloadMd}><Download className="h-3.5 w-3.5" /> .md</ActionButton>
          <ActionButton onClick={downloadHtml}><Download className="h-3.5 w-3.5" /> .html</ActionButton>
          <ActionButton onClick={printPdf}><Printer className="h-3.5 w-3.5" /> PDF</ActionButton>
          <ActionButton onClick={copyMd}>{copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <FileText className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}</ActionButton>
        </div>
      }
    >
      {expanded && (
        <div ref={bodyRef} className="max-h-[28rem] overflow-y-auto border-t border-[var(--ds-hairline-soft)] p-4 text-sm">
          <ChatMarkdown text={data.content || ''} />
        </div>
      )}
    </Surface>
  );
};
