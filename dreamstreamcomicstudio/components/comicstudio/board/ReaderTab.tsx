// Read tab: the finished comic in the inline reader, the immersive full-screen reader, the
// language switch, the creator's "reader look", and one "Share & export" sheet with honest
// progress and failure reporting for every export —
//   • Print   — the browser print view (crisp vector lettering, choose "Save as PDF")
//   • PDF      — a print-ready PDF downloaded directly, no dialog (@cantoo/pdf-lib)
//   • PNG      — a ZIP of lettered PNG pages
//   • Motion   — an animated "motion comic" video (9:16 / 1:1 / 16:9) for social/sharing
// Exports use the language picked in the switch (i18n.md §10.2), so "Download the Telugu PDF"
// is one tap: the SOURCE doc goes to the exporter with `{ lang }`, so files are named "…-te.pdf" and
// the script's lettering faces load for that language. "All languages (ZIP)" puts every published
// edition (or, before publishing, every ready one) in one ZIP, a folder each — sized to the device's
// memory first (export/zipMemory.ts). Every result's `notice` (a lettering font that didn't load, images
// saved smaller to fit) is shown, never swallowed. Sharing: the full Share sheet, "Copy link" once
// published, and "Preview as reader" (the live /c/ link in a new tab when published — a full
// navigation, as the enforced reader CSP requires — otherwise the owner preview with the cover intro).
//
// Wave 2 (P2-BOARD): "Read full screen" opens <ImmersiveReader> straight from the click (the
// Fullscreen API needs that user gesture); a chip, card or the director opening the reader
// (studio.readerRequest) opens it too, in Guided View when asked. The root fills the board
// (`h-full min-h-0`, no 520 px floor), so a landscape phone never scrolls the reader inside the board.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Clapperboard, Copy, Expand, Eye, FileArchive, FileDown, Languages, Printer, Share2, SlidersHorizontal, X } from 'lucide-react';
import { readerOf, type ComicDoc, type PageTurnStyle, type ReaderSettings } from '../../../shared/comic/doc';
import { DOC_LIMITS } from '../../../shared/comic/limits';
import { SHARE_PATH } from '../../../shared/comic/publication';
import { languageSpec, sameLanguage } from '../../../shared/comic/languages';
import type { ReaderRequest, StudioController } from '../types';
import { openPrintView } from '../export/printView';
import { exportLanguagesZip, exportPngZip } from '../export/zipExport';
import { collectExportSlots, exportLanguages } from '../export/sequence';
import { oneLanguageZipFits, planZipMemory } from '../export/zipMemory';
import { plateWidthFor } from '../export/batch';
import { exportComicPdf } from '../export/pdfExport';
import { exportMotionComic, MOTION_SIZES, type MotionAspect } from '../export/motionComic';
import { ImmersiveReader } from '../immersive/ImmersiveReader';
import { LanguageSwitch, languageSwitchOptions } from '../i18n/LanguageSwitch';
import { useReaderLanguage } from '../i18n/readerLanguage';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { useFormFactor } from '../mobile/useFormFactor';
import { ComicReaderView } from '../reader/ComicReaderView';
import { ShareSheet } from '../share/ShareSheet';
import { useShareCapabilities } from '../share/useShareCapabilities';
import { OVERLINE, RADIUS_CONTROL, SHADOW_SOFT } from '../../chat/studioDesign';
import { CLEAR } from './boardModel';
import { GhostButton, InlineField, PrimaryButton, Segmented, Surface, SwitchRow, cx } from './ui';

const MOTION_ASPECTS: { aspect: MotionAspect; label: string }[] = [
  { aspect: '9:16', label: 'Portrait' },
  { aspect: '1:1', label: 'Square' },
  { aspect: '16:9', label: 'Wide' }
];

type ExportState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; done?: number; total?: number }
  | { kind: 'done'; text: string; tone: 'success' | 'warn' }
  | { kind: 'error'; text: string };

const STUDIO_LANGUAGE_ENV = { search: '', stored: null, navigatorLanguages: [] as string[] };

/** "Done" text plus the honest extras: what was left out, and the export's own notice. */
export const exportDoneState = (text: string, leftOut: string[], notice?: string, extra?: string): ExportState => {
  const parts = [text];
  if (leftOut.length) parts.push(`Left out — ${leftOut.join('; ')}.`);
  if (extra) parts.push(extra);
  if (notice) parts.push(notice);
  return { kind: 'done', tone: leftOut.length || notice || extra ? 'warn' : 'success', text: parts.join(' ') };
};

/** English names, "English, Telugu and Hindi". */
const languageList = (codes: readonly string[]): string => {
  const names = codes.map((c) => languageSpec(c)?.english || c);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/** Reader requests already answered (a request object opens the reader once, even across remounts). */
const answeredRequests = new WeakSet<ReaderRequest>();

/** The live share link for a published comic, else undefined. */
export const liveShareUrl = (studio: Pick<StudioController, 'doc' | 'publication'>): string | undefined => {
  const m = studio.doc?.publication;
  if (!m || m.status !== 'live' || !m.slug) return undefined;
  // Only an http(s) link is ever opened or copied (never a javascript:/data: URL, whatever the payload says).
  const given = studio.publication?.url;
  if (given && /^https?:\/\//i.test(given)) return given;
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return `${origin}${SHARE_PATH(m.slug)}`;
};

const SHEET_ROW =
  'flex min-h-[44px] w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

const SheetRow: React.FC<{ icon: React.ReactNode; label: React.ReactNode; hint?: React.ReactNode; onClick: () => void; disabled?: boolean }> = ({ icon, label, hint, onClick, disabled }) => (
  <button type="button" className={SHEET_ROW} onClick={onClick} disabled={disabled}>
    <span className="shrink-0 text-[var(--ds-muted)]" aria-hidden>
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{label}</span>
      {hint && <span className="block text-[11.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{hint}</span>}
    </span>
  </button>
);

/** The creator's reader defaults (doc.reader): viewers can still override them locally. Free. */
export const ReaderLookPanel: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const r = readerOf(doc);
  const set = (patch: Partial<ReaderSettings>, label = 'Change reader look') => void studio.patch([{ op: 'reader', patch }], { label });
  const text = (v: string) => (v.trim() ? v.trim() : CLEAR);
  return (
    // Capped and scrollable: on a short board (a landscape phone) the panel never pushes the reader
    // out of view or gets clipped by the pane (the Read tab has no outer scroller).
    <Surface className="mx-3 mt-2 max-h-[55%] shrink-0 overflow-y-auto overscroll-contain p-3" aria-label="Reader look">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className={OVERLINE}>Reader look</p>
        <span className="text-[11px] text-[var(--ds-muted)]">Free · readers can still change it for themselves</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-2">
        <span className="text-[12px] text-[var(--ds-muted)]" id="reader-turn-label">
          Page turn
        </span>
        <Segmented<PageTurnStyle>
          label="Page turn"
          size="xs"
          value={r.turn}
          onChange={(turn) => set({ turn })}
          options={[
            { value: 'paper', label: 'Paper', title: 'A real page flip' },
            { value: 'slide', label: 'Slide', title: 'Pages slide across' },
            { value: 'fade', label: 'Fade', title: 'A soft crossfade' }
          ]}
        />
      </div>
      <div className="mt-1 grid gap-0.5 md:grid-cols-3">
        <SwitchRow label="Guided overview" description="Guided View shows the whole page before zooming into panels" checked={r.guidedOverview} onChange={(on) => set({ guidedOverview: on })} />
        <SwitchRow label="Paper texture" description="A subtle paper grain under the art" checked={r.paperTexture} onChange={(on) => set({ paperTexture: on })} />
        <SwitchRow label="Ambient room" description="The room glows with each page’s colors" checked={r.ambient} onChange={(on) => set({ ambient: on })} />
      </div>
      <div className="mt-1 grid gap-x-2 md:grid-cols-2">
        <InlineField
          label="Dedication (inside the cover)"
          showLabel
          multiline
          rows={1}
          submitOnEnter
          maxLength={DOC_LIMITS.readerTextChars}
          value={r.dedication || ''}
          placeholder="For Amma, who read me every comic twice"
          onCommit={(v) => set({ dedication: text(v) })}
        />
        <InlineField
          label="End card line"
          showLabel
          multiline
          rows={1}
          submitOnEnter
          maxLength={DOC_LIMITS.readerTextChars}
          value={r.credits || ''}
          placeholder="Story and pictures by the Rao family"
          onCommit={(v) => set({ credits: text(v) })}
        />
      </div>
    </Surface>
  );
};

export const ReaderTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [immersive, setImmersive] = useState<{ intro: boolean; guided: boolean } | null>(null);
  const sheetAnchor = useRef<HTMLSpanElement>(null);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const shareCaps = useShareCapabilities();
  // Phone landscape (ui-findings 2026-10-29, board/read at 734×343): the board pane is ~100 px tall,
  // so this tab's action row plus the reader's toolbar left the toolbar clipped under the pane. At a
  // compact height the actions fold into the reader's own toolbar (one row) and the reader's browser
  // full-screen button steps aside for "Read full screen".
  const compactH = useFormFactor().heightClass === 'compact';
  // The studio preview offers draft editions too (marked by their percentage), always opens in the
  // comic's own language (never the browser's or a reader's stored choice) and never touches the URL.
  const L = useReaderLanguage({ doc, includeDrafts: true, persist: false, env: STUDIO_LANGUAGE_ENV });
  const localized = L.localized ?? doc;
  const source = doc.format.language || 'en';
  const editionName = sameLanguage(L.lang, source) ? '' : languageSpec(L.lang)?.english || L.lang;
  const switchOptions = languageSwitchOptions(doc);
  const shareUrl = liveShareUrl(studio);

  useEffect(() => {
    // Set on every mount: StrictMode's dev re-mount runs the cleanup once, and a ref left false
    // would silently drop every export status after it.
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  // A chip / card / the director asked to open the reader (immersive, or straight into Guided View).
  const request = studio.readerRequest;
  useEffect(() => {
    if (!request || answeredRequests.has(request)) return;
    answeredRequests.add(request);
    if (request.immersive || request.guided) setImmersive({ intro: false, guided: !!request.guided });
  }, [request]);

  const set = (s: ExportState) => mounted.current && setState(s);
  const working = state.kind === 'working';
  const drawn = !!doc.cover.render.asset?.path || doc.pages.some((p) => !!p.render.asset?.path);
  const exportLabel = editionName ? ` (${editionName})` : '';
  // The exporters get the SOURCE doc and the edition's code: "-te" file names, that script's faces.
  const exportLang = L.lang;
  // A draft edition still shows some lines in the original language — the download says so too.
  const draftNote =
    editionName && L.fallback.length
      ? `${L.fallback.length} ${L.fallback.length === 1 ? 'line is' : 'lines are'} still in ${languageSpec(source)?.english || source} in this edition.`
      : undefined;

  // "All languages (ZIP)": the published editions once live, else every ready edition (never drafts).
  const live = doc.publication?.status === 'live' ? doc.publication : undefined;
  const allLanguages = useMemo(() => {
    const wanted = live?.languages?.length ? live.languages : switchOptions.filter((o) => !o.draft).map((o) => o.code);
    return exportLanguages(doc, wanted);
    // switchOptions is derived from doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, live?.languages?.join(',')]);
  // Sized to this device before anything is drawn (only while the sheet is open), exactly as the
  // exporter will size it (same slots, same plate width), so the row never promises what it refuses.
  const allZipPlan = useMemo(() => {
    if (!sheetOpen || allLanguages.length < 2) return null;
    try {
      const { slots } = collectExportSlots(doc, studio.urlFor);
      const plateWidth = plateWidthFor(slots);
      const plan = planZipMemory(slots, allLanguages.length, { plateWidth });
      // When it can't fit, is one language at a time a real way out (or only the PDF)?
      return { ...plan, oneFits: plan.fits || oneLanguageZipFits(slots, { plateWidth, budget: plan.budget }) };
    } catch {
      return null;
    }
  }, [sheetOpen, allLanguages, doc, studio.urlFor]);

  /** Shared plumbing for the cancellable exports: progress, honest failure, cleanup. */
  const run = <R,>(label: string, task: (signal: AbortSignal, onProgress: (p: { done: number; total: number; label: string }) => void) => Promise<R>, done: (r: R) => ExportState, fallback: string) => {
    setSheetOpen(false);
    const controller = new AbortController();
    abort.current = controller;
    set({ kind: 'working', label });
    task(controller.signal, (p) => set({ kind: 'working', label: p.label, done: p.done, total: p.total }))
      .then((r) => set(done(r)))
      .catch((err: Error) => set({ kind: 'error', text: err?.message || fallback }))
      .finally(() => {
        if (abort.current === controller) abort.current = null;
      });
  };

  const print = () => {
    setSheetOpen(false);
    set({ kind: 'working', label: 'Opening the print view…' });
    // Opened synchronously inside the click so pop-up blockers allow it.
    openPrintView(doc, studio.urlFor, { lang: exportLang, onStatus: (label) => set({ kind: 'working', label }) })
      .then((r) => {
        const notes = [...r.skipped, ...r.failedImages.map((f) => `${f} (didn’t load)`)];
        set(
          exportDoneState(
            notes.length ? `Print view ready with ${r.pages} pages.` : `Print view ready — choose “Save as PDF” in the dialog for a PDF.`,
            notes,
            r.notice,
            draftNote
          )
        );
      })
      .catch((err: Error) => set({ kind: 'error', text: err?.message || 'Couldn’t open the print view.' }));
  };

  const zip = () =>
    run(
      `Preparing pages${exportLabel}…`,
      (signal, onProgress) => exportPngZip(doc, studio.urlFor, { lang: exportLang, signal, onProgress }),
      (r) => exportDoneState(`Downloaded ${r.fileName} (${r.files} images).`, [...r.failed.map((f) => `${f.label}: ${f.message}`), ...r.skipped], r.notice, draftNote),
      'Export failed.'
    );

  const zipAll = () =>
    run(
      `Preparing ${allLanguages.length} languages…`,
      (signal, onProgress) => exportLanguagesZip(doc, studio.urlFor, { languages: allLanguages, signal, onProgress }),
      (r) =>
        exportDoneState(
          `Downloaded ${r.fileName} — ${languageList(r.languages ?? allLanguages)}, a folder each (${r.files} images).`,
          [...r.failed.map((f) => `${f.label}: ${f.message}`), ...r.skipped],
          r.notice
        ),
      'Export failed.'
    );

  const pdf = () =>
    run(
      `Preparing the PDF${exportLabel}…`,
      (signal, onProgress) => exportComicPdf(doc, studio.urlFor, { lang: exportLang, signal, onProgress }),
      (r) => exportDoneState(`Downloaded ${r.fileName} (${r.pages} pages).`, [...r.failed.map((f) => `${f.label}: ${f.message}`), ...r.skipped], r.notice, draftNote),
      'PDF export failed.'
    );

  const motion = (aspect: MotionAspect) => {
    const { width, height } = MOTION_SIZES[aspect];
    run(
      `Building a ${aspect} motion comic (${width}×${height})${exportLabel}…`,
      (signal, onProgress) => exportMotionComic(doc, studio.urlFor, { aspect, lang: exportLang, signal, onProgress }),
      (r) => exportDoneState(`Downloaded ${r.fileName} — ${Math.round(r.durationMs / 100) / 10}s, ${aspect}.`, r.skipped, r.notice, draftNote),
      'Motion export failed.'
    );
  };

  const openFullScreen = (intro = false) => {
    setSheetOpen(false);
    setImmersive({ intro, guided: false });
  };
  const preview = () => {
    setSheetOpen(false);
    if (shareUrl) {
      // A full navigation in a new tab: the public reader runs under its own enforced CSP.
      window.open(shareUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    openFullScreen(true);
  };
  const copyLink = async () => {
    if (!shareUrl) return;
    setSheetOpen(false);
    const ok = await shareCaps.copy(shareUrl);
    set(ok ? { kind: 'done', tone: 'success', text: 'Link copied — anyone with it can read (never edit) this comic.' } : { kind: 'error', text: `Couldn’t copy the link. Here it is: ${shareUrl}` });
  };

  // The actions: their own row at regular heights; icon-only inside the reader's toolbar at a compact height.
  const actions = (dense: boolean) => (
    <>
      <PrimaryButton size="sm" onClick={() => openFullScreen(false)} aria-label="Read full screen" title="Read full screen (page turns, Guided View, your languages)">
        <Expand className="h-3.5 w-3.5" aria-hidden /> <span className={dense ? 'sr-only' : 'hidden sm:inline'}>Read full screen</span>
      </PrimaryButton>
      <span ref={sheetAnchor} className="inline-flex shrink-0">
        <GhostButton size="sm" onClick={() => setSheetOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={sheetOpen} aria-label="Share & export" disabled={working}>
          <Share2 className="h-3.5 w-3.5" aria-hidden /> <span className={dense ? 'sr-only' : 'hidden sm:inline'}>Share &amp; export</span>
        </GhostButton>
      </span>
      <GhostButton size="sm" onClick={() => setLookOpen((v) => !v)} aria-expanded={lookOpen} aria-label="Reader look" title="How readers see your comic (free)">
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> <span className={dense ? 'sr-only' : 'hidden md:inline'}>Reader look</span>
      </GhostButton>
      {switchOptions.length > 1 && (
        // Dense (inside the reader's one-row toolbar): a fixed share of the row, never squeezed to nothing.
        <LanguageSwitch className={dense ? 'max-w-[9rem] shrink-0' : 'ml-auto min-w-0 max-w-[60%]'} options={switchOptions} value={L.lang} onChange={L.setLang} label="Reading language" />
      )}
    </>
  );

  // The draft-edition line and the export status. At a compact height (a landscape phone: a ~127 px pane
  // with a ~57 px toolbar) one of them stacked above the reader left a 16 px page and two pushed the
  // toolbar out of the pane — there they float over the bottom of the page area instead (the reader's
  // `overlay`, on a solid backing so they read over the art), and the toolbar stays the first row.
  const fallbackNotice =
    L.fallback.length > 0 ? (
      <p className={cx('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-amber-500/[0.08] px-3 py-1.5 text-[12px] text-[var(--ds-ink)]', !compactH && 'mx-3 mt-2')} role="status">
        <span className="min-w-0">
          {L.fallback.length} {L.fallback.length === 1 ? 'line is' : 'lines are'} still shown in {languageSpec(source)?.english || source} — not translated yet.
        </span>
        <button
          type="button"
          onClick={() => studio.setTab('languages')}
          className="tap-target rounded-lg px-1.5 font-medium text-[var(--ds-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
        >
          Open Languages
        </button>
      </p>
    ) : null;
  const statusNotice =
    state.kind !== 'idle' ? (
      <div
        role={state.kind === 'error' ? 'alert' : 'status'}
        className={cx(
          'flex shrink-0 items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] leading-snug text-[var(--ds-ink)]',
          !compactH && 'mx-3 mt-2',
          state.kind === 'error'
            ? 'border-red-500/25 bg-red-500/[0.06]'
            : state.kind === 'done' && state.tone === 'warn'
              ? 'border-amber-500/30 bg-amber-500/[0.08]'
              : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]'
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="[overflow-wrap:anywhere]">{state.kind === 'working' ? state.label : state.text}</p>
          {state.kind === 'working' && state.total ? (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--ds-well-strong)]" aria-hidden>
              <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${((state.done || 0) / state.total) * 100}%` }} />
            </div>
          ) : null}
        </div>
        {state.kind === 'working' && abort.current ? (
          <GhostButton size="xs" onClick={() => abort.current?.abort()}>
            Cancel
          </GhostButton>
        ) : state.kind !== 'working' ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => set({ kind: 'idle' })}
            className="tap-target grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    ) : null;
  const floated = (notice: React.ReactNode) => notice && <div className={cx('bg-[var(--ds-surface-strong)]', RADIUS_CONTROL, SHADOW_SOFT)}>{notice}</div>;
  const overlay = compactH && (fallbackNotice || statusNotice) ? (
    <>
      {floated(fallbackNotice)}
      {floated(statusNotice)}
    </>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" data-reader-tab>
      {drawn && !compactH && (
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 px-3 pt-2" role="toolbar" aria-label="Reader actions">
          {actions(false)}
        </div>
      )}
      {!compactH && fallbackNotice}
      {lookOpen && <ReaderLookPanel studio={studio} doc={doc} />}
      {!compactH && statusNotice}
      <div className="min-h-0 flex-1">
        <ComicReaderView
          doc={localized}
          urlFor={studio.urlFor}
          autoFocus={false}
          toolbarExtra={drawn && compactH ? actions(true) : undefined}
          fullscreenControl={!compactH}
          overlay={overlay}
        />
      </div>

      <AdaptiveSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        label="Share & export"
        title="Share & export"
        anchorRef={sheetAnchor}
        placement="below"
        align="start"
        strategy="fixed"
        detents={['content']}
        className="w-[min(340px,calc(100vw-24px))]"
      >
        <div className="p-1.5" data-testid="share-export-sheet">
          <p className={cx('px-2.5 pb-1 pt-1.5', OVERLINE)}>Share</p>
          <SheetRow
            icon={<Share2 className="h-4 w-4" />}
            label="Share…"
            hint={shareUrl ? 'Link, QR code, languages, start page and stats' : 'Publish a read-only link people can open and download'}
            onClick={() => {
              setSheetOpen(false);
              setShareOpen(true);
            }}
          />
          {shareUrl && <SheetRow icon={<Copy className="h-4 w-4" />} label="Copy link" hint="Read-only: nobody can edit through it" onClick={() => void copyLink()} />}
          <SheetRow
            icon={<Eye className="h-4 w-4" />}
            label="Preview as reader"
            hint={shareUrl ? 'Opens your published link in a new tab' : 'Full screen with the cover intro, as readers will see it'}
            onClick={preview}
          />
          <SheetRow icon={<BookOpen className="h-4 w-4" />} label="Read full screen" onClick={() => openFullScreen(false)} />
          <p className={cx('px-2.5 pb-1 pt-3', OVERLINE)}>
            Download{editionName ? ` · ${editionName} edition` : ''}
          </p>
          <SheetRow icon={<Printer className="h-4 w-4" />} label="Print" hint="Crisp vector lettering — choose “Save as PDF” there" onClick={print} disabled={working} />
          <SheetRow icon={<FileDown className="h-4 w-4" />} label="PDF" hint="A print-ready PDF, downloaded directly" onClick={pdf} disabled={working} />
          <SheetRow icon={<FileArchive className="h-4 w-4" />} label="PNG pages (ZIP)" hint="Every page as a lettered image" onClick={zip} disabled={working} />
          {allLanguages.length > 1 && (
            <SheetRow
              icon={<Languages className="h-4 w-4" />}
              label="All languages (ZIP)"
              hint={
                allZipPlan && !allZipPlan.fits
                  ? allZipPlan.oneFits
                    ? 'Too big for one ZIP on this device — pick one language with the language switch and download its PNG pages'
                    : 'Too big to zip on this device, even one language at a time — download each language’s PDF instead'
                  : allZipPlan?.maxEdge
                    ? `${languageList(allLanguages)} · saved smaller to fit this device (up to ${allZipPlan.maxEdge.toLocaleString('en-US')} px)`
                    : `${languageList(allLanguages)} — a folder each`
              }
              onClick={zipAll}
              disabled={working || (!!allZipPlan && !allZipPlan.fits)}
            />
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-2">
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--ds-ink)]">
              <Clapperboard className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden /> Motion comic
            </span>
            <span className="flex flex-wrap gap-1.5" role="group" aria-label="Motion comic format">
              {MOTION_ASPECTS.map(({ aspect, label }) => (
                <GhostButton key={aspect} size="xs" disabled={working} onClick={() => motion(aspect)} aria-label={`Motion comic, ${label} ${aspect}`}>
                  {label} <span className="tabular-nums text-[var(--ds-muted)]">{aspect}</span>
                </GhostButton>
              ))}
            </span>
          </div>
          <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-[var(--ds-muted)]">Made on your device — free, no AI cost.</p>
        </div>
      </AdaptiveSheet>
      <ShareSheet studio={studio} open={shareOpen} onClose={() => setShareOpen(false)} />
      {immersive && (
        <ImmersiveReader
          doc={doc}
          urlFor={studio.urlFor}
          intro={immersive.intro}
          initialGuided={immersive.guided || undefined}
          language={L.slot}
          endCard={shareUrl ? { shareUrl } : undefined}
          onExit={() => setImmersive(null)}
        />
      )}
    </div>
  );
};
