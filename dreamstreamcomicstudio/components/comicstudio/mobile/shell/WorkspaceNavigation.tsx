import React, { useEffect, useRef } from 'react';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import type { ComicDoc } from '../../../../shared/comic/doc';
import type { StudioCaps } from '../../../../shared/comic/capabilities';
import type { StudioTab } from '../../types';
import { boardTabsFor } from '../../board/boardNavigation';
import { pageProgress } from '../../board/boardModel';
import { CLIP_TEXT, FOCUS_RING, OVERLINE } from '../../../chat/studioDesign';

export const WORKSPACE_NAVIGATION_ID = 'studio-project-navigation';
export const WORKSPACE_NAVIGATION_KEY = 'cs.workspace.navigation.expanded';

export const readNavigationExpanded = (): boolean => {
  try { return window.localStorage.getItem(WORKSPACE_NAVIGATION_KEY) === 'true'; }
  catch { return false; }
};

interface Props {
  doc: ComicDoc;
  caps: StudioCaps;
  tab: StudioTab;
  compact?: boolean;
  onSelect: (tab: StudioTab) => void;
  onConversation: () => void;
  onBack: () => void;
  footer?: React.ReactNode;
}

/** Project stages share the board's registry; collapsing changes chrome, never the active panel. */
export function WorkspaceNavigation({ doc, caps, tab, compact = false, onSelect, onConversation, onBack, footer }: Props) {
  const tabs = boardTabsFor(doc, caps, tab);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const progress = pageProgress(doc);
  useEffect(() => { refs.current[tabs.findIndex((item) => item.id === tab)]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [tab, compact]);
  const item = `flex min-h-11 shrink-0 items-center rounded-[var(--ds-radius-control)] text-sm ${FOCUS_RING}`;
  const layout = compact ? 'w-11 justify-center' : 'w-full gap-3 px-3';
  const move = (event: React.KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    // Manual activation keeps a phone drawer open while arrow keys explore the stages.
    refs.current[next]?.focus();
  };

  return <nav id={WORKSPACE_NAVIGATION_ID} aria-label="Project navigation" data-workspace-navigation={compact ? 'compact' : 'expanded'} className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-1.5">
    <button type="button" onClick={onBack} aria-label="Back to My comics" title={compact ? 'My comics' : undefined} className={`${item} ${layout} text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`}>
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />{!compact && <span>My comics</span>}
    </button>
    <button type="button" onClick={onConversation} aria-label="Ask the Director" title={compact ? 'Ask the Director' : undefined} className={`${item} ${layout} text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`}>
      <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />{!compact && <span>Ask the Director</span>}
    </button>
    {!compact && <p className={`px-3 pt-3 ${OVERLINE}`}>Project stages</p>}
    <div role="tablist" aria-label="Board" aria-orientation="vertical" className="flex shrink-0 flex-col gap-1 border-t border-[var(--ds-hairline)] pt-2">
      {tabs.map((stage, index) => {
        const selected = stage.id === tab;
        const count = stage.id === 'cast' ? doc.cast.length : stage.id === 'pages' && progress.total ? `${progress.ready}/${progress.total}` : null;
        return <button key={stage.id} ref={(el) => { refs.current[index] = el; }} type="button" role="tab" id={`board-tab-${stage.id}`} aria-label={stage.label} title={compact ? stage.label : undefined} aria-selected={selected} aria-controls="board-panel" tabIndex={selected ? 0 : -1} data-action={stage.id === 'media' ? 'media' : undefined} onClick={() => onSelect(stage.id)} onKeyDown={(event) => move(event, index)} className={`${item} ${layout} ${selected ? 'bg-[var(--ds-hover)] font-semibold text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'}`}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>{stage.icon}</span>
          {!compact && <><span className={`min-w-0 flex-1 text-left ${CLIP_TEXT}`}>{stage.label}</span>{count !== null && <span className="text-xs font-normal tabular-nums text-[var(--ds-muted)]">{count}</span>}</>}
        </button>;
      })}
    </div>
    {!compact && footer && <div className="mt-auto border-t border-[var(--ds-hairline)] pt-3" data-workspace-navigation-footer>{footer}</div>}
  </nav>;
}
