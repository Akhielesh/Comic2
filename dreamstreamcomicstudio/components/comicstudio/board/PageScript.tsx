// A page's script at a glance — the plan the user approves before any pixels are paid
// for: chapter, summary, then each panel's size/shot, cast (groups read "three Ducklings"),
// place, visible action and lettering, and how many words each panel carries against what it
// holds ("12 words / fits about 18"). Long words wrap instead of overflowing a narrow card.

import React from 'react';
import { castNoun, findCharacter, type ComicDoc, type Line, type Page } from '../../../shared/comic/doc';
import { checkPagePlan, fitBoxesFor, type FitState } from '../../../shared/comic/pagePlanCheck';
import { textUnitFor, unitCount } from '../../../shared/comic/panelRules';
import { LINE_KIND_LABEL, SHOT_LABEL, SIZE_LABEL, castName, placeName } from './boardModel';
import { cx } from './ui';

/** Who is in a panel, groups by their count ("three Ducklings"). */
const castLabel = (doc: ComicDoc, id: string): string => {
  const c = findCharacter(doc, id);
  return c ? castNoun(c) : castName(doc, id);
};

export const lineSpeakerLabel = (doc: ComicDoc, line: Line): string => {
  if (line.kind === 'caption') return 'Caption';
  if (line.kind === 'sfx') return 'SFX';
  const name = line.speakerId ? castName(doc, line.speakerId) : 'Unassigned';
  return line.kind === 'speech' ? name : `${name} (${LINE_KIND_LABEL[line.kind].toLowerCase()})`;
};

export interface PanelWordFit {
  /** "12 words / fits about 18" (characters for Japanese and Chinese). */
  text: string;
  state: FitState;
}

/**
 * Each panel's lettered words against what it holds (A4 wave note 4, the rest of FX2), on the same boxes as the
 * breakdown card's dots, the Render-all gate and the director's line-edit budget (pagePlanCheck fitBoxesFor): a page
 * Render all would draw (undrawn, failed or out of date) on the layout it will be drawn on — so the free "Use the
 * layout that fits" shows here at once — and a drawn, current page on the panels it was drawn with. Silent panels
 * (no balloons or captions) get none.
 */
export const panelWordFits = (doc: ComicDoc, page: Page): (PanelWordFit | undefined)[] => {
  if (!page.panels.length) return [];
  const check = checkPagePlan(doc, page, { fixLayout: false, boxes: fitBoxesFor(doc, page) });
  const unit = textUnitFor(doc.format?.language);
  return check.panels.map((p) => (p.words > 0 ? { text: `${unitCount(p.words, unit)} / fits about ${p.budget}`, state: p.state } : undefined));
};

export const PageScript: React.FC<{ doc: ComicDoc; page: Page; className?: string; dense?: boolean }> = ({ doc, page, className, dense }) => {
  const fits = React.useMemo(() => panelWordFits(doc, page), [doc, page]);
  return (
    <div className={cx('min-w-0 space-y-2.5 text-[12.5px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]', className)}>
      {page.chapterTitle && <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{page.chapterTitle}</p>}
      {page.summary && <p className="text-[13px] font-medium leading-snug">{page.summary}</p>}
      {!page.panels.length && <p className="text-[var(--ds-muted)]">No panels yet.</p>}
      <ol className="space-y-2">
        {page.panels.map((panel, i) => {
          const where = placeName(doc, panel.placeId);
          const lines = panel.lines.filter((l) => l.text.trim());
          const fit = fits[i];
          return (
            <li key={panel.id} className="flex gap-2.5">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--ds-well-strong)] text-[10.5px] font-semibold tabular-nums text-[var(--ds-muted)]">
                {panel.n}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-[var(--ds-muted)]">
                  {SIZE_LABEL[panel.size] || panel.size} · {SHOT_LABEL[panel.shot] || panel.shot}
                  {panel.angle ? ` · ${panel.angle}` : ''}
                  {where ? ` · ${where}` : ''}
                  {panel.castIds.length > 0 && ` · ${panel.castIds.map((id) => castLabel(doc, id)).join(', ')}`}
                  {fit && (
                    <>
                      {' · '}
                      <span className={cx('tabular-nums', fit.state === 'overfull' && 'font-medium text-[var(--ds-danger-text)]')} data-fit={fit.state}>
                        {fit.text}
                        {fit.state === 'overfull' ? ' — too full' : ''}
                      </span>
                    </>
                  )}
                </p>
                {panel.action && <p className={cx(dense && 'line-clamp-3')}>{panel.action}</p>}
                {lines.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {lines.map((l) => (
                      <li key={l.id} className={cx('text-[12px]', dense && 'line-clamp-2')}>
                        <span className="font-semibold uppercase tracking-wide text-[var(--ds-muted)]">{lineSpeakerLabel(doc, l)}:</span>{' '}
                        <span className={cx(l.kind === 'caption' && 'italic')}>“{l.text}”</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {page.turnHook && (
        <p className="border-t border-[var(--ds-hairline-soft)] pt-2 text-[12px] text-[var(--ds-muted)]">
          <span className="font-semibold">Page-turn hook:</span> {page.turnHook}
        </p>
      )}
    </div>
  );
};
