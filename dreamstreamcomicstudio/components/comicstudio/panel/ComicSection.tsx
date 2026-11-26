// The side panel's own section for the comic you are in (SH-C1): where it stands and its one next step (SH-A's stage,
// the same words as the strip under the header), Ask the Director, and the board. Open (and in the phone drawer) the
// board is the comic's parts tree (SH-C2, PartsTree: each character, each page with its drawn state, the cover), with
// "Find a page" on a long book, and the five marks beside "This comic" open the stage map. Ink only; the next step, the
// map and every part only open a place, so nothing here can start a paid step. In the slim rail it is Ask the Director
// and the tabs as icons.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, MessageSquare } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import { stageView, type StageFacts, type StagePlace } from '../../../shared/comic/stage';
import type { StudioTab } from '../types';
import { boardTabsFor } from '../board/boardNavigation';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, FOCUS_RING, MUTED, OVERLINE, TRANSITION, WRAP_TEXT } from '../../chat/studioDesign';
import { PLACE_HINT } from '../stage/stageMarks';
import { StageMap } from '../stage/StageMap';
import { StageMarks } from './StageMarks';
import { LivePartsTree, PageSearch, PAGE_SEARCH_MIN } from './PartsTree';
import type { PartTarget } from './partsModel';
import type { BoardPartStore } from '../board/boardPartStore';
import { PANEL_ROW, PANEL_ROW_CURRENT, PANEL_ROW_IDLE, PANEL_ROW_INK, RAIL_ITEM } from './panelStyles';

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
  /** The page open in the page editor (the tree's current row). */
  focusedPageId?: string | null;
  /** The card the person is on in the board (the tree's current row when it is in the open tab); only the tree reads it. */
  partStore?: BoardPartStore | null;
  /** Open a character's card, a page or the cover (an area opens through onSelect). */
  onOpenPart?: (target: Exclude<PartTarget, { kind: 'area' }>) => void;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function ComicSection({ doc, caps, tab, facts, compact = false, onSelect, onConversation, onGo, focusedPageId, partStore, onOpenPart }: ComicSectionProps) {
  const tabs = boardTabsFor(doc, caps, tab);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const view = useMemo(() => stageView(facts), [facts]);
  const labelId = useId();
  const hintId = useId();
  const mapId = useId();
  const [mapOpen, setMapOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    // The rail: only when the tab or the layout changes, not on every list update.
    if (compact) refs.current[tabs.findIndex((item) => item.id === tab)]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
    refs.current[next]?.focus();
  };

  // The slim rail's board: the tabs as icons (open, the parts tree below takes their place).
  const tabList = (
    <div role="tablist" aria-label="Board" aria-orientation="vertical" className="flex shrink-0 flex-col items-center gap-1">
      {tabs.map((item, index) => {
        const selected = item.id === tab;
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
            title={item.label}
            aria-selected={selected}
            aria-controls="board-panel"
            tabIndex={selected ? 0 : -1}
            data-action={item.id === 'media' ? 'media' : undefined}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => move(event, index)}
            className={cn(RAIL_ITEM, selected ? PANEL_ROW_CURRENT : PANEL_ROW_IDLE)}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
              {item.icon}
            </span>
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
      className={cn(compact ? RAIL_ITEM : PANEL_ROW, PANEL_ROW_INK)}
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

  const openPart = (target: PartTarget) => (target.kind === 'area' ? onSelect(target.tab) : onOpenPart?.(target));
  const searching = (Array.isArray(doc.pages) ? doc.pages.length : 0) > PAGE_SEARCH_MIN;

  return (
    <div role="group" aria-labelledby={labelId} data-panel-comic="open" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pl-3 pt-1">
        <p id={labelId} className={cn('m-0 pt-2', OVERLINE)}>
          This comic
        </p>
        {/* The five marks open the stage map: each stage, what is left in it, and a way there. */}
        <button
          type="button"
          onClick={() => setMapOpen((open) => !open)}
          aria-expanded={mapOpen}
          aria-controls={mapOpen ? mapId : undefined}
          aria-label="Stage map"
          title="Stage map"
          data-panel-stage-map
          className={cn('mt-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--ds-radius-control)] px-1.5 hover:bg-[var(--ds-hover)] coarse:h-11', FOCUS_RING)}
        >
          <StageMarks steps={view.steps} />
          <ChevronDown className={cn('h-3 w-3 shrink-0', MUTED, TRANSITION, mapOpen && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {/* Where it stands, then the next step, as one button: it only opens a place (a tab, the conversation, the
          composer or the Share sheet), never a paid step. Its two lines are its label, so they wrap rather than cut a
          word in the panel's 14rem ("Next: tell the Director your idea"). */}
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
        <span className={cn('max-w-full tabular-nums', WRAP_TEXT)}>
          <span className="font-medium text-[var(--ds-ink)]">{view.word}</span>
          <span className={MUTED}> · {view.progress}</span>
        </span>
        <span className="inline-flex max-w-full items-center gap-1 font-medium text-[var(--ds-ink)]">
          <span className={WRAP_TEXT}>Next: {lowerFirst(view.next.label)}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </span>
      </button>
      <span id={hintId} hidden>
        {PLACE_HINT[view.next.place]}
      </span>
      {mapOpen && (
        <div id={mapId} className="border-y border-[var(--ds-hairline)] px-3 py-2" data-panel-stage-map-open>
          <StageMap facts={facts} onGo={onGo} />
        </div>
      )}
      {ask}
      <p className={cn('m-0 px-3 pt-3', OVERLINE)}>Board</p>
      <div className="flex flex-col gap-1 border-t border-[var(--ds-hairline)] pt-2">
        {searching && <PageSearch doc={doc} query={query} onQuery={setQuery} onPage={(id) => onOpenPart?.({ kind: 'page', id })} />}
        {!(searching && query.trim()) && <LivePartsTree doc={doc} tabs={tabs} tab={tab} focusedPageId={focusedPageId} partStore={partStore} onOpen={openPart} />}
      </div>
    </div>
  );
}
