import React from 'react';
import { Package, Download, FileText, FileCode, FileSpreadsheet, Braces, File } from 'lucide-react';
import { downloadTextFile, triggerDownload } from '../../../services/chatUtils';
import { createZipBlob } from '../../../services/zip';
import type { ResourceBundleArtifact, BundleFile } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle } from './kit';

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
    <Surface
      header={
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600">
            <Package className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <SurfaceTitle>{data.title || 'Resource bundle'}</SurfaceTitle>
            {data.description && <SurfaceSubtitle>{data.description}</SurfaceSubtitle>}
          </div>
        </div>
      }
      right={
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      }
      footer={
        <div className="flex items-center gap-2">
          <span className="mr-auto text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Download all as one file</span>
          <button
            onClick={downloadZip}
            disabled={files.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-[#1a1915] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors duration-200 hover:bg-black disabled:opacity-40"
          >
            <Download className="h-4 w-4" /> {base}.zip
          </button>
        </div>
      }
    >
      <ul className="divide-y divide-black/5 border-t border-black/5">
        {files.map((f, i) => {
          const Icon = iconFor(f.name);
          return (
            <li key={i} className="flex items-center gap-2.5 px-3 py-2.5 transition-colors duration-200 hover:bg-black/[0.03]">
              <Icon className="h-4 w-4 shrink-0 text-[#6e6a60]" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] font-medium text-[#1a1915]">{f.name}</div>
                {f.label && <div className="truncate text-[11px] text-[#6e6a60]">{f.label}</div>}
              </div>
              <span className="shrink-0 text-[10px] tabular-nums text-[#6e6a60]">{sizeLabel(f.content)}</span>
              <button
                onClick={() => downloadOne(f)}
                className="shrink-0 rounded-lg border border-black/10 bg-white p-1.5 text-[#6e6a60] transition-colors duration-200 hover:bg-black/[0.03] hover:text-[#1a1915]"
                title={`Download ${f.name}`}
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
        {files.length === 0 && <li className="px-3 py-3 text-[13px] text-[#6e6a60]">This bundle has no files.</li>}
      </ul>
    </Surface>
  );
};
