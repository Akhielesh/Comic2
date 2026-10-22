// Read tab: the finished comic in the reader, with the export actions and honest progress
// and failure reporting for each —
//   • Print   — the browser print view (crisp vector lettering, choose "Save as PDF")
//   • PDF      — a print-ready PDF downloaded directly, no dialog (@cantoo/pdf-lib)
//   • PNG      — a ZIP of lettered PNG pages
//   • Motion   — an animated "motion comic" video (9:16 / 1:1 / 16:9) for social/sharing

import React, { useEffect, useRef, useState } from 'react';
import { Clapperboard, FileArchive, FileDown, Printer, X } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import { openPrintView } from '../export/printView';
import { exportPngZip } from '../export/zipExport';
import { exportComicPdf } from '../export/pdfExport';
import { exportMotionComic, MOTION_SIZES, type MotionAspect } from '../export/motionComic';
import { ComicReaderView } from '../reader/ComicReaderView';
import { GhostButton, cx } from './ui';

const MOTION_ASPECTS: { aspect: MotionAspect; label: string }[] = [
  { aspect: '9:16', label: 'Portrait' },
  { aspect: '1:1', label: 'Square' },
  { aspect: '16:9', label: 'Wide' },
];

type ExportState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; done?: number; total?: number }
  | { kind: 'done'; text: string; tone: 'success' | 'warn' }
  | { kind: 'error'; text: string };

export const ReaderTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const [motionOpen, setMotionOpen] = useState(false);
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

  const pdf = () => {
    const controller = new AbortController();
    abort.current = controller;
    set({ kind: 'working', label: 'Preparing the PDF…' });
    exportComicPdf(doc, studio.urlFor, {
      signal: controller.signal,
      onProgress: (p) => set({ kind: 'working', label: p.label, done: p.done, total: p.total })
    })
      .then((r) => {
        const notes = [...r.failed.map((f) => `${f.label}: ${f.message}`), ...r.skipped];
        set(
          notes.length
            ? { kind: 'done', tone: 'warn', text: `Downloaded ${r.fileName} (${r.pages} pages). Left out — ${notes.join('; ')}` }
            : { kind: 'done', tone: 'success', text: `Downloaded ${r.fileName} (${r.pages} pages).` }
        );
      })
      .catch((err: Error) => set({ kind: 'error', text: err?.message || 'PDF export failed.' }))
      .finally(() => {
        if (abort.current === controller) abort.current = null;
      });
  };

  const motion = (aspect: MotionAspect) => {
    setMotionOpen(false);
    const controller = new AbortController();
    abort.current = controller;
    const { width, height } = MOTION_SIZES[aspect];
    set({ kind: 'working', label: `Building a ${aspect} motion comic (${width}×${height})…` });
    exportMotionComic(doc, studio.urlFor, {
      aspect,
      signal: controller.signal,
      onProgress: (p) => set({ kind: 'working', label: p.label, done: p.done, total: p.total })
    })
      .then((r) => {
        const secs = Math.round(r.durationMs / 100) / 10;
        const note = r.skipped.length ? ` Left out — ${r.skipped.join('; ')}.` : '';
        set({ kind: 'done', tone: r.skipped.length ? 'warn' : 'success', text: `Downloaded ${r.fileName} — ${secs}s, ${aspect}.${note}` });
      })
      .catch((err: Error) => set({ kind: 'error', text: err?.message || 'Motion export failed.' }))
      .finally(() => {
        if (abort.current === controller) abort.current = null;
      });
  };

  const tools = (
    <>
      <GhostButton size="xs" disabled={!drawn || working} onClick={print} title="Open the print view (crisp vector lettering); choose “Save as PDF” there">
        <Printer className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Print</span>
      </GhostButton>
      <GhostButton size="xs" disabled={!drawn || working} onClick={pdf} title="Download a print-ready PDF directly (no dialog)">
        <FileDown className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">PDF</span>
      </GhostButton>
      <GhostButton size="xs" disabled={!drawn || working} onClick={zip} title="Download every page as a lettered PNG (ZIP)">
        <FileArchive className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">PNG</span>
      </GhostButton>
      <div className="relative">
        <GhostButton
          size="xs"
          disabled={!drawn || working}
          onClick={() => setMotionOpen((v) => !v)}
          title="Export an animated motion comic (video) for social/sharing"
          aria-haspopup="menu"
          aria-expanded={motionOpen}
        >
          <Clapperboard className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Motion</span>
        </GhostButton>
        {motionOpen && !working && (
          <>
            <div className="fixed inset-0 z-10" aria-hidden onClick={() => setMotionOpen(false)} />
            <div
              role="menu"
              aria-label="Motion comic format"
              className="absolute right-0 z-20 mt-1.5 w-40 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-1 shadow-lg"
            >
              {MOTION_ASPECTS.map(({ aspect, label }) => (
                <button
                  key={aspect}
                  type="button"
                  role="menuitem"
                  onClick={() => motion(aspect)}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
                >
                  <span>{label}</span>
                  <span className="tabular-nums text-[11px] text-[var(--ds-muted)]">{aspect}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
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
