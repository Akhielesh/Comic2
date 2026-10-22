import React, { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronUp, Download, FileCode2 } from 'lucide-react';
import type { LegacyCodeStudioArtifact } from '../../../apiTypes';
import { Surface, SurfaceSubtitle, SurfaceTitle, useCompact } from './kit';

// Apps made with Code Studio (retired 2026-10-22, ADR 0005) still live in old chats. The
// builder and its live preview are gone, but the code is the user's: show it read-only and
// let them download it as a .zip so nothing they made disappears.

const safeName = (s: string) => (s || 'app').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'app';
const cleanPath = (p: string) => p.replace(/^\/+/, '').replace(/\.\.(\/|\\)/g, '');

export const LegacyCodeStudioCard: React.FC<{ data: LegacyCodeStudioArtifact }> = ({ data }) => {
  const compact = useCompact();
  const files = useMemo(
    () => (Array.isArray(data?.files) ? data.files.filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string') : []),
    [data]
  );
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = files.reduce((n, f) => n + f.content.split('\n').length, 0);

  const downloadZip = async () => {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const f of files) zip.file(cleanPath(f.path) || 'file.txt', f.content);
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName(data.title)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-well-strong)] text-[var(--ds-ink)]">
        <FileCode2 className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <SurfaceTitle>{data?.title || 'App'}</SurfaceTitle>
        <SurfaceSubtitle>Made with Code Studio (retired) · {files.length} {files.length === 1 ? 'file' : 'files'}</SurfaceSubtitle>
      </div>
    </div>
  );
  const zipButton = (
    <button
      onClick={() => void downloadZip()}
      disabled={!files.length || busy}
      title="Download the code as a .zip"
      className="flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-well)] disabled:opacity-50"
    >
      {busy ? <Archive className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />} .zip
    </button>
  );

  if (compact) {
    return (
      <Surface header={header} right={zipButton}>
        <p className="px-3 pb-3 text-[11px] leading-snug text-[var(--ds-muted)] line-clamp-2">
          {data?.description || `${lines.toLocaleString()} lines of code — download to keep working on it.`}
        </p>
      </Surface>
    );
  }

  return (
    <Surface header={header} right={zipButton}>
      <div className="px-3 pb-3">
        <p className="mb-2 text-[12px] leading-snug text-[var(--ds-muted)]">
          {data?.description ? `${data.description} ` : ''}The live preview went with Code Studio — your code is all here.
        </p>
        <ul className="divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline)]">
          {files.map((f) => {
            const isOpen = open === f.path;
            return (
              <li key={f.path}>
                <button
                  onClick={() => setOpen(isOpen ? null : f.path)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{cleanPath(f.path)}</span>
                  <span className="tabular-nums text-[10px] text-[var(--ds-muted)]">{f.content.split('\n').length} lines</span>
                  {isOpen ? <ChevronUp className="h-3.5 w-3.5 text-[var(--ds-muted)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--ds-muted)]" />}
                </button>
                {isOpen && (
                  <pre className="max-h-80 overflow-auto bg-[var(--ds-well)] px-3 py-2 text-[11px] leading-relaxed text-[var(--ds-ink)]">
                    <code>{f.content}</code>
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Surface>
  );
};
