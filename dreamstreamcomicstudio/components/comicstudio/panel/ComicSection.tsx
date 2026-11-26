// The side panel's own section for the comic you are in (SH-C1): where it stands and its one next step (SH-A's stage,
// the same words as the strip under the header), Ask the Director, and the board's tabs. Ink only; the next step and
// every tab only open a place, so nothing here can start a paid step. In the slim rail it is Ask the Director and the
// tabs as icons. SH-C2 grows the comic's parts here.

import React, { useEffect, useId, useMemo, useRef } from 'react';
import { ArrowRight, MessageSquare } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import { stageView, type StageFacts, type StagePlace } from '../../../shared/comic/stage';
import type { StudioTab } from '../types';
import { boardTabsFor } from '../board/boardNavigation';
import { pageProgress } from '../board/boardModel';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, FOCUS_RING, MUTED, OVERLINE } from '../../chat/studioDesign';
import { PLACE_HINT } from '../stage/StageStrip';
import { StageMarks } from './StageMarks';
import { PANEL_ROW, PANEL_ROW_CURRENT, PANEL_ROW_IDLE, RAIL_ITEM } from './panelStyles';

export interface ComicSectionProps {
  doc: ComicDoc;
  caps: StudioCaps;
  tab: StudioTab;
  /** The comic's stage facts (stageFacts(doc), with the owner's publication view). */
  facts: StageFacts;
  compact?: boolean;
  onSelect: (tab: StudioTab) => void;
  onConversation: () => void;
  /** Open where the next step is worked (the studio's stage navigation). */
  onGo: (place: StagePlace) => void;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function ComicSection({ doc, caps, tab, facts, compact = false, onSelect, onConversation, onGo }: ComicSectionProps) {
  const tabs = boardTabsFor(doc, caps, tab);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const progress = pageProgress(doc);
  const view = useMemo(() => stageView(facts), [facts]);
  const labelId = useId();
  const hintId = useId();
  useEffect(() => {
    // Only when the tab or the layout changes, not on every list update.
    refs.current[tabs.findIndex((item) => item.id === tab)]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab, compact]);
  const move = (event: React.KeyboardEvent, index: number) => {
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : -1;
    if (next < 0) return;
    event.preventDefault();
    // Manual activation keeps a phone drawer open while arrow keys explore the tabs.
    refs.current[next]?.focus();
  };

  const tabList = (
    <div role="tablist" aria-label="Board" aria-orientation="vertical" className={cn('flex shrink-0 flex-col gap-1', compact && 'items-center')}>
      {tabs.map((item, index) => {
        const selected = item.id === tab;
        const count = item.id === 'cast' ? doc.cast.length : item.id === 'pages' && progress.total ? `${progress.ready}/${progress.total}` : null;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`board-tab-${item.id}`}
            aria-label={item.label}
            title={compact ? item.label : undefined}
            aria-selected={selected}
            aria-controls="board-panel"
            tabIndex={selected ? 0 : -1}
            data-action={item.id === 'media' ? 'media' : undefined}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => move(event, index)}
            className={cn(compact ? RAIL_ITEM : PANEL_ROW, selected ? PANEL_ROW_CURRENT : PANEL_ROW_IDLE)}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
              {item.icon}
            </span>
            {!compact && (
              <>
                <span className={cn('flex-1 text-left', CLIP_TEXT)}>{item.label}</span>
                {count !== null && <span className={cn('text-xs font-normal tabular-nums', MUTED)}>{count}</span>}
              </>
            )}
          </button>
        );
      })}
    </div>
  );

  const ask = (
    <button
      type="button"
      onClick={onConversation}
      aria-label="Ask the Director"
      title={compact ? 'Ask the Director' : undefined}
      className={cn(compact ? RAIL_ITEM : PANEL_ROW, 'text-[var(--ds-ink)]')}
    >
      <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />
      {!compact && <span className={CLIP_TEXT}>Ask the Director</span>}
    </button>
  );

  if (compact) {
    return (
      <div role="group" aria-label="This comic" data-panel-comic="rail" className="flex flex-col items-center gap-1 border-t border-[var(--ds-hairline)] pt-2">
        {ask}
        {tabList}
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby={labelId} data-panel-comic="open" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <p id={labelId} className={cn('m-0', OVERLINE)}>
          This comic
        </p>
        <StageMarks steps={view.steps} />
      </div>
      {/* Where it stands, then the next step, as one button: it only opens a place (a tab, the conversation, the
          composer or the Share sheet), never a paid step. */}
      <button
        type="button"
        onClick={() => onGo(view.next.place)}
        aria-label={view.line}
        aria-describedby={hintId}
        data-panel-next={view.next.key}
        className={cn(
          'flex min-h-11 w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-[var(--ds-radius-control)] px-3 py-1.5 text-left text-xs leading-4 hover:bg-[var(--ds-hover)]',
          FOCUS_RING
        )}
      >
        <span className={cn('max-w-full tabular-nums', CLIP_TEXT)} title={view.summary}>
          <span className="font-medium text-[var(--ds-ink)]">{view.word}</span>
          <span className={MUTED}> · {view.progress}</span>
        </span>
        <span className="inline-flex max-w-full items-center gap-1 font-medium text-[var(--ds-ink)]">
          <span className={CLIP_TEXT}>Next: {lowerFirst(view.next.label)}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </span>
      </button>
      <span id={hintId} hidden>
        {PLACE_HINT[view.next.place]}
      </span>
      {ask}
      <p className={cn('m-0 px-3 pt-3', OVERLINE)}>Board</p>
      <div className="border-t border-[var(--ds-hairline)] pt-2">{tabList}</div>
    </div>
  );
}
