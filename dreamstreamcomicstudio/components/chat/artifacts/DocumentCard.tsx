import React, { useRef, useState } from 'react';
import { FileText, Download, Printer, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { downloadTextFile } from '../../../services/chatUtils';
import type { DocumentArtifact } from '../../../apiTypes';

// A custom document the AI authored, rendered inline with download/print actions so
// the user can keep it as a real resource (.md / .html / PDF).

const safeName = (s: string) =>
  (s || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

const buildHtml = (title: string, bodyHtml: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>` +
  `<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}` +
  `h1,h2,h3{line-height:1.25}pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto}` +
  `code{background:#f4f4f5;padding:2px 4px;border-radius:4px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}` +
  `blockquote{border-left:4px solid #ddd;margin:0;padding-left:16px;color:#555}img{max-width:100%}</style></head>` +
  `<body><h1>${title.replace(/</g, '&lt;')}</h1>${bodyHtml}</body></html>`;

export const DocumentCard: React.FC<{ data: DocumentArtifact }> = ({ data }) => {
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

  return (
    <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden animate-fade-in">
      <div className="bg-slate-900 text-white px-4 py-2.5 flex items-center gap-2">
        <FileText className="w-5 h-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg leading-tight truncate">{data.title}</div>
          {data.subtitle && <div className="text-[11px] text-white/70 truncate">{data.subtitle}</div>}
        </div>
        <button onClick={() => setExpanded((v) => !v)} className="text-white/80 hover:text-white" title={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {expanded && (
        <div ref={bodyRef} className="p-4 max-h-[28rem] overflow-y-auto text-sm">
          <ChatMarkdown text={data.content || ''} />
        </div>
      )}

      <div className="border-t-2 border-black bg-slate-50 px-3 py-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto">Download</span>
        <button onClick={downloadMd} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100"><Download className="w-3.5 h-3.5" /> .md</button>
        <button onClick={downloadHtml} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100"><Download className="w-3.5 h-3.5" /> .html</button>
        <button onClick={printPdf} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100"><Printer className="w-3.5 h-3.5" /> PDF</button>
        <button onClick={copyMd} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100">{copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <FileText className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
};
