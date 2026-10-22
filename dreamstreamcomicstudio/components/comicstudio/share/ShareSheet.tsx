// The Share sheet (sharing.md §7.3/§7.4): status, visibility, the read-only link, a live
// link-preview mock, QR, embed, stats and the danger zone (new link / unpublish).
//
// Presentation by form factor:
//   phone portrait (< 640 px)   bottom sheet, drag handle (swipe down to close), sticky Copy/Share
//   short landscape (≤ 480 high) right side sheet, so it never covers the whole short viewport
//   640–1023                     centred dialog, one column, QR shown
//   ≥ 1024                       760 px dialog, two columns (preview + QR | controls)
//   dual-screen foldables        placed in the right segment, avoiding the hinge
// role="dialog" aria-modal, focus trap, Esc closes, focus returns to the trigger, body scroll
// locked; reduced motion disables the slide. No horizontal overflow from 320 px.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Link2Off, QrCode as QrIcon, RefreshCw, X } from 'lucide-react';
import type { PublicationOwnerView, PublishRequest } from '../../../shared/comic/publication';
import { publishComic, regeneratePublicationLink, unpublishComic, updatePublication } from '../studioApi';
import type { StudioController } from '../types';
import { cx } from '../conversation/ui';
import { EmbedSnippet } from './EmbedSnippet';
import { LinkPreviewMock } from './LinkPreviewMock';
import { PublishPanel } from './PublishPanel';
import { QrCode } from './QrCode';
import { ShareLinkCard } from './ShareLinkCard';
import { ShareStats } from './ShareStats';
import { comicTitle, INTENT_CHANNELS, CHANNEL_LABEL, intentUrl, shareLinkFor, statusLine } from './shareModel';

export interface ShareSheetProps {
  studio: StudioController;
  open: boolean;
  onClose(): void;
}

type Layout = 'bottom' | 'side' | 'dialog' | 'wide';

const query = (q: string) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;

export function sheetLayout(): Layout {
  if (query('(max-height: 480px) and (orientation: landscape)')) return 'side';
  if (query('(max-width: 639px)')) return 'bottom';
  if (query('(min-width: 1024px)')) return 'wide';
  return 'dialog';
}

/** Dual-screen foldable: the right segment's left edge (px), else null. */
const rightSegmentLeft = (): number | null => {
  const segs = (window as unknown as { viewport?: { segments?: DOMRect[] } }).viewport?.segments;
  if (Array.isArray(segs) && segs.length === 2 && segs[1].left > segs[0].left) return segs[1].left;
  return query('(horizontal-viewport-segments: 2)') ? Math.round(window.innerWidth / 2) : null;
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type Confirm = null | 'unpublish' | 'regenerate';

export const ShareSheet: React.FC<ShareSheetProps> = ({ studio, open, onClose }) => {
  const doc = studio.doc;
  const view = studio.publication;
  const [layout, setLayout] = useState<Layout>(() => (typeof window === 'undefined' ? 'dialog' : sheetLayout()));
  const [segmentLeft, setSegmentLeft] = useState<number | null>(null);
  const [publishAs, setPublishAs] = useState<null | 'unlisted' | 'public'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [dragY, setDragY] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dragStart = useRef<number | null>(null);

  // Layout follows the viewport (rotation, foldable posture, window resize).
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      setLayout(sheetLayout());
      setSegmentLeft(rightSegmentLeft());
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  // Fresh owner view each time the sheet opens (stats load after it opens).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirm(null);
    setFallbackUrl(null);
    studio.refreshPublication().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus management, Esc, scroll lock.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = (document.activeElement as HTMLElement) || null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus() ?? panelRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      returnFocus.current?.focus?.();
    };
  }, [open, onClose]);

  const after = useCallback(
    async (next: PublicationOwnerView | null) => {
      await studio.refreshPublication().catch(() => undefined);
      // The server committed the doc mirror (and a notice): pull them in.
      await studio.refresh().catch(() => undefined);
      return next;
    },
    [studio]
  );

  const run = useCallback(
    async (work: () => Promise<PublicationOwnerView | null>) => {
      if (!doc) return;
      setBusy(true);
      setError(null);
      try {
        await after(await work());
        setPublishAs(null);
        setConfirm(null);
      } catch (err) {
        setError((err as Error)?.message || "That didn't work. Nothing changed — try again.");
      } finally {
        setBusy(false);
      }
    },
    [after, doc]
  );

  if (!open || !doc || typeof document === 'undefined') return null;

  const title = comicTitle(doc);
  const live = !!view?.slug && view.status === 'live';
  const suspended = view?.status === 'suspended';
  const status = statusLine(view);
  const url = shareLinkFor(view) || '';
  const current: 'private' | 'unlisted' | 'public' = live || suspended ? (view!.visibility as 'unlisted' | 'public') : 'private';

  const choose = (v: 'private' | 'unlisted' | 'public') => {
    setError(null);
    if (v === current) return setPublishAs(null);
    if (v === 'private') return setConfirm('unpublish');
    if (!live) return setPublishAs(v);
    void run(() => updatePublication(doc.id, { visibility: v }));
  };
  const publish = (request: PublishRequest) => void run(() => publishComic(doc.id, request));
  const updateNow = () => view && void run(() => publishComic(doc.id, { visibility: view.visibility === 'public' ? 'public' : 'unlisted', languages: view.languages }));

  const frame =
    layout === 'bottom'
      ? 'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl pb-[max(16px,env(safe-area-inset-bottom))]'
      : layout === 'side'
        ? 'inset-y-0 right-0 w-[min(420px,100vw)] rounded-l-2xl pb-[max(12px,env(safe-area-inset-bottom))]'
        : layout === 'wide'
          ? 'left-1/2 top-1/2 max-h-[85dvh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl'
          : 'left-1/2 top-1/2 max-h-[85dvh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl';
  const segmentStyle: React.CSSProperties | undefined =
    segmentLeft !== null && layout !== 'bottom' ? { left: segmentLeft + 16, right: 16, width: 'auto', transform: 'translateY(-50%)', top: '50%' } : undefined;
  const dragStyle: React.CSSProperties | undefined = layout === 'bottom' && dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined;

  const visibilityControl = (
    <div role="radiogroup" aria-label="Who can read it" className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--ds-well-strong)] p-1">
      {(
        [
          ['private', 'Private'],
          ['unlisted', 'Anyone with link'],
          ['public', 'Public gallery']
        ] as const
      ).map(([v, label]) => {
        const on = (publishAs ?? current) === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy || (suspended && v !== 'private')}
            onClick={() => choose(v)}
            className={cx(
              'min-h-[44px] min-w-0 rounded-[10px] px-1.5 text-[12px] font-medium leading-tight touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-50',
              on ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  const confirmBox = confirm && (
    <div role="alertdialog" aria-label={confirm === 'unpublish' ? 'Unpublish?' : 'Get a new link?'} className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-3">
      <p className="m-0 text-[13px] text-[var(--ds-ink)]">
        {confirm === 'unpublish'
          ? 'Unpublish? The link stops working for everyone. Publishing again creates a new link.'
          : 'Get a new link? The current link stops working for everyone right away.'}
      </p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => setConfirm(null)} className="min-h-[44px] rounded-xl px-4 text-[14px] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">
          Keep it
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => (confirm === 'unpublish' ? unpublishComic(doc.id) : regeneratePublicationLink(doc.id)))}
          className="min-h-[44px] rounded-xl bg-red-600 px-4 text-[14px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? 'Working…' : confirm === 'unpublish' ? 'Unpublish' : 'Get new link'}
        </button>
      </div>
    </div>
  );

  const fallback = fallbackUrl && (
    <div className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
      <p className="m-0 mb-2 text-[13px] text-[var(--ds-muted)]">Share it with:</p>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {INTENT_CHANNELS.map((ch) => (
          <li key={ch}>
            <a
              href={intentUrl(ch, shareLinkFor(view, { via: ch }) || fallbackUrl, title)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center rounded-full border border-[var(--ds-hairline)] px-3 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
            >
              {CHANNEL_LABEL[ch]}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );

  const qr = url && (
    <div className="min-w-0">
      {layout === 'bottom' && !showQr ? (
        <button type="button" onClick={() => setShowQr(true)} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl px-1 text-[13px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">
          <QrIcon className="h-4 w-4" aria-hidden /> Show QR code
        </button>
      ) : (
        <QrCode value={shareLinkFor(view, { via: 'qr' }) || url} title={title} size={layout === 'bottom' ? 168 : 176} downloadable />
      )}
      <p className="m-0 mt-1 text-center text-[12px] text-[var(--ds-muted)]">Let someone scan it from your screen.</p>
    </div>
  );

  const preview = live && view && (
    <LinkPreviewMock title={title} description={doc.brief?.logline || doc.cover?.tagline || undefined} imageUrl={view.ogImageUrl} url={url} />
  );

  const controls = (
    <div className="min-w-0 space-y-4">
      {visibilityControl}
      {suspended && view?.suspendedReason && (
        <p className="m-0 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[13px] text-[var(--ds-ink)]">{view.suspendedReason}</p>
      )}
      {confirm === 'unpublish' && confirmBox}
      {publishAs ? (
        <PublishPanel doc={doc} view={view} visibility={publishAs} busy={busy} error={error} onPublish={publish} onCancel={() => setPublishAs(null)} />
      ) : (
        <>
          {live && view?.behind && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[13px] text-[var(--ds-ink)]">
              <span className="min-w-0">You’ve made changes since publishing. Readers still see the published version.</span>
              <button type="button" disabled={busy} onClick={updateNow} className="min-h-[44px] rounded-xl bg-[var(--ds-accent)] px-3 font-semibold text-white disabled:opacity-50">
                {busy ? 'Updating…' : 'Update'}
              </button>
            </div>
          )}
          {live && view && <ShareLinkCard view={view} title={title} description={doc.brief?.logline} onFallback={setFallbackUrl} pageCount={doc.pages.length} />}
          {fallback}
          {!live && !suspended && (
            <p className="m-0 text-[13px] text-[var(--ds-muted)]">Only you can see this comic. Choose “Anyone with link” to get a read-only link people can open on any device.</p>
          )}
          {error && (
            <p role="alert" className="m-0 rounded-xl border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[13px] text-[var(--ds-ink)]">
              {error}
            </p>
          )}
          {live && view?.allowEmbed && <EmbedSnippet url={url} title={title} aspect={doc.format?.pageAspect} />}
          {live && (
            <section aria-label="Reader stats" className="min-w-0">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Readers</div>
              <ShareStats stats={view?.stats} />
            </section>
          )}
          {(live || suspended) && (
            <section aria-label="Danger zone" className="space-y-2 border-t border-[var(--ds-hairline-soft)] pt-3">
              {confirm === 'regenerate' && confirmBox}
              <div className="flex flex-wrap gap-2">
                {live && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden /> Preview as reader
                  </a>
                )}
                {live && (
                  <button type="button" onClick={() => setConfirm('regenerate')} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]">
                    <RefreshCw className="h-4 w-4" aria-hidden /> Get a new link
                  </button>
                )}
                <button type="button" onClick={() => setConfirm('unpublish')} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-red-600 hover:bg-red-500/[0.08] dark:text-red-400">
                  <Link2Off className="h-4 w-4" aria-hidden /> Unpublish
                </button>
              </div>
              {live && <p className="m-0 text-[12px] text-[var(--ds-muted)]">Changed the cover? Apps that already showed the link may keep the old preview for a while.</p>}
            </section>
          )}
        </>
      )}
    </div>
  );

  const body =
    layout === 'wide' && live && !publishAs ? (
      <div className="grid min-w-0 grid-cols-[minmax(0,300px)_minmax(0,1fr)] gap-6">
        <div className="min-w-0 space-y-4">
          {preview}
          {qr}
        </div>
        {controls}
      </div>
    ) : (
      <div className="min-w-0 space-y-4">
        {controls}
        {!publishAs && preview}
        {!publishAs && live && qr}
      </div>
    );

  const onHandleDown = (e: React.PointerEvent) => {
    dragStart.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (dragStart.current !== null) setDragY(Math.max(0, e.clientY - dragStart.current));
  };
  const onHandleUp = () => {
    if (dragY > 90) onClose();
    dragStart.current = null;
    setDragY(0);
  };

  return createPortal(
    <div className="fixed inset-0 z-[70]" data-share-layout={layout}>
      <div className="absolute inset-0 bg-black/40 motion-safe:transition-opacity" aria-hidden onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ds-share-title"
        tabIndex={-1}
        className={cx(
          'absolute flex flex-col overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-surface)] shadow-[0_12px_48px_rgba(0,0,0,0.28)] focus:outline-none',
          frame
        )}
        style={{ ...segmentStyle, ...dragStyle }}
      >
        {layout === 'bottom' && (
          <div
            className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center"
            data-testid="share-drag-handle"
            aria-hidden
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          >
            <span className="h-1.5 w-10 rounded-full bg-[var(--ds-hairline)]" />
          </div>
        )}
        <header className="flex shrink-0 items-start justify-between gap-3 px-4 pb-2 pt-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="ds-share-title" className="m-0 truncate text-[16px] font-semibold text-[var(--ds-ink)]">
              Share “{title}”
            </h2>
            <p
              className={cx(
                'm-0 mt-0.5 truncate text-[12px]',
                status.tone === 'public' ? 'text-emerald-700 dark:text-emerald-400' : status.tone === 'unlisted' ? 'text-sky-700 dark:text-sky-400' : status.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-[var(--ds-muted)]'
              )}
            >
              {status.label}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-autofocus
            aria-label="Close"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pb-4 sm:px-5">{body}</div>
      </div>
    </div>,
    document.body
  );
};

export default ShareSheet;
