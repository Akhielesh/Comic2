// Comic History — compare two moments of the book (versions plan §5, §8 "Compare"; package H5).
//
// Free: the owner route diffs the two manifests and sends only the changed pieces; diffBooks (shared) is the one
// meaning of "changed" on both ends. Shows: which pages changed, were added, removed or moved ("Moved from 5"),
// the model line ("Drawn with X (then) · Y (now)"), the page compare with its language chips and word diff, and the
// other pieces (characters, places, cover, script, style, each language edition) — each with a free "Use then" when
// the earlier side is a saved moment. A piece that would put pages "Out of date" (a look, a place, the style, the
// cover, the script) lists those pages first and waits for [Bring back] (§6.3). The language chips show whenever the
// books have editions — also when only translations differ ("the AI re-translation overwrote my edits").
// Desktop: aligned then/now strips of the changed pages; phones: the Now strip with change marks.

export { restorableId, sideLabel } from './historyModel';

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Minus, Pencil, Plus } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { CompareRef, PageDiff, RestoreScope } from '../../../shared/comic/history/types';
import { FOCUS_RING, RADIUS_CONTROL } from '../../chat/studioDesign';
import { useCostFormat } from '../conversation/cost';
import { modelName } from '../timeline/bookModel';
import { languageSpec } from '../../../shared/comic/languages';
import { languageChips, languageScope, restorableId, scopeThing, sideLabel, STALE_CHECK_SCOPES, staleConfirmText, staleImpact, whenText, type RestoreFollowUp } from './historyModel';
import { LanguageChips } from './LanguageChips';
import { PageCompare } from './PageCompare';
import { useCompare, type HistoryStudio } from './useHistory';
import { cx, Mark, Note, Overline, PrimaryBtn, QuietBtn } from './ui';

export interface BookCompareProps {
  studio: HistoryStudio;
  a: CompareRef;
  b?: CompareRef;
  initialPageId?: string | null;
  now: number;
  tz: string;
  phone: boolean;
  reducedMotion: boolean;
  /** Take a piece back from the earlier side (free); `followUp` asks what to do next (e.g. the panel's drawing). */
  onUseThen(versionId: string, scope: RestoreScope, at: string, followUp?: RestoreFollowUp): void;
  /** Open the whole-book restore sheet for the earlier side. */
  onRestoreBook?(versionId: string): void;
  /** A new value re-reads the compare (after a piece was taken back, so what came back stops showing as changed). */
  refreshKey?: number;
}

/** "Pages 2 and 4 will show Out of date until redrawn. Bring Maya back anyway?" — waiting for [Bring back]. */
interface StaleAsk {
  key: string;
  scope: RestoreScope;
  text: string;
}

const PAGE_MARK: Record<PageDiff['status'], { words: string; icon: React.ReactNode }> = {
  changed: { words: 'Changed', icon: <Pencil className="h-3 w-3" aria-hidden /> },
  added: { words: 'New', icon: <Plus className="h-3 w-3" aria-hidden /> },
  removed: { words: 'Removed', icon: <Minus className="h-3 w-3" aria-hidden /> },
  moved: { words: 'Moved', icon: <ArrowLeftRight className="h-3 w-3" aria-hidden /> }
};

const pageNo = (p: PageDiff) => p.toN ?? p.fromN ?? 0;

export const BookCompare: React.FC<BookCompareProps> = ({ studio, a, b = 'now', initialPageId, now, tz, phone, reducedMotion, onUseThen, onRestoreBook, refreshKey = 0 }) => {
  const { result, loading, error, urlFor, reload } = useCompare(studio, a, b, refreshKey);
  const [ask, setAsk] = useState<StaleAsk | null>(null);
  const cost = useCostFormat(studio);
  const pages = useMemo(() => (result ? [...result.diff.pages].sort((x, y) => pageNo(x) - pageNo(y)) : []), [result]);
  const [pageId, setPageId] = useState<string | null>(initialPageId ?? null);
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => {
    if (!pages.length) return;
    if (!pageId || !pages.some((p) => p.pageId === pageId)) setPageId(pages[0].pageId);
  }, [pages, pageId]);

  if (loading && !result) return <Note>Comparing…</Note>;
  if (error) return <Note tone="attention" action={<QuietBtn onClick={reload}>Try again</QuietBtn>}>{error}</Note>;
  if (!result) return null;

  const thenDoc: ComicDoc = result.docs.a;
  const nowDoc: ComicDoc = result.docs.b;
  const thenLabel = sideLabel(result.a, now, tz);
  const nowLabel = sideLabel(result.b, now, tz);
  const versionId = restorableId(result.a);
  const atText = result.a.row ? result.a.row.name || whenText(result.a.row.contentAt, now, tz) : thenLabel;
  const live = studio.doc;
  const canTake = !!versionId && result.b.kind === 'now';
  const turnBusy = studio.busy ? 'The director is working — take pieces back when it’s done.' : null;
  const use = (scope: RestoreScope, followUp?: RestoreFollowUp) => versionId && onUseThen(versionId, scope, atText, followUp);
  // A whole piece (a look, a place, the style, the cover, the script) may put pages out of date: list them first.
  const useWhole = (key: string, scope: RestoreScope) => {
    if (!versionId) return;
    if (STALE_CHECK_SCOPES.has(scope.kind) && live) {
      const ns = staleImpact(live, thenDoc, scope, versionId, now);
      if (ns === null || ns.length) {
        setAsk({ key, scope, text: staleConfirmText(ns, scopeThing(scope, thenDoc, live)) });
        return;
      }
    }
    setAsk(null);
    use(scope);
  };
  const diff = result.diff;
  const index = Math.max(0, pages.findIndex((p) => p.pageId === pageId));
  const current = pages[index];
  const chips = languageChips(thenDoc, nowDoc);
  const shownLang = lang && chips.some((c) => c.lang === lang) ? lang : chips[0]?.lang ?? nowDoc.format.language;
  const editionDiffers = (l: string) => diff.editions.some((e) => e.lang === l && e.status !== 'added');
  const drawing = (id: string) => (live && studio.isRendering({ kind: 'page', id }) ? `Page ${live.pages.find((p) => p.id === id)?.n ?? ''} is still drawing — restore when it’s done.` : null);
  const strip = (side: 'then' | 'now') => (
    <ul aria-label={side === 'then' ? `Changed pages then (${thenLabel})` : `Changed pages now (${nowLabel})`} className="m-0 flex min-w-0 list-none gap-2 overflow-x-auto px-4 py-2" data-compare-strip={side}>
      {pages.map((p) => {
        const doc = side === 'then' ? thenDoc : nowDoc;
        const page = doc.pages.find((x) => x.id === p.pageId);
        const url = page?.render.asset ? urlFor(page.render.asset.path, { width: 160 }) : undefined;
        const mark = PAGE_MARK[p.status];
        const n = side === 'then' ? p.fromN : p.toN;
        return (
          <li key={p.pageId} className="shrink-0">
            <button
              type="button"
              onClick={() => setPageId(p.pageId)}
              aria-current={p.pageId === current?.pageId ? 'true' : undefined}
              aria-label={`Page ${pageNo(p)}: ${mark.words.toLowerCase()}${p.status === 'moved' && p.fromN ? ` from ${p.fromN}` : ''}`}
              className={cx('flex min-h-11 flex-col items-center gap-1 p-0.5', RADIUS_CONTROL, FOCUS_RING, p.pageId === current?.pageId && 'bg-[var(--ds-accent-soft)]')}
            >
              <span className={cx('relative block h-[84px] w-14 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)] md:h-[108px] md:w-[72px]', RADIUS_CONTROL)}>
                {url ? <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} /> : <span className="absolute inset-0 flex items-center justify-center p-1 text-center text-[10px] text-[var(--ds-muted)]">{page ? 'Not drawn' : '—'}</span>}
              </span>
              <span className="text-[11px] tabular-nums text-[var(--ds-muted)]">{n ? `Page ${n}` : 'Not there'}</span>
              {side === 'now' && (
                <Mark tone="active" icon={mark.icon}>
                  {p.status === 'moved' && p.fromN ? `Moved from ${p.fromN}` : mark.words}
                </Mark>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );

  const others: { key: string; title: string; detail: string; scope?: RestoreScope }[] = [];
  for (const c of diff.cast) others.push({ key: `char:${c.id}`, title: c.name || 'A character', detail: c.status === 'added' ? 'New since then' : c.status === 'removed' ? 'Removed since then' : c.art ? 'Look and sheet changed' : 'Changed', ...(c.status !== 'added' ? { scope: { kind: 'character', id: c.id } as RestoreScope } : {}) });
  for (const p of diff.places) others.push({ key: `place:${p.id}`, title: p.name || 'A place', detail: p.status === 'added' ? 'New since then' : p.status === 'removed' ? 'Removed since then' : 'Changed', ...(p.status !== 'added' ? { scope: { kind: 'place', id: p.id } as RestoreScope } : {}) });
  if (diff.cover.text || diff.cover.art) others.push({ key: 'cover', title: 'Cover', detail: [diff.cover.art && 'art', diff.cover.text && 'title'].filter(Boolean).join(' and ') + ' changed', scope: { kind: 'cover', part: diff.cover.art && diff.cover.text ? 'all' : diff.cover.art ? 'art' : 'text' } });
  if (diff.script) others.push({ key: 'script', title: 'Script', detail: 'Changed', scope: { kind: 'script' } });
  if (diff.style || diff.options.length) others.push({ key: 'style', title: 'Style', detail: 'Changed', scope: { kind: 'style' } });
  if (diff.meta.length) others.push({ key: 'meta', title: 'Story details', detail: 'Changed' });
  // Each edition that differs (an edition new since then has nothing to bring back).
  for (const e of diff.editions) {
    if (e.status === 'added') continue;
    const n = e.lineIds.length;
    others.push({
      key: `ed:${e.lang}`,
      title: languageSpec(e.lang)?.english || e.lang,
      detail: e.status === 'removed' ? 'Removed since then' : n ? `${n} translated ${n === 1 ? 'line differs' : 'lines differ'}` : 'Changed',
      scope: languageScope(e.lang)
    });
  }

  const changedLines = diff.editions.reduce((n, e) => n + e.lineIds.length, 0);
  const summary = [
    pages.filter((p) => p.status === 'changed').length && `${pages.filter((p) => p.status === 'changed').length} ${pages.filter((p) => p.status === 'changed').length === 1 ? 'page' : 'pages'} changed`,
    pages.filter((p) => p.status === 'added').length && `${pages.filter((p) => p.status === 'added').length} new`,
    pages.filter((p) => p.status === 'removed').length && `${pages.filter((p) => p.status === 'removed').length} removed`,
    pages.filter((p) => p.status === 'moved').length && `${pages.filter((p) => p.status === 'moved').length} moved`,
    changedLines && `${changedLines} translated ${changedLines === 1 ? 'line' : 'lines'}`
  ].filter(Boolean);

  return (
    <section aria-label={`Compare ${thenLabel} with ${nowLabel}`} className="min-w-0 pb-4" data-history-compare>
      <div className="min-w-0 px-4 pt-2">
        <p className="m-0 text-[15px] font-semibold text-[var(--ds-ink)] [overflow-wrap:anywhere]">
          Then: {thenLabel} · {nowLabel === 'Now' ? 'Now' : `Now: ${nowLabel}`}
        </p>
        <p className="m-0 mt-0.5 text-[12.5px] text-[var(--ds-muted)]">{diff.same ? 'Nothing changed between these two.' : summary.join(' · ') || 'Some story details changed.'}</p>
        {diff.model && (
          <p className="m-0 mt-0.5 text-[12.5px] text-[var(--ds-muted)]">
            Drawn with {modelName(diff.model.a) || diff.model.a || 'nothing yet'} (then) · {modelName(diff.model.b) || diff.model.b || 'nothing yet'} (now)
          </p>
        )}
      </div>

      <LanguageChips chips={chips} selected={shownLang} onSelect={setLang} onUseThen={canTake && editionDiffers(shownLang) ? (l) => use(languageScope(l)) : undefined} useThenDisabled={!!turnBusy} />

      {pages.length > 0 && (
        <>
          {!phone && (
            <div className="min-w-0 pt-1">
              <Overline as="p" className="px-4">
                Then
              </Overline>
              {strip('then')}
            </div>
          )}
          <div className="min-w-0">
            <Overline as="p" className="px-4">
              {phone ? 'Changed pages' : 'Now'}
            </Overline>
            {strip('now')}
          </div>
          {current && (
            <PageCompare
              key={current.pageId}
              thenDoc={thenDoc}
              nowDoc={nowDoc}
              live={live}
              diff={current}
              urlFor={(p, o) => urlFor(p, o)}
              lang={shownLang}
              phone={phone}
              reducedMotion={reducedMotion}
              thenLabel={thenLabel}
              nowLabel={nowLabel}
              position={{ index, total: pages.length }}
              onPrev={index > 0 ? () => setPageId(pages[index - 1].pageId) : undefined}
              onNext={index < pages.length - 1 ? () => setPageId(pages[index + 1].pageId) : undefined}
              onUseThen={canTake ? use : null}
              blockedReason={turnBusy || drawing(current.pageId)}
              money={cost.exact}
            />
          )}
        </>
      )}

      {others.length > 0 && (
        <div className="min-w-0 px-4 pt-2">
          <Overline as="h3" className="py-2">
            Other changes
          </Overline>
          <ul className="m-0 list-none space-y-1 p-0">
            {others.map((o) => (
              <li key={o.key} className="flex min-w-0 flex-wrap items-center gap-2 py-1" data-other-change={o.key}>
                <p className="m-0 min-w-0 flex-1 text-[13px] text-[var(--ds-ink)] [overflow-wrap:anywhere]">
                  <span className="font-semibold">{o.title}</span> <span className="text-[var(--ds-muted)]">· {o.detail}</span>
                </p>
                {o.scope && canTake && (
                  <QuietBtn onClick={() => useWhole(o.key, o.scope!)} disabled={!!turnBusy} aria-label={`Use then: ${o.title} (free)`} aria-expanded={STALE_CHECK_SCOPES.has(o.scope.kind) ? ask?.key === o.key : undefined} data-use-then={o.scope.kind}>
                    Use then
                  </QuietBtn>
                )}
                {ask?.key === o.key && (
                  <div role="group" aria-label={`Before bringing back ${o.title}`} className="flex w-full min-w-0 flex-wrap items-center gap-2 pb-1" data-stale-confirm={o.key}>
                    <p className="m-0 w-full text-[13px] leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{ask.text}</p>
                    <PrimaryBtn
                      onClick={() => {
                        const scope = ask.scope;
                        setAsk(null);
                        use(scope);
                      }}
                      disabled={!!turnBusy}
                    >
                      Bring back · Free
                    </PrimaryBtn>
                    <QuietBtn onClick={() => setAsk(null)}>Cancel</QuietBtn>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {versionId && onRestoreBook && result.b.kind === 'now' && !diff.same && (
        <div className="px-4 pt-3">
          <QuietBtn onClick={() => onRestoreBook(versionId)} className="w-full">
            Restore the whole book to {atText}… · Free
          </QuietBtn>
        </div>
      )}
    </section>
  );
};

export default BookCompare;
