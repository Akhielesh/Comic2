// Comic History — one page then and now (versions plan §5 "Page compare", §8 "Compare"; package H5).
//
// Both sides render with ComicPageView on the reassembled, normalized books, lettered as readers see them in the
// chosen language (localizeDoc; L hides the lettering for clean art). Desktop: side by side. Phone: Then | Now |
// Swipe | Blink (44 px), Swipe by default — the timeline CompareView's reveal slider. Blink is manual (tap the page
// or press B); Auto-blink is offered only when motion is allowed (never under reduced motion). Changed panels are
// outlined (QC panel boxes, else the changed lines' balloons) with the word "Changed". When the art differs, the
// facts table is the timeline's compareRows (model, size, cost in the viewer's words, QC, made by, note).
// Under the page: each changed panel with a word diff per line and a 44 px "Use then" for the line or the panel,
// plus the page menu (whole page · text only · art only). Every "Use then" is free and sends one RestoreScope.

import React, { useEffect, useId, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { Balloon, ComicDoc, Line, Page, Panel } from '../../../shared/comic/doc';
import { localizeDoc } from '../../../shared/comic/i18n';
import type { LineDiff, PageDiff, PanelDiff, RestorePart, RestoreScope } from '../../../shared/comic/history/types';
import { FOCUS_RING, RADIUS_CONTROL, SEGMENTED_ACTIVE, SEGMENTED_ITEM, SEGMENTED_TRACK } from '../../chat/studioDesign';
import { ComicPageView } from '../board/ComicPageView';
import { compareRows } from '../timeline/CompareView';
import { versionList } from '../timeline/bookModel';
import { lineLanguageStatus, lineScope, lineTextIn, pageScope, panelScope } from './historyModel';
import { WordDiff } from './WordDiff';
import { cx, IconBtn, Mark, Overline, QuietBtn } from './ui';

export type PageCompareMode = 'side' | 'then' | 'now' | 'swipe' | 'blink';
/** Auto-blink period (only when motion is allowed). */
export const AUTO_BLINK_MS = 700;

export interface PageCompareProps {
  thenDoc: ComicDoc;
  nowDoc: ComicDoc;
  /** The live book ("Use then" re-inserts a page deleted since). */
  live: ComicDoc | null;
  diff: PageDiff;
  urlFor(asset: string | undefined | null, opts?: { width?: number }): string | undefined;
  lang: string;
  phone: boolean;
  reducedMotion: boolean;
  thenLabel: string;
  nowLabel: string;
  /** "Page 3 · 2 of 4 changed". */
  position?: { index: number; total: number };
  onPrev?(): void;
  onNext?(): void;
  /** null when this compare can't take pieces back (both sides are not a saved moment and now). */
  onUseThen?: ((scope: RestoreScope) => void) | null;
  /** Why "Use then" is unavailable right now ("Page 3 is still drawing…"). */
  blockedReason?: string | null;
  /** Viewer-terms money for the facts table. */
  money(usd: number): string;
}

const pageOf = (doc: ComicDoc, id: string): Page | undefined => doc.pages.find((p) => p.id === id);
const lineOf = (page: Page | undefined, id: string): { line: Line; panel: Panel } | undefined => {
  for (const panel of page?.panels || []) for (const line of panel.lines) if (line.id === id) return { line, panel };
  return undefined;
};

/** Changed panels' outlines: QC panel boxes, else the changed lines' balloons (page-normalized boxes). */
const changedBoxes = (page: Page | undefined, diff: PageDiff): { key: string; x: number; y: number; w: number; h: number }[] => {
  if (!page) return [];
  const out: { key: string; x: number; y: number; w: number; h: number }[] = [];
  const qc = page.render.qc?.panelBoxes;
  for (const pd of diff.panels) {
    if (pd.status === 'removed') continue;
    const panel = page.panels.find((p) => p.id === pd.panelId);
    if (!panel) continue;
    const box = qc?.[panel.n - 1];
    if (box) {
      out.push({ key: pd.panelId, ...box });
      continue;
    }
    const ids = new Set(pd.lines.map((l) => l.lineId));
    const bs = page.balloons.filter((b: Balloon) => ids.has(b.lineId));
    if (!bs.length) continue;
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    const r = Math.max(...bs.map((b) => b.x + b.w));
    const btm = Math.max(...bs.map((b) => b.y + 0.12)); // balloons store a width only: an honest estimate of the height
    out.push({ key: pd.panelId, x, y, w: Math.max(0.05, r - x), h: Math.max(0.05, btm - y) });
  }
  return out;
};

const FIELD_WORDS: Record<string, string> = { action: 'action', shot: 'shot', mood: 'mood', castIds: 'who is in it', size: 'size', angle: 'angle', placeId: 'place' };

const ChangedOutlines: React.FC<{ boxes: ReturnType<typeof changedBoxes> }> = ({ boxes }) => (
  <>
    {boxes.map((b) => (
      <span
        key={b.key}
        className="pointer-events-none absolute rounded-[var(--ds-radius-sm)] border-2 border-dashed border-[var(--ds-ink)]"
        style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
      >
        <span className="absolute left-0 top-0 -translate-y-full rounded-[var(--ds-radius-sm)] bg-[var(--ds-ink)] px-1 text-[10px] font-semibold leading-4 text-[var(--ds-canvas)]">Changed</span>
      </span>
    ))}
  </>
);

export const PageCompare: React.FC<PageCompareProps> = ({
  thenDoc,
  nowDoc,
  live,
  diff,
  urlFor,
  lang,
  phone,
  reducedMotion,
  thenLabel,
  nowLabel,
  position,
  onPrev,
  onNext,
  onUseThen,
  blockedReason,
  money
}) => {
  const [mode, setMode] = useState<PageCompareMode>(phone ? 'swipe' : 'side');
  const [lettering, setLettering] = useState(true);
  const [blink, setBlink] = useState<'then' | 'now'>('then');
  const [auto, setAuto] = useState(false);
  const [pos, setPos] = useState(50);
  const [menu, setMenu] = useState(false);
  const sliderId = useId();
  useEffect(() => setMode(phone ? 'swipe' : 'side'), [phone]);
  // Auto-blink only while motion is allowed; reduced motion stops it at once.
  const autoOn = auto && mode === 'blink' && !reducedMotion;
  useEffect(() => {
    if (!autoOn) return;
    const t = setInterval(() => setBlink((b) => (b === 'then' ? 'now' : 'then')), AUTO_BLINK_MS);
    return () => clearInterval(t);
  }, [autoOn]);

  const thenL = useMemo(() => localizeDoc(thenDoc, lang), [thenDoc, lang]);
  const nowL = useMemo(() => localizeDoc(nowDoc, lang), [nowDoc, lang]);
  const thenPage = pageOf(thenL, diff.pageId);
  const nowPage = pageOf(nowL, diff.pageId);
  const n = nowPage?.n ?? thenPage?.n ?? diff.toN ?? diff.fromN;
  const boxes = changedBoxes(nowPage, diff);

  const side = (which: 'then' | 'now') => {
    const doc = which === 'then' ? thenL : nowL;
    const page = which === 'then' ? thenPage : nowPage;
    if (!page) {
      return (
        <div className={cx('flex aspect-[2/3] w-full items-center justify-center border border-dashed border-[var(--ds-hairline)] p-4 text-center text-[12.5px] text-[var(--ds-muted)]', RADIUS_CONTROL)}>
          {which === 'then' ? 'This page didn’t exist then.' : 'This page is in Deleted now.'}
        </div>
      );
    }
    return (
      <ComicPageView
        doc={doc}
        page={page}
        imageUrl={urlFor(page.render.asset?.path, { width: 720 })}
        hideLettering={!lettering}
        editable={false}
        alt={`Page ${page.n}, ${which === 'then' ? thenLabel : nowLabel}`}
        overlay={which === 'now' && boxes.length ? <ChangedOutlines boxes={boxes} /> : undefined}
      />
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'b') {
      e.preventDefault();
      setMode((m) => (m === 'blink' ? m : 'blink'));
      setBlink((b) => (b === 'then' ? 'now' : 'then'));
    } else if (k === 'l') {
      e.preventDefault();
      setLettering((v) => !v);
    } else if (e.key === 'ArrowLeft' && onPrev) {
      e.preventDefault();
      onPrev();
    } else if (e.key === 'ArrowRight' && onNext) {
      e.preventDefault();
      onNext();
    }
  };

  const modes: { id: PageCompareMode; label: string }[] = phone
    ? [
        { id: 'then', label: 'Then' },
        { id: 'now', label: 'Now' },
        { id: 'swipe', label: 'Swipe' },
        { id: 'blink', label: 'Blink' }
      ]
    : [
        { id: 'side', label: 'Side by side' },
        { id: 'swipe', label: 'Swipe' },
        { id: 'blink', label: 'Blink' }
      ];

  // The facts table: what was recorded for the two drawings (only when the art differs).
  const facts = useMemo(() => {
    if (!diff.art || !thenPage?.render.asset || !nowPage?.render.asset) return null;
    const a = versionList(thenDoc, { kind: 'page', id: diff.pageId }).find((v) => v.current);
    const b = versionList(nowDoc, { kind: 'page', id: diff.pageId }).find((v) => v.current);
    return a && b ? compareRows(a, b, money) : null;
  }, [diff.art, diff.pageId, thenDoc, nowDoc, thenPage, nowPage, money]);

  const can = !!onUseThen && !blockedReason;
  const use = (scope: RestoreScope) => {
    if (can) onUseThen!(scope);
  };
  const usePage = (part: RestorePart) => use(pageScope(diff.pageId, part, live));
  const speakerName = (id?: string) => (id ? nowDoc.cast.find((c) => c.id === id)?.name ?? thenDoc.cast.find((c) => c.id === id)?.name ?? 'Someone' : undefined);
  const isSource = lang === nowDoc.format.language;

  // Lines to show per panel: the source diff, or (in an edition) every line whose translation differs.
  const panels: PanelDiff[] = isSource
    ? diff.panels
    : (() => {
        const ids = new Set<string>();
        for (const p of [...(thenPage?.panels || []), ...(nowPage?.panels || [])]) for (const l of p.lines) ids.add(l.id);
        const byPanel = new Map<string, LineDiff[]>();
        for (const id of ids) {
          const a = lineOf(pageOf(thenDoc, diff.pageId), id);
          const b = lineOf(pageOf(nowDoc, diff.pageId), id);
          const ta = a ? lineTextIn(thenDoc, lang, a.line) : '';
          const tb = b ? lineTextIn(nowDoc, lang, b.line) : '';
          if (ta === tb) continue;
          const panelId = (b || a)!.panel.id;
          const list = byPanel.get(panelId) || [];
          list.push({ lineId: id, status: !a ? 'added' : !b ? 'removed' : 'changed' });
          byPanel.set(panelId, list);
        }
        return [...byPanel.entries()].map(([panelId, lines]) => ({ panelId, status: 'changed' as const, fields: [], lines }));
      })();

  const lineRow = (ld: LineDiff) => {
    const a = lineOf(pageOf(thenDoc, diff.pageId), ld.lineId);
    const b = lineOf(pageOf(nowDoc, diff.pageId), ld.lineId);
    const line = (b || a)!.line;
    const speaker = speakerName(line.speakerId);
    const status = !isSource && b ? lineLanguageStatus(nowDoc, lang, b.line) : null;
    const words = isSource && ld.words ? <WordDiff parts={ld.words} lang={lang} /> : <WordDiff from={a ? lineTextIn(thenDoc, lang, a.line) : ''} to={b ? lineTextIn(nowDoc, lang, b.line) : ''} lang={lang} />;
    return (
      <li key={ld.lineId} className="flex min-w-0 flex-wrap items-start gap-2 py-1.5" data-line-diff={ld.lineId}>
        <div className="min-w-0 flex-1 text-[13.5px] leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]">
          <span className="mr-1 text-[12px] font-semibold text-[var(--ds-muted)]">
            {speaker ? `${speaker}:` : line.kind === 'caption' ? 'Caption:' : line.kind === 'sfx' ? 'Sound:' : ''}
          </span>
          {ld.status === 'removed' && <span className="sr-only">This line was removed since then. </span>}
          {ld.status === 'added' && <span className="sr-only">This line is new since then. </span>}
          {words}
          {ld.speaker && <span className="block text-[12px] text-[var(--ds-muted)]">Speaker changed: {speakerName(ld.speaker[0]) ?? 'nobody'} → {speakerName(ld.speaker[1]) ?? 'nobody'}</span>}
          {ld.kind && <span className="block text-[12px] text-[var(--ds-muted)]">Kind changed: {ld.kind[0]} → {ld.kind[1]}</span>}
          {status && <span className="mt-0.5 block text-[12px] text-[var(--ds-muted)]">{status}</span>}
        </div>
        {a && onUseThen !== null && (
          <QuietBtn onClick={() => use(lineScope(diff.pageId, ld.lineId))} disabled={!can} aria-label={`Use then: this line (free)`} data-use-then="line">
            Use then
          </QuietBtn>
        )}
      </li>
    );
  };

  return (
    <section aria-label={`Page ${n ?? ''}: then and now`} className="min-w-0" data-page-compare={diff.pageId}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-2">
        {position && (
          <p className="m-0 min-w-0 flex-1 text-[13px] font-medium tabular-nums text-[var(--ds-ink)]">
            Page {n ?? ''} · {position.index + 1} of {position.total} changed
            {diff.status === 'moved' && diff.fromN ? ` · Moved from ${diff.fromN}` : ''}
          </p>
        )}
        <IconBtn label="Previous changed page" onClick={onPrev} disabled={!onPrev}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </IconBtn>
        <IconBtn label="Next changed page" onClick={onNext} disabled={!onNext}>
          <ChevronRight className="h-4 w-4" aria-hidden />
        </IconBtn>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pb-2">
        <div role="radiogroup" aria-label="Show" className={cx(SEGMENTED_TRACK, 'flex-1')}>
          {modes.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)} className={cx(SEGMENTED_ITEM, 'min-h-11', mode === m.id && SEGMENTED_ACTIVE)}>
              {m.label}
            </button>
          ))}
        </div>
        <QuietBtn onClick={() => setLettering((v) => !v)} aria-pressed={!lettering} aria-keyshortcuts="L">
          {lettering ? 'Hide words' : 'Show words'}
        </QuietBtn>
      </div>
      <div role="group" tabIndex={0} onKeyDown={onKeyDown} aria-label="Page compare. B blinks, L shows or hides the words, arrow keys move between changed pages." className={cx('min-w-0 px-4', FOCUS_RING)}>
        {mode === 'side' && (
          <div className="grid min-w-0 grid-cols-2 gap-3">
            <figure className="m-0 min-w-0">
              {side('then')}
              <figcaption className="mt-1 text-[12px] font-semibold text-[var(--ds-muted)]">Then · {thenLabel}</figcaption>
            </figure>
            <figure className="m-0 min-w-0">
              {side('now')}
              <figcaption className="mt-1 text-[12px] font-semibold text-[var(--ds-muted)]">Now · {nowLabel}</figcaption>
            </figure>
          </div>
        )}
        {(mode === 'then' || mode === 'now') && (
          <figure className="m-0 min-w-0">
            {side(mode)}
            <figcaption className="mt-1 text-[12px] font-semibold text-[var(--ds-muted)]">{mode === 'then' ? `Then · ${thenLabel}` : `Now · ${nowLabel}`}</figcaption>
          </figure>
        )}
        {mode === 'swipe' && (
          <div className="min-w-0">
            <div className="relative min-w-0">
              {side('now')}
              <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} data-swipe-then>
                {side('then')}
              </div>
              <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--ds-ink)]" style={{ left: `${pos}%` }} aria-hidden />
            </div>
            <label htmlFor={sliderId} className="sr-only">
              Reveal then and now
            </label>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={100}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
              aria-valuetext={`${pos}% then`}
              className={cx('mt-2 block h-11 min-h-11 w-full accent-[var(--ds-ink)]', FOCUS_RING)}
            />
          </div>
        )}
        {mode === 'blink' && (
          <div className="min-w-0">
            <div onClick={() => setBlink((b) => (b === 'then' ? 'now' : 'then'))} data-blink={blink} className="min-w-0 cursor-pointer">
              {side(blink)}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <p className="m-0 min-w-0 flex-1 text-[12px] font-semibold text-[var(--ds-muted)]" aria-live="polite">
                {blink === 'then' ? `Then · ${thenLabel}` : `Now · ${nowLabel}`}
              </p>
              <QuietBtn onClick={() => setBlink((b) => (b === 'then' ? 'now' : 'then'))} aria-keyshortcuts="B" data-blink-toggle>
                {blink === 'then' ? 'Show now' : 'Show then'}
              </QuietBtn>
              {!reducedMotion && (
                <QuietBtn onClick={() => setAuto((v) => !v)} aria-pressed={auto} data-auto-blink>
                  {auto ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                  {auto ? 'Stop blinking' : 'Auto-blink'}
                </QuietBtn>
              )}
            </div>
          </div>
        )}
      </div>

      {facts && (
        <table className="mx-4 my-3 w-[calc(100%-2rem)] table-fixed border-collapse text-[12px]">
          <caption className="sr-only">What was recorded for each drawing</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className="w-[28%] py-1" />
              <th scope="col" className="py-1 text-[11px] font-semibold text-[var(--ds-muted)]">
                Then
              </th>
              <th scope="col" className="py-1 text-[11px] font-semibold text-[var(--ds-muted)]">
                Now
              </th>
            </tr>
          </thead>
          <tbody>
            {facts.map((r) => (
              <tr key={r.label} className={cx('border-t border-[var(--ds-hairline)]', r.differs && 'bg-[var(--ds-accent-soft)]')}>
                <th scope="row" className="py-1.5 pr-2 text-left font-medium text-[var(--ds-muted)]">
                  {r.label}
                </th>
                <td className="break-words py-1.5 pr-2 tabular-nums text-[var(--ds-ink)]">{r.a}</td>
                <td className="break-words py-1.5 tabular-nums text-[var(--ds-ink)]">{r.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {blockedReason && <p className="m-0 px-4 py-2 text-[12.5px] text-[var(--ds-muted)]">{blockedReason}</p>}

      {onUseThen !== null && thenPage && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-2">
          <QuietBtn aria-expanded={menu} onClick={() => setMenu((m) => !m)} disabled={!can}>
            {nowPage ? 'Use then for this page…' : 'Bring this page back…'}
          </QuietBtn>
          <span className="text-[12px] text-[var(--ds-muted)]">Free</span>
          {menu && (
            <div role="group" aria-label="What to bring back" className="flex w-full min-w-0 flex-wrap gap-2">
              <QuietBtn onClick={() => usePage('all')} data-use-then="page-all">
                Whole page
              </QuietBtn>
              {nowPage && (
                <>
                  <QuietBtn onClick={() => usePage('text')} data-use-then="page-text">
                    Text only
                  </QuietBtn>
                  <QuietBtn onClick={() => usePage('art')} data-use-then="page-art" disabled={!thenPage.render.asset}>
                    Art only
                  </QuietBtn>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {panels.length > 0 && (
        <div className="min-w-0 px-4 pb-3">
          <Overline as="h3" className="py-2">
            {isSource ? 'Words and panels' : 'Translation'}
          </Overline>
          <ul className="m-0 list-none space-y-2 p-0">
            {panels.map((pd) => {
              const thenPanel = pageOf(thenDoc, diff.pageId)?.panels.find((p) => p.id === pd.panelId);
              const nowPanel = pageOf(nowDoc, diff.pageId)?.panels.find((p) => p.id === pd.panelId);
              const panelN = nowPanel?.n ?? thenPanel?.n;
              return (
                <li key={pd.panelId} className={cx('min-w-0 border border-[var(--ds-hairline)] px-3 py-2', RADIUS_CONTROL)} data-panel-diff={pd.panelId}>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="m-0 min-w-0 flex-1 text-[12.5px] font-semibold text-[var(--ds-ink)]">
                      Panel {panelN ?? ''}
                      {pd.status === 'added' ? ' · new' : pd.status === 'removed' ? ' · removed since' : ''}
                      {pd.fields.length ? ` · ${pd.fields.map((f) => FIELD_WORDS[f] || f).join(', ')} changed` : ''}
                    </p>
                    {pd.status !== 'added' && <Mark>Changed</Mark>}
                    {thenPanel && onUseThen !== null && (
                      <QuietBtn onClick={() => use(panelScope(diff.pageId, pd.panelId))} disabled={!can} aria-label={`Use then: panel ${panelN ?? ''} (free)`} data-use-then="panel">
                        Use then
                      </QuietBtn>
                    )}
                  </div>
                  {pd.lines.length > 0 && <ul className="m-0 list-none p-0">{pd.lines.map((ld) => lineRow(ld))}</ul>}
                </li>
              );
            })}
          </ul>
          {onUseThen !== null && <p className="m-0 pt-2 text-[12px] text-[var(--ds-muted)]">Taking back a piece is free and instant — no AI.</p>}
        </div>
      )}
    </section>
  );
};

export default PageCompare;
