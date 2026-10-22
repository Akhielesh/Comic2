// Every saved version of one image (contract §13.3; timeline.md §4.1): a large preview with ←/→,
// what was recorded for it (model, size, cost, QC, how it was made), "Use this version" (FREE,
// optimistic and instant via render_use, with an undo toast), star, and compare. Numbering is
// v1 = oldest — the same numbers the director uses. After a swap the stale badge is honest: an
// older version drawn for an older script shows "Out of date". A character-sheet version that would
// put drawn pages out of date asks first and lists them.

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, SplitSquareHorizontal, Star } from 'lucide-react';
import { getRender, targetLabel, type RenderTarget } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import type { StudioController } from '../types';
import { byokFromDoc } from '../board/boardModel';
import {
  ORIGIN_LABEL,
  assetRatio,
  isBusyRender,
  plural,
  redrawPrice,
  staleImpact,
  renderUseOps,
  versionCostLabel,
  versionList,
  type VersionItem
} from './bookModel';
import { CompareView } from './CompareView';
import { UndoToast, useTimelineEdit } from './UndoToast';
import { Badge, BlockedTile, cx, FOCUS_RING, shortDate } from './ui';

export interface VersionStackProps {
  studio: StudioController;
  target: RenderTarget;
  compact?: boolean;
  /** Open in compare mode (ClipMenu "Compare…"). */
  initialCompare?: boolean;
}

const pagesPhrase = (ns: number[]) => (ns.length === 1 ? `page ${ns[0]}` : `pages ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

export const VersionStack: React.FC<VersionStackProps> = ({ studio, target, compact = false, initialCompare = false }) => {
  const doc = studio.doc;
  const list = useMemo(() => (doc ? versionList(doc, target) : []), [doc, target]);
  const current = list.find((v) => v.current);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(current?.path);
  const [compare, setCompare] = useState(initialCompare && list.length > 1);
  const [confirm, setConfirm] = useState<{ v: VersionItem; pages: number[]; cover: boolean } | null>(null);
  const edit = useTimelineEdit(studio);

  // A selection that vanished (archive eviction, page deleted) falls back to the current version.
  const selected = list.find((v) => v.path === selectedPath) ?? current ?? list[list.length - 1];
  useEffect(() => {
    if (selectedPath && !list.some((v) => v.path === selectedPath)) setSelectedPath(current?.path);
  }, [list, selectedPath, current?.path]);

  if (!doc) return null;
  const label = targetLabel(doc, target);
  if (!list.length || !selected) {
    return compact ? null : <p className="text-[13px] text-[var(--ds-muted)]">{label} isn’t drawn yet, so there are no versions to pick from.</p>;
  }
  const render = getRender(doc, target);
  const busy = isBusyRender(render) || studio.isRendering(target);
  const idx = list.indexOf(selected);
  const ratio = assetRatio(doc, selected.asset);
  const byok = (studio as { byok?: boolean }).byok ?? byokFromDoc(doc);
  const compareWith = selected.current ? list.find((v) => !v.current && v.n === selected.n - 1) ?? list.find((v) => !v.current) : current;

  const commitUse = (v: VersionItem) => {
    setConfirm(null);
    edit.commit(renderUseOps(target, v.path), `${label} now uses v${v.n}`, { label: 'Use version' });
    setSelectedPath(v.path);
  };
  const use = (v: VersionItem) => {
    if (v.current || v.blocked || busy) return;
    if (target.kind === 'sheet' || target.kind === 'place') {
      const impact = staleImpact(doc, target, v.path);
      if (impact.pages.length || impact.cover) {
        setConfirm({ v, pages: impact.pages, cover: impact.cover });
        return;
      }
    }
    commitUse(v);
  };
  const flip = (delta: number) => {
    const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))];
    if (next) setSelectedPath(next.path);
  };
  const star = (v: VersionItem) => {
    if (v.current) return;
    void studio.patch([{ op: 'version_star', path: v.path, starred: !v.starred }], { label: v.starred ? 'Unstar a version' : 'Star a version' });
  };
  const url = selected.blocked ? undefined : studio.urlFor(selected.asset, { width: compact ? 360 : 960 });
  const staleKind = target.kind === 'page' || target.kind === 'cover' ? target.kind : undefined;

  const thumbs = (
    <div
      role="radiogroup"
      aria-label={`${label} versions`}
      className="flex min-w-0 gap-1.5 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const next = list[Math.max(0, Math.min(list.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)))];
          if (next) {
            setSelectedPath(next.path);
            (e.currentTarget.querySelector(`[data-version="${next.n}"]`) as HTMLElement | null)?.focus();
          }
        }
      }}
    >
      {list.map((v) => {
        const on = v.path === selected.path;
        const thumb = v.blocked ? undefined : studio.urlFor(v.asset, { width: 160 });
        return (
          <button
            key={v.path}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-version={v.n}
            aria-label={`v${v.n}${v.current ? ', current' : ''}${v.archived ? ', archived' : ''}${v.stale ? ', out of date' : ''}`}
            onClick={() => setSelectedPath(v.path)}
            className={cx(
              'tap-target relative shrink-0 overflow-hidden rounded-lg border bg-[var(--ds-well)]',
              FOCUS_RING,
              on ? 'border-[var(--ds-accent)] ring-1 ring-[var(--ds-accent)]' : 'border-[var(--ds-hairline)] hover:border-[#D97757]/50'
            )}
            style={{ width: compact ? 44 : 52, aspectRatio: String(assetRatio(doc, v.asset)), maxHeight: compact ? 66 : 80 }}
          >
            {v.blocked ? <BlockedTile compact /> : thumb ? <img src={thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain" draggable={false} /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
            <span className={cx('absolute inset-x-0 bottom-0 py-px text-center text-[9px] font-semibold text-white', v.current ? 'bg-[var(--ds-accent)]' : 'bg-black/55')}>
              v{v.n}
              {v.starred ? ' ★' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );

  const useButton = (
    <button
      type="button"
      disabled={selected.current || selected.blocked || busy}
      onClick={() => use(selected)}
      title={busy ? `${label} is drawing — switch when it's done.` : undefined}
      className={cx(
        'tap-target inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--ds-accent)] px-4 text-[13px] font-semibold text-white hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45',
        FOCUS_RING
      )}
    >
      {selected.current ? 'Current version' : `Use v${selected.n} · Free`}
    </button>
  );

  const badges = (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={selected.current ? 'accent' : 'default'}>
        v{selected.n} of {list.length}
        {selected.current ? ' · current' : ''}
      </Badge>
      {selected.stale && (
        <Badge tone="warn" title="Drawn before the latest script or style changes">
          Out of date
        </Badge>
      )}
      {selected.mismatch && <Badge tone="warn">{selected.shape}, not {doc.format.pageAspect}</Badge>}
      {selected.archived && <Badge>Archived</Badge>}
      {selected.starred && <Badge tone="accent">Starred</Badge>}
      {selected.origin === 'derived' && <Badge tone="ok">Free fit</Badge>}
    </span>
  );

  const confirmBox = confirm && (
    <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12.5px] text-[var(--ds-ink)]">
      <p>
        Using v{confirm.v.n} of {label} marks {[confirm.pages.length ? pagesPhrase(confirm.pages) : '', confirm.cover ? 'the cover' : ''].filter(Boolean).join(' and ')} out of date — they were drawn
        from the current version. Their art stays as it is; redrawing them later would be ≈{' '}
        {formatUsd(redrawPrice(doc, 'page', byok) * confirm.pages.length + (confirm.cover ? redrawPrice(doc, 'cover', byok) : 0))}.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => commitUse(confirm.v)} className={cx('tap-target h-8 rounded-xl bg-[var(--ds-accent)] px-3 text-[12.5px] font-semibold text-white hover:bg-[var(--ds-accent-hover)]', FOCUS_RING)}>
          Use v{confirm.v.n} anyway
        </button>
        <button type="button" onClick={() => setConfirm(null)} className={cx('tap-target h-8 rounded-xl border border-[var(--ds-hairline)] px-3 text-[12.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', FOCUS_RING)}>
          Keep the current one
        </button>
      </div>
    </div>
  );

  const toast = <UndoToast entry={edit.toast} onUndo={edit.undo} onDismiss={edit.dismiss} />;

  if (compact) {
    const meta = [selected.modelLabel, versionCostLabel(selected), typeof selected.qcScore === 'number' ? `QC ${selected.qcScore.toFixed(2)}` : ''].filter(Boolean).join(' · ');
    return (
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-start gap-3">
          <div className="relative w-24 shrink-0 overflow-hidden rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)]" style={{ aspectRatio: String(ratio), maxHeight: 150 }}>
            {selected.blocked ? <BlockedTile compact /> : url ? <img src={url} alt={`${label}, version ${selected.n}`} className="absolute inset-0 h-full w-full object-contain" draggable={false} /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            {badges}
            <p className="truncate text-[11.5px] text-[var(--ds-muted)]">{meta}</p>
            {useButton}
          </div>
        </div>
        {thumbs}
        {confirmBox}
        {toast}
      </div>
    );
  }

  const facts: [string, string][] = [
    ['Model', selected.modelLabel ?? 'Not recorded'],
    ['Size', selected.asset.w && selected.asset.h ? `${selected.asset.w}×${selected.asset.h}${selected.shape ? ` · ${selected.shape}` : ''}` : 'Not recorded'],
    ['Cost', versionCostLabel(selected)],
    ['QC', typeof selected.qcScore === 'number' ? `${selected.qcScore.toFixed(2)}${selected.qcIssues?.length ? ` · ${plural(selected.qcIssues.length, 'note')}` : ''}` : 'Not checked'],
    ['Made by', selected.origin ? ORIGIN_LABEL[selected.origin] : 'Not recorded'],
    ['Made', shortDate(selected.at)]
  ];

  return (
    <div className="min-w-0 space-y-3" role="group" aria-roledescription="version stack" aria-label={`${label}: ${plural(list.length, 'version')}`}>
      {compare && compareWith && compareWith.path !== selected.path ? (
        <CompareView studio={studio} doc={doc} a={compareWith.n < selected.n ? compareWith : selected} b={compareWith.n < selected.n ? selected : compareWith} ratio={ratio} onUse={use} useDisabled={busy} />
      ) : (
        <div
          className="relative mx-auto w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]"
          style={{ aspectRatio: String(ratio), maxWidth: `min(100%, ${Math.round(440 * Math.min(1.6, Math.max(0.6, ratio)))}px)` }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              flip(e.key === 'ArrowRight' ? 1 : -1);
            }
          }}
        >
          {selected.blocked ? <BlockedTile /> : url ? <img src={url} alt={`${label}, version ${selected.n}`} className="absolute inset-0 h-full w-full object-contain" draggable={false} /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
          <button
            type="button"
            onClick={() => flip(-1)}
            disabled={idx <= 0}
            aria-label="Older version"
            className={cx('absolute left-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60 disabled:opacity-30', FOCUS_RING)}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => flip(1)}
            disabled={idx >= list.length - 1}
            aria-label="Newer version"
            className={cx('absolute right-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60 disabled:opacity-30', FOCUS_RING)}
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {badges}
        <div className="flex flex-wrap items-center gap-1.5">
          {!selected.current && (
            <button
              type="button"
              onClick={() => star(selected)}
              aria-pressed={selected.starred}
              title="Starred versions are never removed from the archive"
              className={cx('tap-target inline-flex h-9 items-center gap-1 rounded-xl border border-[var(--ds-hairline)] px-3 text-[12.5px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', FOCUS_RING)}
            >
              <Star className={cx('h-3.5 w-3.5', selected.starred && 'fill-current text-[var(--ds-accent)]')} aria-hidden />
              {selected.starred ? 'Starred' : 'Star'}
            </button>
          )}
          {list.length > 1 && (
            <button
              type="button"
              onClick={() => setCompare((c) => !c)}
              aria-pressed={compare}
              className={cx('tap-target inline-flex h-9 items-center gap-1 rounded-xl border border-[var(--ds-hairline)] px-3 text-[12.5px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', FOCUS_RING)}
            >
              <SplitSquareHorizontal className="h-3.5 w-3.5" aria-hidden />
              Compare
            </button>
          )}
          {useButton}
        </div>
      </div>
      {confirmBox}
      {selected.current && selected.stale && staleKind && (
        <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-[12.5px] text-[var(--ds-ink)]">
          This version was drawn before the latest script or style changes, so it shows as out of date. Pick another version (free) or redraw it (≈{' '}
          {formatUsd(redrawPrice(doc, staleKind, byok))}) from the page menu.
        </p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        {facts.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-[var(--ds-muted)]">{k}</dt>
            <dd className="min-w-0 break-words tabular-nums text-[var(--ds-ink)]">{v}</dd>
          </React.Fragment>
        ))}
        {selected.note && (
          <>
            <dt className="text-[var(--ds-muted)]">Note</dt>
            <dd className="min-w-0 break-words text-[var(--ds-ink)]">“{selected.note}”</dd>
          </>
        )}
      </dl>
      {thumbs}
      {toast}
    </div>
  );
};

export default VersionStack;
