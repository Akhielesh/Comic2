// Read tab: the finished comic in the reader, with the export actions — Print / PDF
// (vector lettering, full-resolution art) and a ZIP of PNG pages — and honest progress
// and failure reporting for both.

import React, { useEffect, useRef, useState } from 'react';
import { FileArchive, Printer, X } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import { openPrintView } from '../export/printView';
import { exportPngZip } from '../export/zipExport';
import { ComicReaderView } from '../reader/ComicReaderView';
import { GhostButton, cx } from './ui';

type ExportState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; done?: number; total?: number }
  | { kind: 'done'; text: string; tone: 'success' | 'warn' }
  | { kind: 'error'; text: string };

export const ReaderTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      abort.current?.abort();
    },
    []
  );
  const set = (s: ExportState) => mounted.current && setState(s);
  const working = state.kind === 'working';
  const drawn = !!doc.cover.render.asset?.path || doc.pages.some((p) => !!p.render.asset?.path);

  const print = () => {
    set({ kind: 'working', label: 'Opening the print view…' });
    // Opened synchronously inside the click so pop-up blockers allow it.
    openPrintView(doc, studio.urlFor, { onStatus: (label) => set({ kind: 'working', label }) })
      .then((r) => {
        const notes = [...r.skipped, ...r.failedImages.map((f) => `${f} (didn’t load)`)];
        set(
          notes.length
            ? { kind: 'done', tone: 'warn', text: `Print view ready with ${r.pages} pages. Not included: ${notes.join(', ')}.` }
            : { kind: 'done', tone: 'success', text: `Print view ready — choose “Save as PDF” in the dialog for a PDF.` }
        );
      })
      .catch((err: Error) => set({ kind: 'error', text: err?.message || 'Couldn’t open the print view.' }));
  };

  const zip = () => {
    const controller = new AbortController();
    abort.current = controller;
    set({ kind: 'working', label: 'Preparing pages…' });
    exportPngZip(doc, studio.urlFor, {
      signal: controller.signal,
      onProgress: (p) => set({ kind: 'working', label: p.label, done: p.done, total: p.total })
    })
      .then((r) => {
        const notes = [...r.failed.map((f) => `${f.label}: ${f.message}`), ...r.skipped];
        set(
          notes.length
            ? { kind: 'done', tone: 'warn', text: `Downloaded ${r.fileName} with ${r.files} images. Left out — ${notes.join('; ')}` }
            : { kind: 'done', tone: 'success', text: `Downloaded ${r.fileName} (${r.files} images).` }
        );
      })
      .catch((err: Error) => set({ kind: 'error', text: err?.message || 'Export failed.' }))
      .finally(() => {
        if (abort.current === controller) abort.current = null;
      });
  };

  const tools = (
    <>
      <GhostButton size="xs" disabled={!drawn || working} onClick={print} title="Print, or save a PDF with crisp vector lettering">
        <Printer className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Print / PDF</span>
      </GhostButton>
      <GhostButton size="xs" disabled={!drawn || working} onClick={zip} title="Download every page as a lettered PNG (ZIP)">
        <FileArchive className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">PNG pages</span>
      </GhostButton>
    </>
  );

  return (
    <div className="flex h-full min-h-[520px] flex-col">
      {state.kind !== 'idle' && (
        <div
          role={state.kind === 'error' ? 'alert' : 'status'}
          className={cx(
            'mx-3 mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] leading-snug text-[var(--ds-ink)]',
            state.kind === 'error'
              ? 'border-red-500/25 bg-red-500/[0.06]'
              : state.kind === 'done' && state.tone === 'warn'
                ? 'border-amber-500/30 bg-amber-500/[0.08]'
                : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]'
          )}
        >
          <div className="min-w-0 flex-1">
            <p>{state.kind === 'working' ? state.label : state.text}</p>
            {state.kind === 'working' && state.total ? (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--ds-well-strong)]" aria-hidden>
                <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-300" style={{ width: `${((state.done || 0) / state.total) * 100}%` }} />
              </div>
            ) : null}
          </div>
          {state.kind === 'working' && abort.current ? (
            <GhostButton size="xs" onClick={() => abort.current?.abort()}>
              Cancel
            </GhostButton>
          ) : state.kind !== 'working' ? (
            <button type="button" aria-label="Dismiss" onClick={() => set({ kind: 'idle' })} className="grid h-6 w-6 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ComicReaderView doc={doc} urlFor={studio.urlFor} toolbarExtra={tools} autoFocus={false} />
      </div>
    </div>
  );
};
