// Lightbox for one image of the media bin (timeline.md §4.3): the image, ←/→ through the filtered
// set, what was recorded for it and everything that uses it, and the free actions — put it on a
// page or the cover, use it as a reference, make it the style board, star it, restore a deleted
// page, compare with the current version, download it. Nothing here spends money.

import React, { useId, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, RotateCcw, SplitSquareHorizontal, Star } from 'lucide-react';
import { findPage, getRender, type ComicDoc, type RefOwner, type RenderTarget } from '../../../shared/comic/doc';
import { capFor, refsOf } from '../../../shared/comic/refs';
import { downloadBlob } from '../../../services/download';
import type { StudioController } from '../types';
import {
  ORIGIN_LABEL,
  assetRatio,
  canAddPage,
  downloadName,
  isArtRole,
  isBusyRender,
  mismatchText,
  sortedPages,
  renderUseOps,
  versionCostLabel,
  versionList,
  type MediaItem
} from './bookModel';
import { CompareView } from './CompareView';
import type { TimelineEdit } from './UndoToast';
import { Badge, BlockedTile, cx, FOCUS_RING, shortDate } from './ui';

const ROLE_LABEL: Record<MediaItem['role'], string> = {
  page: 'Page art',
  cover: 'Cover art',
  sheet: 'Character sheet',
  place: 'Place sheet',
  style_option: 'Style option',
  style_board: 'Style board',
  ref: 'Reference photo',
  attachment: 'Chat upload',
  inbox: 'Upload',
  deleted_page: 'Deleted page'
};

const btn = cx('tap-target inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[12.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-45', FOCUS_RING);
const primary = cx('tap-target inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--ds-accent)] px-3 text-[12.5px] font-semibold text-white hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45', FOCUS_RING);
const select = 'h-9 min-w-0 max-w-full flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 text-[16px] text-[var(--ds-ink)] sm:text-[12.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

type RefChoice = { key: string; label: string; owner: RefOwner };

const refChoices = (doc: ComicDoc): RefChoice[] => [
  ...doc.cast.map((c) => ({ key: `character:${c.id}`, label: c.name, owner: { kind: 'character', id: c.id } as RefOwner })),
  ...doc.places.map((p) => ({ key: `place:${p.id}`, label: `${p.name} (place)`, owner: { kind: 'place', id: p.id } as RefOwner })),
  { key: 'style', label: 'The style', owner: { kind: 'style' } as RefOwner }
];

export interface MediaPreviewProps {
  studio: StudioController;
  doc: ComicDoc;
  items: MediaItem[];
  index: number;
  onIndex(i: number): void;
  edit: TimelineEdit;
}

export const MediaPreview: React.FC<MediaPreviewProps> = ({ studio, doc, items, index, onIndex, edit }) => {
  const item = items[Math.max(0, Math.min(items.length - 1, index))];
  const pages = sortedPages(doc);
  const [pageId, setPageId] = useState<string>(pages[0]?.id ?? '');
  const choices = refChoices(doc);
  const [refKey, setRefKey] = useState<string>(choices[0]?.key ?? 'style');
  const [confirm, setConfirm] = useState<{ target: RenderTarget; label: string; why: string } | null>(null);
  const [compare, setCompare] = useState(false);
  const [boardConfirm, setBoardConfirm] = useState(false);
  const [note, setNote] = useState('');
  const pageSelId = useId();
  const refSelId = useId();
  if (!item) return null;
  const url = item.blocked ? undefined : studio.urlFor(item.asset, { width: 1080 });
  const ratio = assetRatio(doc, item.asset);
  const go = (d: number) => {
    setCompare(false);
    setConfirm(null);
    setBoardConfirm(false);
    setNote('');
    onIndex(Math.max(0, Math.min(items.length - 1, index + d)));
  };

  const putOn = (target: RenderTarget, label: string, confirmed = false) => {
    const render = getRender(doc, target);
    if (!render) return setNote(`${label} is no longer in the book.`);
    if (isBusyRender(render)) return setNote(`${label} is still drawing — use the image when it's done.`);
    if (render.asset?.path === item.path) return setNote(`It's already on ${label.toLowerCase()}.`);
    const off = mismatchText(doc, item.w, item.h);
    if (off && !confirmed) return setConfirm({ target, label, why: `This image is ${off}. It will look letterboxed — you can fit it to ${doc.format.pageAspect} for free afterwards.` });
    setConfirm(null);
    edit.commit(renderUseOps(target, item.path, { adopt: !isArtRole(item.role) }), `${label} now uses this image`, { label: 'Use image' });
    setNote(`Done — ${label.toLowerCase()} uses this image now (free). The previous art is kept in its versions.`);
  };

  const choice = choices.find((c) => c.key === refKey);
  const refs = choice ? refsOf(doc, choice.owner) ?? [] : [];
  const refFull = !!choice && refs.length >= capFor(choice.owner);
  const alreadyRef = refs.some((r) => r.path === item.path);
  const addRef = () => {
    if (!choice || refFull || alreadyRef) return;
    edit.commit([{ op: 'ref_add', owner: choice.owner, ref: { ...item.asset, addedBy: 'user' } }], `Added as a reference for ${choice.label}`, { label: 'Add a reference' });
    setNote(`Added as a reference for ${choice.label} — the next drawings will use it.`);
  };
  const drawnPages = pages.filter((p) => p.render.status === 'ready' && !!p.render.asset).length;
  const setBoard = (confirmed = false) => {
    // A new style board changes what every page is drawn from: say what goes out of date first.
    if (drawnPages && !confirmed) return setBoardConfirm(true);
    setBoardConfirm(false);
    edit.commit([{ op: 'style', patch: { board: item.asset } }], 'Style board set', { label: 'Set the style board' });
    setNote(drawnPages ? 'This is the style board now. Drawn pages show as out of date until redrawn in the new style (their art stays).' : 'This is the style board now — new drawings follow it.');
  };
  const download = async () => {
    const signed = studio.urlFor(item.asset);
    if (!signed) return setNote('The download link is still loading — try again in a moment.');
    try {
      const res = await fetch(signed);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      downloadBlob(await res.blob(), downloadName(doc, item));
    } catch {
      setNote("Couldn't download that image right now. Check your connection and try again.");
    }
  };

  const target = item.owner.target;
  const versions = target && !item.current ? versionList(doc, target) : [];
  const currentV = versions.find((v) => v.current);
  const thisV = versions.find((v) => v.path === item.path);
  const restorePage = () => {
    if (!item.deletedPageId) return;
    if (!canAddPage(doc, studio.caps?.maxPages)) return setNote('This comic is at its page limit — delete a page first.');
    edit.commit([{ op: 'page_restore', id: item.deletedPageId }], `Restored the deleted page`, { label: 'Restore a page' });
    setNote(`Restored as page ${Math.min(item.deletedFromN ?? 1, pages.length + 1)} with its art and versions.`);
  };
  const facts: [string, string][] = [
    ['What', ROLE_LABEL[item.role]],
    ['Version', item.versionLabel ?? '—'],
    ['Model', item.modelLabel ?? (item.source === 'upload' ? 'Uploaded' : 'Not recorded')],
    ['Size', item.w && item.h ? `${item.w}×${item.h}` : 'Not recorded'],
    ['Cost', versionCostLabel(item)],
    ['QC', typeof item.qcScore === 'number' ? item.qcScore.toFixed(2) : 'Not checked'],
    ['Made by', item.origin ? ORIGIN_LABEL[item.origin] : item.source === 'upload' ? 'Uploaded' : 'Not recorded'],
    ['Added', shortDate(item.at)]
  ];

  return (
    <div
      className="min-w-0 space-y-3"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          go(e.key === 'ArrowRight' ? 1 : -1);
        }
      }}
    >
      {compare && currentV && thisV ? (
        <CompareView studio={studio} doc={doc} a={thisV.n < currentV.n ? thisV : currentV} b={thisV.n < currentV.n ? currentV : thisV} ratio={ratio} />
      ) : (
        <div className="relative mx-auto w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]" style={{ aspectRatio: String(ratio), maxWidth: `min(100%, ${Math.round(460 * Math.min(1.6, Math.max(0.6, ratio)))}px)` }}>
          {item.blocked ? <BlockedTile /> : url ? <img src={url} alt={`${item.owner.label}${item.versionLabel ? `, ${item.versionLabel}` : ''}`} className="absolute inset-0 h-full w-full object-contain" draggable={false} /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
          <button type="button" onClick={() => go(-1)} disabled={index <= 0} aria-label="Previous image" className={cx('absolute left-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60 disabled:opacity-30', FOCUS_RING)}>
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <button type="button" onClick={() => go(1)} disabled={index >= items.length - 1} aria-label="Next image" className={cx('absolute right-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60 disabled:opacity-30', FOCUS_RING)}>
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[13px] font-semibold text-[var(--ds-ink)]">{item.owner.label}</span>
        {item.current && <Badge tone="accent">In use</Badge>}
        {item.archived && <Badge>Archived</Badge>}
        {item.starred && <Badge tone="accent">Starred</Badge>}
        {item.stale && <Badge tone="warn">Out of date</Badge>}
        {item.role === 'deleted_page' && <Badge tone="danger">Deleted</Badge>}
        <span className="ml-auto text-[11.5px] tabular-nums text-[var(--ds-muted)]">
          {index + 1} / {items.length}
        </span>
      </div>
      {note && (
        <p role="status" className="rounded-xl bg-[var(--ds-well)] px-3 py-2 text-[12.5px] text-[var(--ds-ink)]">
          {note}
        </p>
      )}
      {confirm && (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12.5px] text-[var(--ds-ink)]">
          <p>{confirm.why}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={() => putOn(confirm.target, confirm.label, true)}>
              Use it anyway · Free
            </button>
            <button type="button" className={btn} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {boardConfirm && (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12.5px] text-[var(--ds-ink)]">
          <p>
            A new style board marks {drawnPages === 1 ? 'the drawn page' : `all ${drawnPages} drawn pages`} out of date — their art stays as it is, and only a redraw (paid, quoted) would
            restyle them.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={() => setBoard(true)}>
              Set it anyway · Free
            </button>
            <button type="button" className={btn} onClick={() => setBoardConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!item.blocked && (
        <div className="space-y-2">
          {item.deletedPageId ? (
            <button type="button" className={primary} onClick={restorePage}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Restore this page · Free
            </button>
          ) : (
            <>
              {pages.length > 0 && (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={pageSelId}>
                    Page to put this image on
                  </label>
                  <select id={pageSelId} className={select} value={pageId} onChange={(e) => setPageId(e.target.value)}>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        Page {p.n}
                      </option>
                    ))}
                  </select>
                  <button type="button" className={btn} disabled={!findPage(doc, pageId)} onClick={() => putOn({ kind: 'page', id: pageId }, `Page ${findPage(doc, pageId)?.n ?? ''}`)}>
                    Use for this page
                  </button>
                  <button type="button" className={btn} onClick={() => putOn({ kind: 'cover' }, 'The cover')}>
                    Use as cover
                  </button>
                </div>
              )}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={refSelId}>
                  Use as a reference for
                </label>
                <select id={refSelId} className={select} value={refKey} onChange={(e) => setRefKey(e.target.value)}>
                  {choices.map((c) => (
                    <option key={c.key} value={c.key}>
                      Reference for {c.label}
                    </option>
                  ))}
                </select>
                <button type="button" className={btn} disabled={refFull || alreadyRef} onClick={addRef} title={refFull ? 'That reference list is full.' : alreadyRef ? 'Already a reference there.' : undefined}>
                  {alreadyRef ? 'Already a reference' : refFull ? 'References full' : 'Use as reference'}
                </button>
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {item.role !== 'deleted_page' && item.role !== 'style_board' && (
              <button type="button" className={btn} disabled={doc.style.board?.path === item.path} onClick={() => setBoard()}>
                Set as style board
              </button>
            )}
            {item.canStar && (
              <button type="button" className={btn} aria-pressed={item.starred} onClick={() => void studio.patch([{ op: 'version_star', path: item.path, starred: !item.starred }], { label: item.starred ? 'Unstar a version' : 'Star a version' })}>
                <Star className={cx('h-3.5 w-3.5', item.starred && 'fill-current text-[var(--ds-accent)]')} aria-hidden />
                {item.starred ? 'Starred' : 'Star (keep forever)'}
              </button>
            )}
            {currentV && thisV && (
              <button type="button" className={btn} aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
                <SplitSquareHorizontal className="h-3.5 w-3.5" aria-hidden />
                Compare with current
              </button>
            )}
            <button type="button" className={btn} onClick={() => void download()}>
              <Download className="h-3.5 w-3.5" aria-hidden />
              Download
            </button>
          </div>
        </div>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        {facts.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-[var(--ds-muted)]">{k}</dt>
            <dd className="min-w-0 break-words tabular-nums text-[var(--ds-ink)]">{v}</dd>
          </React.Fragment>
        ))}
        {item.note && (
          <>
            <dt className="text-[var(--ds-muted)]">Note</dt>
            <dd className="min-w-0 break-words text-[var(--ds-ink)]">“{item.note}”</dd>
          </>
        )}
        <dt className="text-[var(--ds-muted)]">Used by</dt>
        <dd className="min-w-0 break-words text-[var(--ds-ink)]">{item.usedBy.join(' · ')}</dd>
      </dl>
    </div>
  );
};

export default MediaPreview;
