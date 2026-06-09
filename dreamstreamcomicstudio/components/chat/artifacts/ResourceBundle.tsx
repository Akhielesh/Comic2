import React from 'react';
import { Package, Download, FileText, FileCode, FileSpreadsheet, Braces, File } from 'lucide-react';
import { downloadTextFile, triggerDownload } from '../../../services/chatUtils';
import { createZipBlob } from '../../../services/zip';
import type { ResourceBundleArtifact, BundleFile } from '../../../apiTypes';

// A bundle of custom-built resources the AI generated. Each file can be downloaded on
// its own, or the whole set as a single .zip — so the user keeps a ready-made "kit"
// (study pack, starter project, data + notes) rather than copy-pasting from chat.

const safeName = (s: string) =>
  (s || 'resources').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'resources';

const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase();

const MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html',
  csv: 'text/csv', json: 'application/json', txt: 'text/plain', py: 'text/x-python',
  js: 'text/javascript', ts: 'text/typescript', sql: 'application/sql', css: 'text/css', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml'
};

const iconFor = (name: string) => {
  const e = extOf(name);
  if (['js', 'ts', 'py', 'sql', 'css', 'html', 'htm', 'xml'].includes(e)) return FileCode;
  if (e === 'csv') return FileSpreadsheet;
  if (e === 'json' || e === 'yaml' || e === 'yml') return Braces;
  if (['md', 'markdown', 'txt'].includes(e)) return FileText;
  return File;
};

const sizeLabel = (content: string) => {
  const bytes = new Blob([content]).size;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
};

export const ResourceBundle: React.FC<{ data: ResourceBundleArtifact }> = ({ data }) => {
  const files = (data.files || []).filter((f): f is BundleFile => Boolean(f && f.name && typeof f.content === 'string'));
  const base = safeName(data.title);

  const downloadOne = (f: BundleFile) =>
    downloadTextFile(f.name, f.content, MIME[extOf(f.name)] || 'text/plain');

  const downloadZip = () =>
    triggerDownload(`${base}.zip`, createZipBlob(files.map((f) => ({ name: f.name, content: f.content }))));

  return (
    <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden animate-fade-in">
      <div className="bg-indigo-700 text-white px-4 py-2.5 flex items-center gap-2">
        <Package className="w-5 h-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg leading-tight truncate">{data.title || 'Resource bundle'}</div>
          {data.description && <div className="text-[11px] text-white/70 truncate">{data.description}</div>}
        </div>
        <span className="text-[10px] font-bold uppercase tracking-wide bg-white/20 px-1.5 py-0.5 rounded">{files.length} file{files.length === 1 ? '' : 's'}</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {files.map((f, i) => {
          const Icon = iconFor(f.name);
          return (
            <li key={i} className="flex items-center gap-2.5 px-4 py-2.5">
              <Icon className="w-4 h-4 shrink-0 text-slate-500" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] font-semibold truncate">{f.name}</div>
                {f.label && <div className="text-[11px] text-slate-500 truncate">{f.label}</div>}
              </div>
              <span className="text-[10px] text-slate-400 tabular-nums shrink-0">{sizeLabel(f.content)}</span>
              <button
                onClick={() => downloadOne(f)}
                className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100 shrink-0"
                title={`Download ${f.name}`}
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </li>
          );
        })}
        {files.length === 0 && <li className="px-4 py-3 text-[13px] text-slate-500">This bundle has no files.</li>}
      </ul>

      <div className="border-t-2 border-black bg-slate-50 px-3 py-2 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto">Download all as one file</span>
        <button
          onClick={downloadZip}
          disabled={files.length === 0}
          className="flex items-center gap-1.5 text-[12px] font-bold border-2 border-black rounded-md px-3 py-1.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40"
        >
          <Download className="w-4 h-4" /> {base}.zip
        </button>
      </div>
    </div>
  );
};
