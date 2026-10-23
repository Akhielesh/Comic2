// The public reader (sharing.md §7.2, reader.md §2.1). Two sources:
//
//   slug    — `/c/<slug>[/embed]`: the frozen, allow-listed publication snapshot from the edge. It paints
//             at once from the server-injected boot card (#ds-share-boot), then shows the cover card
//             (Read → the immersive reader with its cover intro; Guided → panel by panel), or the inline
//             reader straight away for a deep link (?p=) and in embeds. Language picker (?lang=), Share,
//             Download (only when the author allows it; made in the browser from the public images),
//             Report (never for the owner), the "Make your own" call to action, and one honest
//             "This link isn't active" for unknown, revoked, unpublished and suspended links alike.
//   project — the legacy `/?view=read&id=` link and the owner's preview: /api/comic/public/:id
//             (signed links that expire mid-read are refreshed quietly).
//
// READ-ONLY by construction: this file only GETs the snapshot, posts anonymous view/complete/share
// events and the report form. Nothing here can edit, spend or reach anything but the published comic.
// Share-link downloads go through export/publicDownload (downloadPublicComic): the author's switch is
// enforced there too, only `pub/` public images are fetched (https, no credentials), and only PUBLISHED
// languages are ever exported — a reader looking at an unpublished source language is offered the
// published edition, by name. Every export's `notice` (fonts, smaller images) is shown.
// Links out of /c/* are full navigations (its enforced CSP must not carry over into the app).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, ExternalLink, FileArchive, FileText, Flag, Home, Languages, RotateCcw, X } from 'lucide-react';
import type { AssetRef, ComicDoc } from '../../shared/comic/doc';
import { buildShareUrl, SHARE_PATH, SLUG_RE, type PublicPublicationInfo } from '../../shared/comic/publication';
import { canServeToOwner, isContentRating, type ContentRating } from '../../shared/comic/safety';
import { languageSpec, sameLanguage } from '../../shared/comic/languages';
import { COMICS_ORIGIN } from '../../services/productHost';
import { CANVAS_BG } from '../chat/studioDesign';
import { Skeleton } from '../studio/kit/Shimmer';
import { GhostButton, IconButton, cx } from './board/ui';
import { aspectNumber } from './board/balloonGeometry';
import { ReaderLanguagePicker } from './i18n/ReaderLanguagePicker';
import { nextLanguage, readStoredReaderLang, readUrlLang, useReaderLanguage } from './i18n/readerLanguage';
import { readerString } from './i18n/readerStrings';
import { ImmersiveReader } from './immersive/ImmersiveReader';
import { publicExportLanguage, publicExportLanguages } from './export/publicLanguages';
import { EmptyArt } from './library/procedural/EmptyArt';
import { useFormFactor } from './mobile/useFormFactor';
import { ComicReaderView, ReaderMenu, type ReaderMenuItem } from './reader/ComicReaderView';
import { ReaderCoverCard } from './reader/ReaderCoverCard';
import { readerStartFromSearch, type PublicReaderStart } from './reader/publicComicRoute';
import { readerItems } from './reader/readerModel';
import { RatingBadge } from './safety/RatingBadge';
import { ReportDialog } from './safety/ReportDialog';
import { ShareButton } from './share/ShareButton';
import { usePublicComic, type ShareBoot } from './share/usePublicComic';
import { loadPublicComic } from './studioApi';

export type PublicComicSource =
  | { kind: 'slug'; slug: string; embed?: boolean }
  | { kind: 'project'; projectId: string };

export interface PublicComicReaderProps {
  source?: PublicComicSource;
  /** Legacy form of `source: { kind: 'project', projectId }`. */
  projectId?: string;
  onClose?: () => void;
  /** The signed-in viewer owns this comic: no Report, no analytics. */
  isOwner?: boolean;
  /** Owner detection has settled (analytics wait for it, so an owner's own view is never counted). */
  identityReady?: boolean;
  /** Where the reader starts (default: read from the address bar: ?p= ?guided=1 ?panel=). */
  start?: PublicReaderStart;
}

type Status = 'loading' | 'ready' | 'not_found' | 'error';

/** Don't refresh links more often than this when images fail (project mode: signed links). */
const RELINK_COOLDOWN_MS = 60_000;

/** Where "Make your own" goes: Comic Studio's own front page (a full navigation, never in-app). */
const MAKE_YOUR_OWN_HREF = '/';

const urlForMap = (urls: Record<string, string> | null) => (asset?: AssetRef | string | null): string | undefined => {
  if (!asset || !urls) return undefined;
  const path = typeof asset === 'string' ? asset : asset.path;
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return urls[path];
};

/** The rating the publish gate assigned (publication info when the edge sends it; the owner's own gate result otherwise). */
const ratingOf = (publication: PublicPublicationInfo | null | undefined, doc: ComicDoc | null): ContentRating | undefined => {
  const fromPub: unknown = publication?.rating;
  if (isContentRating(fromPub)) return fromPub;
  const gate = doc?.safety?.publish;
  return gate?.ok && isContentRating(gate.rating) ? gate.rating : undefined;
};

const parseAspect = (a?: string): number | undefined => {
  if (!a) return undefined;
  const n = aspectNumber(a as never);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

type DownloadKind = 'pdf' | 'zip' | 'zip_all';

/** What a finished download says: what came out, what was left out, and the export's own notice. */
export const downloadDoneText = (
  kind: DownloadKind,
  res: { pages?: number; files?: number; failed: unknown[]; skipped: string[]; notice?: string; languages?: string[] },
  langName?: string
): string => {
  const left = res.skipped.length + res.failed.length;
  const edition = langName ? ` (${langName})` : '';
  let text: string;
  if (kind === 'pdf') {
    const pages = res.pages ?? 0;
    text = left ? `Downloaded ${pages} page${pages === 1 ? '' : 's'}${edition} — ${left} couldn’t be included.` : `Downloaded the PDF${edition}.`;
  } else if (kind === 'zip') {
    text = left ? `Downloaded the page images${edition} — ${left} couldn’t be included.` : `Downloaded the page images${edition}.`;
  } else {
    const n = res.languages?.length ?? 0;
    text = left ? `Downloaded ${n} languages, a folder each — ${left} images couldn’t be included.` : `Downloaded ${n} languages, a folder each.`;
  }
  return res.notice ? `${text} ${res.notice}` : text;
};

const englishName = (code: string) => languageSpec(code)?.english || code;

const fullNavigate = (href: string) => {
  try {
    window.location.assign(href);
  } catch {
    /* sandboxed frame */
  }
};

interface ShellProps {
  mode: 'slug' | 'project';
  status: Status;
  errorMessage?: string | null;
  onRetry(): void;
  doc: ComicDoc | null;
  urls: Record<string, string> | null;
  onImageError?: () => void;
  boot: ShareBoot | null;
  slug?: string;
  publication?: PublicPublicationInfo | null;
  embed: boolean;
  start: PublicReaderStart;
  isOwner: boolean;
  identityReady: boolean;
  onClose?: () => void;
  track?: (type: 'view' | 'complete' | 'share', lang?: string) => void;
}

const ReaderShell: React.FC<ShellProps> = ({
  mode,
  status,
  errorMessage,
  onRetry,
  doc,
  urls,
  onImageError,
  boot,
  slug,
  publication,
  embed,
  start,
  isOwner,
  identityReady,
  onClose,
  track
}) => {
  const ff = useFormFactor();
  const urlFor = useMemo(() => urlForMap(urls), [urls]);
  const published = mode === 'slug' ? publication?.languages : undefined;
  // A share link without ?lang= means the author's default edition (buildShareUrl drops lang when it
  // equals the default) — for a first-time reader; a returning reader keeps their own choice.
  const [linkHasLang] = useState(() => !!readUrlLang());
  const [hasStoredLang] = useState(() => !!readStoredReaderLang());
  const authorDefault = mode === 'slug' && !linkHasLang && !hasStoredLang ? publication?.defaultLang || boot?.lang : undefined;
  const langEnv = useMemo(() => (authorDefault ? { search: `?lang=${encodeURIComponent(authorDefault)}` } : undefined), [authorDefault]);
  const L = useReaderLanguage({ doc, published, persist: mode === 'slug', env: langEnv });
  const lang = L.lang;
  const t = useCallback((key: Parameters<typeof readerString>[1]) => readerString(lang, key), [lang]);
  const localized = L.localized;
  const source = doc?.format.language || 'en';
  const allowDownload = mode === 'slug' ? !!(publication?.allowDownload ?? boot?.allowDownload) : isOwner;
  const rating = ratingOf(publication, doc);
  // Never offered to the owner — not even for the moment before their identity is known.
  const canReport = mode === 'slug' && !!slug && SLUG_RE.test(slug) && !isOwner && identityReady;

  // ── View: the cover card, the inline reader, or the immersive reader over either ──
  const deepLinked = start.page !== undefined && !start.guided;
  const [view, setView] = useState<'card' | 'inline'>(() => (embed || deepLinked || mode === 'project' ? 'inline' : 'card'));
  const [immersive, setImmersive] = useState<{ guided: boolean; page?: number | 'cover'; panel?: number; intro: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ── Title ──
  const title = localized?.cover.title || localized?.brief.title || boot?.card.title || 'Comic';
  const logline = localized?.brief.logline || localized?.cover.tagline || boot?.card.description;
  useEffect(() => {
    if (typeof document === 'undefined' || status === 'not_found') return;
    const prev = document.title;
    document.title = `${title} — DreamStream`;
    return () => {
      document.title = prev;
    };
  }, [title, status]);

  // ── Analytics: never for the owner; only once identity has settled ──
  const canTrack = mode === 'slug' && identityReady && !isOwner && !!track;
  useEffect(() => {
    if (canTrack && status === 'ready') track!('view', lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canTrack, status]);
  const lastPageN = useMemo(() => (doc ? Math.max(0, ...readerItems(doc).map((i) => i.page?.n ?? 0)) : 0), [doc]);
  // "Complete" means read through to the end: a link that opens on the last page (?p=, the author's
  // start page) only counts once the reader has been on an earlier page too.
  const readEarlier = useRef(false);
  const onPageChange = useCallback(
    (n: number) => {
      setPage(n);
      if (n < lastPageN) readEarlier.current = true;
      else if (canTrack && lastPageN > 0 && readEarlier.current) track!('complete', lang);
    },
    [canTrack, lastPageN, track, lang]
  );

  // ── The `L` key switches language (not while typing or inside the immersive reader) ──
  useEffect(() => {
    const slot = L.slot;
    if (!slot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'l' && e.key !== 'L') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      // Works in the immersive reader too, but never inside another dialog (the report form) or an open list.
      const dialog = el?.closest?.('[role="dialog"]');
      if (dialog && dialog.getAttribute('data-testid') !== 'immersive-reader') return;
      if (el?.closest?.('[role="listbox"],[role="menu"]')) return;
      const next = nextLanguage(slot.options, slot.current);
      if (next) slot.onChange(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [L.slot]);

  // ── Share link (canonical, read-only; carries the reader's language) ──
  const shareUrl = useMemo(() => {
    if (mode !== 'slug' || !slug || !SLUG_RE.test(slug)) return undefined;
    const linkDefault = publication?.defaultLang || source;
    return buildShareUrl(COMICS_ORIGIN, slug, sameLanguage(lang, linkDefault) ? {} : { lang }, { defaultLang: publication?.defaultLang, startPage: publication?.startPage ?? null });
  }, [mode, slug, lang, source, publication?.defaultLang, publication?.startPage]);
  const embedOpenHref = slug && SLUG_RE.test(slug) ? `${COMICS_ORIGIN}${SHARE_PATH(slug)}` : COMICS_ORIGIN;

  // ── Downloads: made here, from the public images; withheld pages are never included ──
  // Share link: only the published languages (never an unpublished source), through downloadPublicComic.
  const exportable = useMemo(
    () => (mode === 'slug' && doc && publication ? publicExportLanguages({ publication, doc }) : doc ? [lang] : []),
    [mode, doc, publication, lang]
  );
  // The edition a single-language download produces: the reader's own when it is published, else the
  // author's default / first published one — and the menu names it, so nobody gets a surprise language.
  const downloadLang = mode === 'slug' && doc && publication ? publicExportLanguage({ publication, doc }, lang) : lang;
  const readingExportable = !!downloadLang && sameLanguage(downloadLang, lang);
  const nameDownloadLang = exportable.length > 1 || !readingExportable;
  const [downloading, setDownloading] = useState<DownloadKind | null>(null);
  const safeUrlFor = useCallback((a?: AssetRef | string | null) => (a && typeof a === 'object' && !canServeToOwner(a) ? undefined : urlFor(a)), [urlFor]);
  const download = useCallback(
    async (kind: DownloadKind) => {
      if (!doc || downloading || !allowDownload) return;
      setDownloading(kind);
      setNotice(kind === 'pdf' ? 'Preparing the PDF…' : kind === 'zip' ? 'Preparing the page images…' : 'Preparing every language…');
      try {
        let res: Parameters<typeof downloadDoneText>[1];
        if (mode === 'slug') {
          if (!publication || !urls) throw new Error('the comic is still loading.');
          const { downloadPublicComic } = await import('./export/publicDownload');
          res = kind === 'pdf' ? await downloadPublicComic({ publication, doc, urls }, 'pdf', { lang }) : await downloadPublicComic({ publication, doc, urls }, kind, { lang });
        } else if (kind === 'pdf') {
          // Owner preview / legacy link: the owner's own signed images, the edition being read.
          const { exportComicPdf } = await import('./export/pdfExport');
          res = await exportComicPdf(doc, safeUrlFor, { lang });
        } else {
          const { exportPngZip } = await import('./export/zipExport');
          res = await exportPngZip(doc, safeUrlFor, { lang });
        }
        setNotice(downloadDoneText(kind, res, kind !== 'zip_all' && nameDownloadLang && downloadLang ? englishName(downloadLang) : undefined));
      } catch (err) {
        setNotice(`Couldn’t prepare the download: ${(err as Error)?.message || 'please try again.'}`);
      } finally {
        setDownloading(null);
      }
    },
    [doc, downloading, allowDownload, mode, publication, urls, lang, safeUrlFor, nameDownloadLang, downloadLang]
  );
  const edition = nameDownloadLang && downloadLang ? ` (${englishName(downloadLang)})` : '';
  const downloadItems: ReaderMenuItem[] =
    allowDownload && localized && exportable.length > 0
      ? [
          { id: 'pdf', label: downloading === 'pdf' ? 'Preparing…' : `Download PDF${edition}`, icon: <FileText className="h-4 w-4" aria-hidden />, onSelect: () => void download('pdf'), disabled: !!downloading },
          { id: 'zip', label: downloading === 'zip' ? 'Preparing…' : `Download page images (.zip)${edition}`, icon: <FileArchive className="h-4 w-4" aria-hidden />, onSelect: () => void download('zip'), disabled: !!downloading },
          ...(mode === 'slug' && exportable.length > 1
            ? [
                {
                  id: 'zip_all',
                  label: downloading === 'zip_all' ? 'Preparing…' : `Download all ${exportable.length} languages (.zip)`,
                  icon: <Languages className="h-4 w-4" aria-hidden />,
                  onSelect: () => void download('zip_all'),
                  disabled: !!downloading
                }
              ]
            : [])
        ]
      : [];
  // The readers' own built-in PDF (the immersive end card, the embed's menu) exports the language on
  // screen: offer it only when that language is one the author published.
  const builtInDownload = allowDownload && (mode === 'project' || readingExportable);
  const moreItems: ReaderMenuItem[] = canReport
    ? [{ id: 'report', label: 'Report this comic', icon: <Flag className="h-4 w-4" aria-hidden />, onSelect: () => setReportOpen(true) }]
    : [];

  const endCard = useMemo(
    () => ({
      authorName: boot?.card.creator,
      onMakeYourOwn: embed || isOwner ? undefined : () => fullNavigate(MAKE_YOUR_OWN_HREF),
      shareUrl
    }),
    [boot?.card.creator, embed, isOwner, shareUrl]
  );

  const openImmersive = (guided: boolean) => {
    if (!doc) return;
    setImmersive({
      guided,
      intro: !guided && start.page === undefined,
      ...(start.page !== undefined ? { page: start.page === 0 ? 'cover' : start.page } : {}),
      ...(guided && start.panel !== undefined ? { panel: start.panel } : {})
    });
  };
  const onShareClick = useCallback(() => {
    if (canTrack) track!('share', lang);
  }, [canTrack, track, lang]);
  // Embeds have no header: the reader's own Share (Web Share, else copy the link).
  const shareNow = useCallback(async () => {
    if (!shareUrl) return;
    onShareClick();
    try {
      const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
      if (typeof nav.share === 'function') {
        await nav.share({ title, url: shareUrl });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setNotice('Link copied');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setNotice('Couldn’t share — copy the link from the address bar instead.');
    }
  }, [shareUrl, onShareClick, title]);

  const coverUrl = (doc && urlFor(doc.cover.render.asset)) || boot?.card.coverUrl;
  const coverAspect = doc?.cover.render.asset?.w && doc.cover.render.asset.h ? doc.cover.render.asset.w / doc.cover.render.asset.h : parseAspect(boot?.card.aspect) ?? (doc ? aspectNumber(doc.format.pageAspect) : undefined);
  const pageCount = doc ? readerItems(doc).filter((i) => i.kind === 'page').length : boot?.card.pageCount;
  const rtl = doc?.format.readingDirection === 'rtl';
  const compact = ff.widthClass === 'compact';

  // ── States ──
  const header = !embed && (
    <header
      className="relative z-30 flex shrink-0 items-center gap-1.5 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] py-1.5 backdrop-blur-md"
      style={{ paddingTop: 'max(6px, var(--sa-top))', paddingLeft: 'max(10px, var(--sa-left))', paddingRight: 'max(10px, var(--sa-right))' }}
      data-testid="public-reader-header"
    >
      {onClose ? (
        <IconButton label={sameLanguage(lang, 'en') ? 'Close reader' : t('close')} onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      ) : (
        <BookOpen className="ml-1 h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />
      )}
      <div className="min-w-0 flex-1 px-1">
        {doc || boot ? (
          <>
            {/* The cover card carries the page's h1; the inline reader's title is the header's. */}
            {React.createElement(view === 'card' && status !== 'not_found' && status !== 'error' ? 'p' : 'h1', { className: 'truncate text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]' }, title)}
            {logline && !compact && <p className="truncate text-[12px] leading-snug text-[var(--ds-muted)]">{logline}</p>}
          </>
        ) : status === 'loading' ? (
          <div className="space-y-1.5 py-0.5" aria-hidden>
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        ) : (
          <p className="text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">Comic</p>
        )}
      </div>
      {status === 'ready' && (
        <div className="flex shrink-0 items-center gap-0.5">
          {rating && !compact && <RatingBadge rating={rating} />}
          {L.slot && <ReaderLanguagePicker {...L.slot} source={source} compact={compact} />}
          {shareUrl && (
            <div
              onClickCapture={(e) => {
                // One share event per share: the trigger (not each item of its fallback menu), and not
                // again for a click on the trigger while that menu is already open.
                const trigger = (e.target as HTMLElement).closest?.('button[aria-haspopup]');
                if (trigger && trigger.getAttribute('aria-expanded') !== 'true') onShareClick();
              }}
            >
              <ShareButton compact target={{ url: shareUrl, title, text: logline || undefined, coverUrl: boot?.card.coverUrl }} />
            </div>
          )}
          {downloadItems.length > 0 && <ReaderMenu label={t('download')} icon={<Download className="h-4 w-4" />} items={downloadItems} />}
          {moreItems.length > 0 && <ReaderMenu label="More" items={moreItems} />}
        </div>
      )}
    </header>
  );

  let main: React.ReactNode;
  if (status === 'not_found') {
    main =
      mode === 'slug' ? (
        <div className="flex h-full items-center justify-center p-6">
          <div role="alert" className="max-w-md rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6 text-center shadow-sm">
            {/* Procedural art only: a dead link must never wake the backend for decoration. */}
            <div className="mb-2 flex justify-center">
              <EmptyArt variant="reader" />
            </div>
            <p className="text-[15px] font-semibold text-[var(--ds-ink)]">This link isn’t active</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ds-muted)]">The creator may have turned this link off.</p>
            {!embed && (
              <a
                href={MAKE_YOUR_OWN_HREF}
                className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
              >
                <Home className="h-4 w-4" aria-hidden /> Go to DreamStream
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <div role="alert" className="max-w-md rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6 text-center shadow-sm">
            <div className="mb-2 flex justify-center">
              <EmptyArt variant="reader" />
            </div>
            <p className="text-[15px] font-semibold text-[var(--ds-ink)]">This comic isn’t available</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ds-muted)]">{errorMessage}</p>
            {onClose && (
              <div className="mt-4 flex justify-center">
                <GhostButton size="sm" onClick={onClose}>
                  Close
                </GhostButton>
              </div>
            )}
          </div>
        </div>
      );
  } else if (status === 'error') {
    main = (
      <div className="flex h-full items-center justify-center p-6">
        <div role="alert" className="max-w-md rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6 text-center shadow-sm">
          <div className="mb-2 flex justify-center">
            <EmptyArt variant="reader" />
          </div>
          <p className="text-[15px] font-semibold text-[var(--ds-ink)]">Couldn’t open this comic</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ds-muted)]">{errorMessage || 'Check your connection and try again.'}</p>
          <div className="mt-4 flex justify-center gap-2">
            <GhostButton size="sm" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
            </GhostButton>
            {onClose && (
              <GhostButton size="sm" onClick={onClose}>
                Close
              </GhostButton>
            )}
          </div>
        </div>
      </div>
    );
  } else if (view === 'card' && (doc || boot)) {
    main = (
      <div className="h-full overflow-y-auto overscroll-contain">
        <ReaderCoverCard
          title={title}
          logline={logline}
          creator={boot?.card.creator}
          coverUrl={coverUrl}
          aspect={coverAspect}
          pageCount={pageCount}
          kindLabel={boot?.card.kindLabel}
          rtl={rtl}
          rating={rating}
          themeColor={boot?.card.themeColor}
          loading={status !== 'ready'}
          onRead={() => openImmersive(false)}
          onGuided={() => openImmersive(true)}
          onReadHere={() => setView('inline')}
          cta={isOwner ? undefined : { label: 'Made with DreamStream Studio — make your own', href: MAKE_YOUR_OWN_HREF }}
          labels={{ read: t('startReading'), guided: t('guidedView'), readsRightToLeft: t('readsRightToLeft') }}
        />
      </div>
    );
  } else if (doc && status === 'ready') {
    main = (
      <ComicReaderView
        doc={doc}
        urlFor={urlFor}
        initialPage={start.page === 0 ? 'cover' : start.page}
        onPageChange={onPageChange}
        syncUrl={mode === 'slug'}
        language={L.slot}
        endCard={endCard}
        chrome={embed || compact ? 'auto-hide' : 'docked'}
        immersiveEntry
        onShare={embed && shareUrl ? () => void shareNow() : undefined}
        // The embed has no header menu: its ⋯ Download goes through the same gated public download.
        onDownload={embed && builtInDownload ? () => void download('pdf') : undefined}
        onReport={
          embed && canReport
            ? (n) => {
                setPage(n);
                setReportOpen(true);
              }
            : undefined
        }
        // The header carries the badge from tablet width up; phones and embeds show it in the toolbar.
        rating={embed || compact ? rating : undefined}
        onImageError={onImageError}
        toolbarExtra={
          embed ? (
            <a
              href={embedOpenHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-xl px-2 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:min-w-[44px]"
            >
              {/* Icon-only in a narrow frame (the name stays for screen readers). Measured in JS: this
                  app's raw `screens` disable Tailwind's max-[…] variants (they emit nothing). */}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> <span className={cx(ff.width > 0 && ff.width <= 400 && 'sr-only')}>Open on DreamStream</span>
            </a>
          ) : undefined
        }
      />
    );
  } else {
    main = (
      <div className="flex h-full items-center justify-center p-6" role="status" aria-live="polite">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <p className="text-center text-[13px] text-[var(--ds-muted)]">Opening the comic…</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cx('flex h-full min-h-0 flex-col', CANVAS_BG)}
      style={embed ? undefined : { paddingBottom: view === 'inline' ? 'var(--sa-bottom)' : undefined }}
      data-testid="public-comic-reader"
      data-view={view}
      data-embed={embed ? 'true' : undefined}
    >
      {header}
      <main
        className="relative min-h-0 flex-1"
        style={
          embed
            ? { paddingTop: 'var(--sa-top)' }
            : // The inline reader's toolbar and page edges stay clear of a landscape notch (the cover
              // card's room runs edge to edge and centres its own content).
              view === 'inline' && status === 'ready'
              ? { paddingLeft: 'var(--sa-left)', paddingRight: 'var(--sa-right)' }
              : undefined
        }
      >
        {main}
        {notice && (
          <p role="status" className="absolute inset-x-3 bottom-3 z-30 mx-auto flex w-fit max-w-[calc(100%-24px)] items-center gap-1.5 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] py-1 pl-3 pr-1 text-[12px] text-[var(--ds-ink)] shadow-sm backdrop-blur-md">
            <span className="min-w-0 [overflow-wrap:anywhere]">{notice}</span>
            <IconButton size="sm" label="Dismiss" onClick={() => setNotice(null)}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </p>
        )}
      </main>

      {immersive && doc && (
        <ImmersiveReader
          doc={doc}
          urlFor={urlFor}
          language={L.slot}
          endCard={endCard}
          intro={immersive.intro}
          initialPage={immersive.page}
          initialGuided={immersive.guided}
          initialPanel={immersive.panel}
          allowDownload={builtInDownload}
          syncUrl={mode === 'slug'}
          onImageError={onImageError}
          onPageChange={onPageChange}
          onExit={() => setImmersive(null)}
        />
      )}
      {canReport && slug && <ReportDialog slug={slug} page={page || undefined} open={reportOpen} onClose={() => setReportOpen(false)} />}
    </div>
  );
};

/** `/c/<slug>`: the edge snapshot + boot card. */
const SlugReader: React.FC<{ slug: string; embed: boolean; isOwner: boolean; identityReady: boolean; start: PublicReaderStart; onClose?: () => void }> = ({
  slug,
  embed,
  isOwner,
  identityReady,
  start,
  onClose
}) => {
  const pc = usePublicComic(slug, { isOwner });
  const embedMode = embed || !!pc.boot?.embed;
  const bootStart = pc.boot?.page !== undefined && start.page === undefined ? { ...start, page: pc.boot.page } : start;
  const { track: rawTrack } = pc;
  const track = useCallback((type: 'view' | 'complete' | 'share', lang?: string) => rawTrack(type, type === 'share' ? 'native' : undefined, lang), [rawTrack]);
  return (
    <ReaderShell
      mode="slug"
      status={pc.status}
      errorMessage={pc.error}
      onRetry={pc.retry}
      doc={pc.data?.doc ?? null}
      urls={pc.data?.urls ?? null}
      boot={pc.boot}
      slug={slug}
      publication={pc.data?.publication ?? null}
      embed={embedMode}
      start={bootStart}
      isOwner={isOwner}
      identityReady={identityReady}
      onClose={onClose}
      track={track}
    />
  );
};

/** `/?view=read&id=` and the owner preview: /api/comic/public/:id with quiet relinking. */
const ProjectReader: React.FC<{ projectId: string; isOwner: boolean; start: PublicReaderStart; onClose?: () => void }> = ({ projectId, isOwner, start, onClose }) => {
  type LoadState = { kind: 'loading' } | { kind: 'ready'; doc: ComicDoc; urls: Record<string, string> } | { kind: 'error'; message: string; notFound: boolean };
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);
  const lastRelink = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (!quiet) setState({ kind: 'loading' });
      try {
        const res = await loadPublicComic(projectId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ kind: 'ready', doc: res.doc, urls: res.urls || {} });
      } catch (err) {
        if (controller.signal.aborted || (err as { kind?: string })?.kind === 'aborted') return;
        // A failed quiet refresh keeps the comic on screen.
        if (quiet) return;
        const e = (err && typeof err === 'object' ? err : {}) as { kind?: string; status?: number; message?: string };
        const notFound = e.kind === 'not_found' || e.status === 404 || e.kind === 'forbidden' || e.status === 403;
        setState({
          kind: 'error',
          notFound,
          message: notFound ? "This comic isn't published, or its creator made it private." : e.message || 'Couldn’t load this comic. Check your connection and try again.'
        });
      }
    },
    [projectId]
  );

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Signed links expire: when an image fails, refetch quietly (rate-limited).
  const onImageError = useCallback(() => {
    const now = Date.now();
    if (now - lastRelink.current < RELINK_COOLDOWN_MS) return;
    lastRelink.current = now;
    void load(true);
  }, [load]);

  const status: Status = state.kind === 'loading' ? 'loading' : state.kind === 'ready' ? 'ready' : state.notFound ? 'not_found' : 'error';
  return (
    <ReaderShell
      mode="project"
      status={status}
      errorMessage={state.kind === 'error' ? state.message : null}
      onRetry={() => void load()}
      doc={state.kind === 'ready' ? state.doc : null}
      urls={state.kind === 'ready' ? state.urls : null}
      onImageError={onImageError}
      boot={null}
      embed={false}
      start={start}
      isOwner={isOwner}
      identityReady
      onClose={onClose}
    />
  );
};

export const PublicComicReader: React.FC<PublicComicReaderProps> = ({ source, projectId, onClose, isOwner = false, identityReady = true, start }) => {
  const resolved: PublicComicSource | null = source ?? (projectId ? { kind: 'project', projectId } : null);
  const [startFromUrl] = useState<PublicReaderStart>(() => start ?? (typeof window !== 'undefined' ? readerStartFromSearch(window.location.search) : {}));
  if (!resolved) return null;
  if (resolved.kind === 'slug') {
    return <SlugReader slug={resolved.slug} embed={!!resolved.embed} isOwner={isOwner} identityReady={identityReady} start={startFromUrl} onClose={onClose} />;
  }
  return <ProjectReader projectId={resolved.projectId} isOwner={isOwner} start={startFromUrl} onClose={onClose} />;
};

export default PublicComicReader;
