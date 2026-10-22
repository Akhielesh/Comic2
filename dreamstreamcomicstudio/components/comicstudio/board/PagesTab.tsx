// Pages: the plan and the pages it becomes. Plan before pixels — while the plan is a
// draft the header asks for review and shows the honest price of drawing it; every page
// card shows exactly where it stands (planned script → queued → drawing with a clock →
// developed art with balloons → out of date / failed with Retry). Multi-select redraws a
// chosen few; the cover leads the grid.

import React, { useEffect, useMemo, useState } from 'react';
import { BookImage, BookOpen, ChevronDown, ChevronUp, Image as ImageIcon, LayoutGrid, Maximize2, RotateCcw, ScrollText, Sparkles } from 'lucide-react';
import { totalPanels, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import type { StudioController } from '../types';
import { ComicPageView } from './ComicPageView';
import { ImageFrame, VersionStrip } from './ImageFrame';
import { PageScript } from './PageScript';
import { aspectNumber, pageAspectOf } from './balloonGeometry';
import {
  byokFromDoc,
  estimateDraw,
  estimateOne,
  hasImage,
  isBusy,
  jobModel,
  pageVisualStatus,
  pagesForIds,
  pagesToDraw,
  plural,
  renderModelNickname,
  sheetVisualStatus
} from './boardModel';
import { EmptyHint, GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, StatusChip, Surface, cx, useClickGuard } from './ui';

const GRID = 'grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr))]';

// ── Page card ────────────────────────────────────────────────────────────────

export const PageCard: React.FC<{
  studio: StudioController;
  doc: ComicDoc;
  page: Page;
  selected: boolean;
  onToggleSelect: () => void;
  byok: boolean;
}> = ({ studio, doc, page, selected, onToggleSelect, byok }) => {
  const status = pageVisualStatus(doc, page);
  const [showScript, setShowScript] = useState(false);
  const { busyKey, fire } = useClickGuard();
  const imageUrl = studio.urlFor(page.render.asset);
  const drawn = hasImage(page.render);
  const busy = isBusy(page.render);
  const spec = jobModel(doc, 'page');
  const price = estimateDraw(doc, pagesForIds(doc, [page.id]), byok).estimate.usd;
  const render = () => fire('render', () => studio.act({ type: 'render_pages', pageIds: [page.id], force: true }));
  const open = () => studio.openPage(page.id);
  const scriptView = status === 'planned' || status === 'empty' || (drawn && showScript);

  return (
    <Surface
      as="article"
      aria-label={`Page ${page.n}`}
      data-testid="page-card"
      data-status={status}
      className={cx('flex flex-col p-2.5', selected && 'ring-2 ring-[var(--ds-accent)] ring-offset-1 ring-offset-[var(--ds-canvas)]')}
    >
      <header className="mb-2 flex items-center gap-2 px-0.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          disabled={!page.panels.length}
          aria-label={`Select page ${page.n}`}
          className="h-3.5 w-3.5 shrink-0 accent-[#D97757]"
        />
        <h4 className="text-[13px] font-semibold text-[var(--ds-ink)]">Page {page.n}</h4>
        <StatusChip status={status} label={status === 'stale' ? 'Out of date' : undefined} />
        <span className="ml-auto flex items-center">
          {drawn && (
            <IconButton size="sm" label={showScript ? 'Show the art' : 'Show the script'} onClick={() => setShowScript((v) => !v)}>
              {showScript ? <ImageIcon className="h-3.5 w-3.5" /> : <ScrollText className="h-3.5 w-3.5" />}
            </IconButton>
          )}
          <IconButton size="sm" label={`Open page ${page.n}`} onClick={open}>
            <Maximize2 className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      </header>

      {scriptView ? (
        // Same footprint as the drawn page (rows stay aligned); long scripts scroll under a fade.
        <div
          className="max-h-[480px] overflow-y-auto overscroll-contain rounded-xl border border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3 pb-7 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]"
          style={{ aspectRatio: String(pageAspectOf(doc, page)) }}
          tabIndex={0}
          aria-label={`Page ${page.n} script`}
        >
          <PageScript doc={doc} page={page} dense />
        </div>
      ) : (
        <button
          type="button"
          onClick={open}
          aria-label={`Open page ${page.n} in the editor`}
          className="block w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
        >
          <ComicPageView
            doc={doc}
            page={page}
            imageUrl={imageUrl}
            overlay={
              <RenderOverlay
                status={status}
                since={page.render.updatedAt}
                model={renderModelNickname(doc, busy ? undefined : page.render, 'page')}
                typicalSec={spec.latencySec}
                error={page.render.error}
                overImage={drawn && !!imageUrl}
                staleLabel="Out of date — re-render"
                compact
              />
            }
          />
        </button>
      )}

      {status === 'ready' && page.render.error && (
        <p className="mt-1.5 px-0.5 text-[11px] text-amber-700 dark:text-amber-300">{page.render.error}</p>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-1.5 px-0.5">
        {!scriptView && page.summary && <p className="mb-1 line-clamp-2 w-full text-[12px] leading-snug text-[var(--ds-muted)]">{page.summary}</p>}
        {status === 'failed' ? (
          <PrimaryButton size="xs" busy={busyKey === 'render'} onClick={render} title={`Try again (≈ ${formatUsd(price)})`}>
            <RotateCcw className="h-3 w-3" aria-hidden /> Retry
          </PrimaryButton>
        ) : status === 'stale' ? (
          <PrimaryButton size="xs" busy={busyKey === 'render'} onClick={render}>
            Re-render <span className="font-normal opacity-80">≈ {formatUsd(price)}</span>
          </PrimaryButton>
        ) : status === 'planned' ? (
          <GhostButton size="xs" busy={busyKey === 'render'} onClick={render}>
            Render <span className="text-[var(--ds-muted)]">≈ {formatUsd(price)}</span>
          </GhostButton>
        ) : status === 'ready' ? (
          <GhostButton size="xs" busy={busyKey === 'render'} onClick={render} title="Draw this page again from its script">
            Re-render <span className="text-[var(--ds-muted)]">≈ {formatUsd(price)}</span>
          </GhostButton>
        ) : null}
        <GhostButton size="xs" onClick={open}>
          {drawn ? 'Edit' : 'Open'}
        </GhostButton>
      </footer>
    </Surface>
  );
};

// ── Cover ────────────────────────────────────────────────────────────────────

export const CoverCard: React.FC<{ studio: StudioController; doc: ComicDoc; byok: boolean }> = ({ studio, doc, byok }) => {
  const render = doc.cover.render;
  const status = render.status === 'none' ? 'planned' : sheetVisualStatus(render);
  const { busyKey, fire } = useClickGuard();
  const [details, setDetails] = useState(false);
  const url = studio.urlFor(render.asset);
  const a = render.asset;
  const aspect = a?.w && a?.h ? a.w / a.h : aspectNumber(doc.format.pageAspect);
  const price = estimateOne(doc, 'cover', byok).usd;
  const spec = jobModel(doc, 'cover');
  const design = () => fire('cover', () => studio.act({ type: 'render_cover' }));
  const drawn = hasImage(render);
  const title = doc.cover.title || doc.brief.title;

  return (
    <Surface as="article" aria-label="Cover" data-testid="cover-card" data-status={status} className="flex flex-col p-2.5">
      <header className="mb-2 flex items-center gap-2 px-0.5">
        <BookImage className="h-3.5 w-3.5 text-[var(--ds-muted)]" aria-hidden />
        <h4 className="text-[13px] font-semibold text-[var(--ds-ink)]">Cover</h4>
        {status !== 'planned' && <StatusChip status={status} />}
      </header>
      <ImageFrame
        url={url}
        aspect={aspect}
        alt={`Cover of ${title}`}
        render={render}
        tone="paper"
        placeholder={
          <div className="flex h-full flex-col items-center justify-center gap-2 border-2 border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] p-4 text-center">
            <p className="line-clamp-3 text-[15px] font-semibold leading-snug text-[var(--ds-ink)]">{title}</p>
            {doc.cover.tagline && <p className="line-clamp-2 text-[12px] text-[var(--ds-muted)]">{doc.cover.tagline}</p>}
            <p className="mt-1 text-[11px] text-[var(--ds-muted)]">The cover is drawn with the title lettered in.</p>
          </div>
        }
        overlay={
          <RenderOverlay
            status={status}
            since={render.updatedAt}
            model={renderModelNickname(doc, isBusy(render) ? undefined : render, 'cover')}
            typicalSec={spec.latencySec}
            error={render.error}
            onRetry={design}
            overImage={drawn && !!url}
            compact
          />
        }
      />
      <footer className="mt-2 flex flex-wrap items-center gap-1.5 px-0.5">
        {drawn ? (
          <GhostButton size="xs" busy={busyKey === 'cover'} disabled={isBusy(render)} onClick={design}>
            <Sparkles className="h-3 w-3" aria-hidden /> Redesign <span className="text-[var(--ds-muted)]">≈ {formatUsd(price)}</span>
          </GhostButton>
        ) : (
          // Optional extra — kept quiet so the plan's own "render" stays the one primary action.
          <GhostButton size="xs" busy={busyKey === 'cover'} disabled={isBusy(render)} onClick={design}>
            <Sparkles className="h-3 w-3 text-[var(--ds-accent)]" aria-hidden /> Design cover <span className="text-[var(--ds-muted)]">≈ {formatUsd(price)}</span>
          </GhostButton>
        )}
        <GhostButton size="xs" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
          Cover text {details ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
        </GhostButton>
      </footer>
      {details && (
        <div className="mt-2 space-y-1 rounded-xl bg-[var(--ds-well)] p-2">
          <InlineField
            label="Title on the cover"
            showLabel
            value={doc.cover.title || ''}
            placeholder={doc.brief.title}
            onCommit={(v) => void studio.patch([{ op: 'cover', patch: { title: v } }])}
          />
          <InlineField label="Tagline" showLabel value={doc.cover.tagline || ''} placeholder="A short line under the title" onCommit={(v) => void studio.patch([{ op: 'cover', patch: { tagline: v } }])} />
          <InlineField
            label="Cover direction"
            showLabel
            multiline
            value={doc.cover.direction || ''}
            placeholder="What the cover shows (default: the story’s key moment with the leads)"
            onCommit={(v) => void studio.patch([{ op: 'cover', patch: { direction: v } }])}
          />
        </div>
      )}
      <VersionStrip
        className="mt-2 px-0.5"
        render={render}
        aspect={aspect}
        urlFor={(p) => studio.urlFor(p)}
        disabled={isBusy(render)}
        onRestore={(path) => void studio.act({ type: 'restore_render', target: { kind: 'cover' }, path })}
      />
    </Surface>
  );
};

// ── Header ───────────────────────────────────────────────────────────────────

const PlanHeader: React.FC<{
  studio: StudioController;
  doc: ComicDoc;
  byok: boolean;
  selected: Set<string>;
  clearSelection: () => void;
}> = ({ studio, doc, byok, selected, clearSelection }) => {
  const { busyKey, fire } = useClickGuard(3000);
  const all = estimateDraw(doc, pagesToDraw(doc), byok);
  const chosen = estimateDraw(doc, pagesForIds(doc, selected), byok);
  const drawing = doc.pages.filter((p) => isBusy(p.render)).length;
  const drawn = doc.pages.filter((p) => pageVisualStatus(doc, p) === 'ready').length;
  const panels = totalPanels(doc);
  const draft = doc.planStatus !== 'approved';
  const sheetsNote = all.sheets.length ? ` + ${plural(all.sheets.length, 'character sheet')}` : '';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">
            {draft ? 'Plan draft — review the scripts, then render' : `${drawn} of ${plural(doc.pages.length, 'page')} drawn`}
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--ds-muted)]">
            {plural(doc.pages.length, 'page')} · {plural(panels, 'panel')}
            {draft ? ' · nothing is drawn until you approve' : ''}
            {drawing ? ` · drawing ${drawing} now` : ''}
            {` · ${all.estimate.model}${byok ? ' · your key' : ''}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {all.pages.length > 0 && (
            <PrimaryButton
              size="sm"
              busy={busyKey === 'all'}
              onClick={() => fire('all', () => studio.act({ type: 'render_pages' }))}
              title={`${plural(all.pages.length, 'page')}${sheetsNote}`}
            >
              {draft ? 'Approve & render all' : `Render ${all.pages.length === doc.pages.length ? 'all' : `remaining ${all.pages.length}`}`}{' '}
              <span className="font-normal opacity-85">(≈ {formatUsd(all.estimate.usd)})</span>
            </PrimaryButton>
          )}
          {draft && (
            <GhostButton size="sm" busy={busyKey === 'approve'} onClick={() => fire('approve', () => studio.act({ type: 'approve_plan' }))}>
              Approve plan only
            </GhostButton>
          )}
          {drawn > 0 && drawn === doc.pages.length && (
            <GhostButton size="sm" onClick={() => studio.setTab('read')}>
              <BookOpen className="h-3.5 w-3.5" aria-hidden /> Read the comic
            </GhostButton>
          )}
        </div>
      </div>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--ds-well)] px-3 py-2" role="region" aria-label="Selected pages">
          <span className="text-[12px] font-medium text-[var(--ds-ink)]">{plural(selected.size, 'page')} selected</span>
          <PrimaryButton
            size="xs"
            busy={busyKey === 'selected'}
            disabled={!chosen.pages.length}
            onClick={() => {
              const ids = chosen.pages.map((p) => p.id);
              fire('selected', () => studio.act({ type: 'render_pages', pageIds: ids, force: true }));
              clearSelection();
            }}
          >
            Render selected <span className="font-normal opacity-85">(≈ {formatUsd(chosen.estimate.usd)})</span>
          </PrimaryButton>
          <GhostButton size="xs" onClick={clearSelection}>
            Clear
          </GhostButton>
        </div>
      )}
    </div>
  );
};

// ── Tab ──────────────────────────────────────────────────────────────────────

export const PagesTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const byok = byokFromDoc(doc);
  const pages = useMemo(() => [...doc.pages].sort((a, b) => a.n - b.n), [doc.pages]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const { busyKey, fire } = useClickGuard(4000);

  // Drop selections for pages that left the plan.
  const ids = pages.map((p) => p.id).join('|');
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(ids.split('|'));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ids]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!pages.length) {
    return (
      <div className="p-4 sm:p-5">
        <EmptyHint
          icon={<LayoutGrid className="h-8 w-8" />}
          title="No pages planned yet"
          action={
            <PrimaryButton size="sm" busy={busyKey === 'plan'} onClick={() => fire('plan', () => studio.act({ type: 'plan_pages' }))}>
              Plan the pages
            </PrimaryButton>
          }
        >
          When the story is ready, the director writes a script for every page — panels, shots and dialogue — and they appear here for you to
          review. Planning costs a few cents of writing; nothing is drawn until you approve.
        </EmptyHint>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <PlanHeader studio={studio} doc={doc} byok={byok} selected={selected} clearSelection={() => setSelected(new Set())} />
      <div className={GRID}>
        <CoverCard studio={studio} doc={doc} byok={byok} />
        {pages.map((page) => (
          <PageCard
            key={page.id}
            studio={studio}
            doc={doc}
            page={page}
            byok={byok}
            selected={selected.has(page.id)}
            onToggleSelect={() => toggle(page.id)}
          />
        ))}
      </div>
    </div>
  );
};
