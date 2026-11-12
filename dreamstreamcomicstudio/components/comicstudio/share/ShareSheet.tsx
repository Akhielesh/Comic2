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

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Languages, LayoutGrid, Link2Off, QrCode as QrIcon, RefreshCw, X } from 'lucide-react';
import { ratedDescription, type PublicationOwnerView, type PublishRequest } from '../../../shared/comic/publication';
import { publishComic, regeneratePublicationLink, unpublishComic, updatePublication } from '../studioApi';
import type { StudioController } from '../types';
import { ACCENT_BG, ACCENT_BG_HOVER, CONTROL_BTN, DIALOG_TITLE, FOCUS_RING, ON_ACCENT_TEXT, OVERLINE, RADIUS_CONTROL, SEGMENTED_ACTIVE, STATUS_SURFACE, TONE_TEXT } from '../../chat/studioDesign';
import { cx } from '../conversation/ui';
import { useBackLayer } from '../mobile/backStack';
import { EmbedSnippet } from './EmbedSnippet';
import { LinkPreviewMock } from './LinkPreviewMock';
import { CheckFailed, PublishPanel, Toggle } from './PublishPanel';
import { QrCode } from './QrCode';
import { ShareLinkCard } from './ShareLinkCard';
import { ShareStats } from './ShareStats';
import { comicTitle, editionOnLinkOn, INTENT_CHANNELS, CHANNEL_LABEL, intentUrl, languageNames, LIBRARY_HREF, pageIdsFor, readyOffLink, shareLinkFor, statusLine, VISIBILITY_HINT } from './shareModel';
import { ChangesSincePublishLink } from '../history/ChangesSincePublishLink';

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

type Confirm = null | 'unpublish' | 'regenerate' | 'public';

// AH-2: the two buttons of "a finished language is ready" (add it, or update without it). Tokens and recipes only.
const ADD_LANGUAGE_BTN = cx('min-h-[44px] px-3 font-semibold disabled:opacity-50 touch-manipulation', ACCENT_BG, ACCENT_BG_HOVER, ON_ACCENT_TEXT, RADIUS_CONTROL, FOCUS_RING);
const PLAIN_UPDATE_BTN = cx('min-h-[44px] px-3 font-semibold text-[var(--ds-ink)] disabled:opacity-50 touch-manipulation', CONTROL_BTN, FOCUS_RING);

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
  // Where the fetch of the owner view stands, so the sheet never guesses: on its way, here, or failed.
  const [check, setCheck] = useState<'loading' | 'ok' | 'error'>('loading');
  // AH-2: the "add a finished language" republish is under way (its own button says so; `busy` covers every action).
  const [adding, setAdding] = useState(false);
  const checkSeq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dragStart = useRef<number | null>(null);
  // Parents often pass an inline onClose; keep the latest in a ref so a parent re-render (the
  // conversation streams constantly) never re-runs the focus effect and yanks focus to Close.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hintId = useId();
  // The browser's or the phone's Back closes the sheet (one history entry while it is open) instead of leaving the app.
  useBackLayer(open, onClose, 'share-sheet');

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

  // Fetch the owner view and record how it went (only the latest fetch counts). A failure is said, with Try again,
  // instead of leaving the sheet on what it would say for a comic that was never published.
  const checkComic = () => {
    const seq = (checkSeq.current += 1);
    setCheck('loading');
    studio.refreshPublication().then(
      () => seq === checkSeq.current && setCheck('ok'),
      () => seq === checkSeq.current && setCheck('error')
    );
  };

  // Fresh owner view each time the sheet opens (stats load after it opens).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirm(null);
    setFallbackUrl(null);
    checkComic();
    return () => {
      // Closed: an answer still on its way no longer counts, and the next open starts from "checking".
      checkSeq.current += 1;
      setCheck('loading');
    };
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
        onCloseRef.current();
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
  }, [open]);

  // A confirmation (unpublish / new link / go public) takes focus on its SAFE choice ("Keep it…"),
  // so keyboard and screen-reader users hear the question instead of tabbing past it.
  useEffect(() => {
    if (!open || !confirm) return;
    panelRef.current?.querySelector<HTMLElement>('[role="alertdialog"] button')?.focus();
  }, [open, confirm]);

  const after = useCallback(
    async (next: PublicationOwnerView | null) => {
      // A fetch that lands also answers an earlier failed check.
      await studio.refreshPublication().then(
        () => setCheck('ok'),
        () => undefined
      );
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
        setError((err as Error)?.message || 'That didn’t work. Nothing changed — try again.');
        // A refusal can still teach us something (the safety check records which page it
        // blocked): refresh readiness so "Publish without page N" can appear right away.
        studio.refreshPublication().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [after, doc]
  );

  if (!open || !doc || typeof document === 'undefined') return null;

  const title = comicTitle(doc);
  const live = !!view?.slug && view.status === 'live';
  // Until the owner view arrives (or when it could not be fetched), the doc's own mirror says whether the comic is
  // published, as the header's Share button reads it: a published comic never shows as "Private" in between.
  const mirror = view ? null : doc.publication || null;
  const suspended = view ? view.status === 'suspended' : mirror?.status === 'suspended';
  const published = live || mirror?.status === 'live';
  const checking = !view && (check === 'loading' || !!studio.publicationLoading);
  const checkFailed = !view && !checking && check === 'error';
  const status = statusLine(view, mirror);
  const url = shareLinkFor(view) || '';
  const current: 'private' | 'unlisted' | 'public' = view && (live || suspended) ? (view.visibility as 'unlisted' | 'public') : mirror ? mirror.visibility : 'private';
  // Languages can only change through a republish (the snapshot must carry the edition): the panel.
  const hasEditions = Object.keys(doc.i18n?.editions || {}).length > 0 || (view?.languages.length ?? 0) > 1;

  const choose = (v: 'private' | 'unlisted' | 'public') => {
    setError(null);
    if (v === current) {
      setConfirm(null);
      return setPublishAs(null);
    }
    if (v === 'private') return setConfirm('unpublish');
    if (!published) return setPublishAs(v);
    // Listing a live comic in the public gallery is a privacy step (kids' comics): ask first.
    if (v === 'public') return setConfirm('public');
    setConfirm(null);
    void run(() => updatePublication(doc.id, { visibility: v }));
  };
  const publish = (request: PublishRequest) => void run(() => publishComic(doc.id, request));
  // Pages the owner already left out (consented exclusions) stay out of an Update while publishing would
  // still refuse them (blocked, or listed as not publishable): the gate keeps a blocked verdict. A page
  // redrawn since (clean or not checked yet) goes back in, and the gate decides on the redraw.
  const stillOutNs = new Set([...(view?.readiness.safety.blockedPages || []), ...(view?.readiness.missing || []).flatMap((m) => (m.kind === 'page' && typeof m.n === 'number' ? [m.n] : []))]);
  const excluded = (view?.excludedPageIds || []).filter((id) => doc.pages.some((p) => p.id === id && stillOutNs.has(p.n)));
  // Pages blocked since publishing (not yet excluded): the honest next step is "Publish without page N".
  const newlyBlockedIds = live && view?.readiness.safety.status === 'blocked' ? pageIdsFor(doc, view.readiness.safety.blockedPages).filter((id) => !excluded.includes(id)) : [];
  const newlyBlockedNs = doc.pages.filter((p) => newlyBlockedIds.includes(p.id)).map((p) => p.n);
  // AH-2 (EDITION_ON_LINK): finished languages the live link does not carry yet. They go on the link in one tap of
  // their own button; the plain Update never adds one.
  const editionsOn = editionOnLinkOn(studio.caps?.admin);
  const readyLangs = editionsOn && live ? readyOffLink(view, doc) : [];
  const readyNames = languageNames(readyLangs);
  const onLinkNames = languageNames(view?.languages || []);
  const updateRequest = (alsoExclude: string[] = [], alsoLanguages: string[] = []): PublishRequest | null => {
    if (!view) return null;
    const excludePageIds = [...new Set([...excluded, ...alsoExclude])];
    const languages = alsoLanguages.length ? [...view.languages, ...alsoLanguages] : view.languages;
    return { visibility: view.visibility === 'public' ? 'public' : 'unlisted', languages, ...(excludePageIds.length ? { excludePageIds } : {}) };
  };
  const addReady = () => {
    const request = updateRequest([], readyLangs);
    if (!request) return;
    setAdding(true);
    void run(() => publishComic(doc.id, request)).finally(() => setAdding(false));
  };
  const updateNow = () => {
    const request = updateRequest();
    if (request) void run(() => publishComic(doc.id, request));
  };
  const updateWithout = () => {
    const request = updateRequest(newlyBlockedIds);
    if (request) void run(() => publishComic(doc.id, request));
  };

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
    <div role="radiogroup" aria-label="Who can read it" className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--ds-segment-track)] p-1">
      {(
        [
          ['private', 'Private'],
          ['unlisted', 'Link only'],
          ['public', 'Library + link']
        ] as const
      ).map(([v, label]) => {
        const on = (publishAs ?? current) === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            aria-describedby={v === 'private' ? undefined : `${hintId}-${v}`}
            disabled={busy || (suspended && v !== 'private')}
            onClick={() => choose(v)}
            className={cx(
              'min-h-[44px] min-w-0 rounded-[10px] px-1.5 text-[12px] font-medium leading-tight touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-50',
              on ? SEGMENTED_ACTIVE : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
  // What the chosen way means, under the choices. Each hint also describes its own radio (aria-describedby reads a hidden hint too).
  const visibilityHints = (['unlisted', 'public'] as const).map((v) => (
    <p key={v} id={`${hintId}-${v}`} hidden={(publishAs ?? current) !== v} className="m-0 !mt-1.5 text-[12px] text-[var(--ds-muted)]">
      {VISIBILITY_HINT[v]}
    </p>
  ));

  const confirmBox =
    confirm === 'public' ? (
      <div role="alertdialog" aria-label="List it in the Library?" className="rounded-xl border border-[color:color-mix(in_srgb,var(--ds-accent)_35%,transparent)] bg-[var(--ds-accent-soft)] p-3">
        <p className="m-0 text-[13px] text-[var(--ds-ink)]">
          List it in the Library? Anyone can find and read it there, not just people with the link. The link keeps working, and readers still can’t edit. A quick safety check runs first.
        </p>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setConfirm(null)} className="min-h-[44px] rounded-xl px-4 text-[14px] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">
            Keep it link only
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => updatePublication(doc.id, { visibility: 'public' }))}
            className="min-h-[44px] rounded-xl bg-[var(--ds-accent)] px-4 text-[14px] font-semibold text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-50"
          >
            {busy ? 'Working…' : 'List it in the Library'}
          </button>
        </div>
      </div>
    ) : (
      confirm && (
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
      )
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

  // "This is what people see before they tap": the FROZEN card (title, description, rating, cover
  // fallback), never the live doc's text — edits stay private until Update (functions/_shared/shareHead.ts).
  const preview = live && view && (
    <LinkPreviewMock
      title={view.card?.title || title}
      description={ratedDescription(view.card ? view.card.description : doc.brief?.logline || doc.cover?.tagline || '', view.rating) || undefined}
      imageUrl={view.ogImageUrl || view.card?.coverUrl}
      url={url}
    />
  );

  // Published: the link comes first (copy, QR, Share…), and a listed comic also links to its shelf in the Library.
  // The wide dialog keeps its QR in the left column; every other layout shows it here, ahead of the choices.
  const linkFirst = live && view && !publishAs && (
    <>
      <ShareLinkCard view={view} title={title} description={doc.brief?.logline} onFallback={setFallbackUrl} pageCount={doc.pages.length} />
      {fallback}
      {layout !== 'wide' && qr}
      {current === 'public' && (
        <a
          href={LIBRARY_HREF}
          target="_blank"
          rel="noopener noreferrer"
          className={`!mt-1 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-1 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] touch-manipulation ${FOCUS_RING}`}
        >
          <LayoutGrid className="h-4 w-4" aria-hidden /> See it in the Library
        </a>
      )}
    </>
  );

  const controls = (
    <div className="min-w-0 space-y-4">
      {linkFirst}
      {visibilityControl}
      {visibilityHints}
      {suspended && view?.suspendedReason && (
        <p className="m-0 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[13px] text-[var(--ds-ink)]">{view.suspendedReason}</p>
      )}
      {(confirm === 'unpublish' || confirm === 'public') && confirmBox}
      {publishAs ? (
        <PublishPanel
          doc={doc}
          view={view}
          visibility={publishAs}
          busy={busy}
          error={error}
          check={checking ? 'loading' : checkFailed ? 'error' : undefined}
          onRetry={checkComic}
          tickReady={editionsOn}
          onPublish={publish}
          onCancel={() => setPublishAs(null)}
        />
      ) : (
        <>
          {live && view?.behind && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[13px] text-[var(--ds-ink)]">
              <span className="min-w-0">You’ve made changes since publishing. Readers still see the published version.</span>
              <ChangesSincePublishLink studio={studio} />
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {newlyBlockedNs.length > 0 && (
                  <button
                    type="button"
                    disabled={busy || doc.pages.length <= excluded.length + newlyBlockedIds.length}
                    onClick={updateWithout}
                    className="min-h-[44px] rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-45"
                  >
                    Publish without page {newlyBlockedNs.join(', ')}
                  </button>
                )}
                {readyLangs.length > 0 && (
                  <button type="button" disabled={busy} aria-busy={adding || undefined} onClick={addReady} className={ADD_LANGUAGE_BTN}>
                    {adding ? 'Updating…' : `Update with ${readyNames}`}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={updateNow}
                  aria-describedby={readyLangs.length > 0 ? `${hintId}-update` : undefined}
                  className={readyLangs.length > 0 ? PLAIN_UPDATE_BTN : 'min-h-[44px] rounded-xl bg-[var(--ds-accent)] px-3 font-semibold text-white disabled:opacity-50'}
                >
                  {busy && !adding ? 'Updating…' : 'Update'}
                </button>
              </div>
              {readyLangs.length > 0 && (
                <p id={`${hintId}-update`} className="m-0 w-full text-right text-[12px] text-[var(--ds-muted)]">
                  Readers still get {onLinkNames} only
                </p>
              )}
            </div>
          )}
          {live && !view?.behind && readyLangs.length > 0 && (
            <div
              role="group"
              aria-label="Languages ready for your link"
              className={cx('flex min-w-0 flex-wrap items-center justify-between gap-2 border px-3 py-2 text-[13px] text-[var(--ds-ink)]', RADIUS_CONTROL, STATUS_SURFACE.healthy)}
            >
              <span className="min-w-0">
                {readyNames} {readyLangs.length === 1 ? 'is' : 'are'} ready. Readers of your link still get {onLinkNames} only.
              </span>
              <button type="button" disabled={busy} aria-busy={adding || undefined} onClick={addReady} className={ADD_LANGUAGE_BTN}>
                {adding ? 'Adding…' : `Add ${readyNames} to the link`}
              </button>
            </div>
          )}
          {live && view && (
            // Settings the server changes in place (PATCH): the link, the snapshot and readers' places stay.
            <section aria-label="Link settings" className="min-w-0">
              <div className={cx('mb-1', OVERLINE)}>Link settings</div>
              <div className="divide-y divide-[var(--ds-hairline-soft)]">
                <Toggle label="Readers can download" hint="PDF and page images of the published version" checked={view.allowDownload} disabled={busy} onChange={(v) => void run(() => updatePublication(doc.id, { allowDownload: v }))} />
                <Toggle label="Allow embedding" hint="Lets websites show it in a frame" checked={view.allowEmbed} disabled={busy} onChange={(v) => void run(() => updatePublication(doc.id, { allowEmbed: v }))} />
                <Toggle label="Show my username" hint="Off keeps you anonymous to readers" checked={view.showCreator} disabled={busy} onChange={(v) => void run(() => updatePublication(doc.id, { showCreator: v }))} />
              </div>
              {hasEditions && current !== 'private' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPublishAs(current)}
                  className="mt-1 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-1 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-50"
                >
                  <Languages className="h-4 w-4" aria-hidden /> Edit languages…
                </button>
              )}
            </section>
          )}
          {!live && !suspended && !mirror && (
            <p className="m-0 text-[13px] text-[var(--ds-muted)]">Only you can see this comic. Choose “Link only” for a read-only link people can open on any device, or “Library + link” to also list it in the Library.</p>
          )}
          {mirror && checking && (
            <p role="status" className="m-0 text-[13px] text-[var(--ds-muted)]">
              Checking your comic…
            </p>
          )}
          {checkFailed && <CheckFailed onRetry={checkComic} />}
          {error && (
            <p role="alert" className="m-0 rounded-xl border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[13px] text-[var(--ds-ink)]">
              {error}
            </p>
          )}
          {live && view?.allowEmbed && <EmbedSnippet url={url} title={title} aspect={doc.format?.pageAspect} />}
          {live && (
            <section aria-label="Reader stats" className="min-w-0">
              <div className={cx('mb-1.5', OVERLINE)}>Readers</div>
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
                <button type="button" onClick={() => setConfirm('unpublish')} className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium ${TONE_TEXT.danger} hover:bg-[var(--ds-status-error-tint)]`}>
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
            <h2 id="ds-share-title" className={cx('m-0 truncate text-[var(--ds-ink)]', layout === 'dialog' || layout === 'wide' ? DIALOG_TITLE : 'text-[16px] font-semibold')}>
              Share “{title}”
            </h2>
            <p
              className={cx(
                'm-0 mt-0.5 truncate text-[12px]',
                status.tone === 'public' ? TONE_TEXT.success : status.tone === 'unlisted' ? TONE_TEXT.info : status.tone === 'warn' ? TONE_TEXT.warning : 'text-[var(--ds-muted)]'
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
