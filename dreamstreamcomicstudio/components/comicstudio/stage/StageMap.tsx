// The stage map (SH-C2): the comic's five stages on one small map, each done, now, next or later, with what is left in it
// and a target that goes there. Calm and ink only: a check for done, a filled dot for now, a ring for the rest, joined by a
// hairline; heavier ink for the current stage; no hue, no spark, no price. Every target only navigates (stageMapModel.ts).
//
// Two ways in: from the stage strip as a popover (a bottom sheet on phones): its "Stage map" button in the one-row layout,
// its five marks in the compact row; and from the side panel, where the "This comic" marks open it inline (ComicSection).
// Keyboard: the targets are buttons in reading order; Arrow Up and Down (or Left and Right), Home and End move between
// them; Enter opens one; the popover opens on the row that leads (the next step), and Escape closes it and returns focus
// to its button.

import React, { useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Map as MapIcon } from 'lucide-react';
import type { StageFacts, StagePlace } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, MUTED, WRAP_TEXT } from '../../chat/studioDesign';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { stageMapRows } from './stageMapModel';
import { PLACE_HINT, StageMark } from './stageMarks';

export interface StageMapProps {
  facts: StageFacts;
  onGo: (place: StagePlace) => void;
  className?: string;
}

const MOVE_KEYS: Readonly<Record<string, 'next' | 'previous' | 'first' | 'last'>> = {
  ArrowDown: 'next',
  ArrowRight: 'next',
  ArrowUp: 'previous',
  ArrowLeft: 'previous',
  Home: 'first',
  End: 'last'
};

export function StageMap({ facts, onGo, className }: StageMapProps) {
  const rows = useMemo(() => stageMapRows(facts), [facts]);
  const targets = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();

  const onKeyDown = (event: React.KeyboardEvent) => {
    const move = MOVE_KEYS[event.key];
    const at = targets.current.findIndex((b) => b === event.target);
    if (!move || at < 0) return;
    event.preventDefault();
    const last = rows.length - 1;
    const to = move === 'next' ? Math.min(last, at + 1) : move === 'previous' ? Math.max(0, at - 1) : move === 'first' ? 0 : last;
    targets.current[to]?.focus();
  };

  return (
    <ol aria-label="Stage map" className={cn('m-0 flex min-w-0 list-none flex-col p-0', className)} onKeyDown={onKeyDown} data-stage-map>
      {rows.map((row, i) => {
        const strong = row.state === 'current';
        return (
          <li key={row.stage} aria-current={strong ? 'step' : undefined} data-stage-map-state={row.state} className="flex min-w-0 gap-3">
            {/* The mark, and the hairline to the next stage: the map's one line. */}
            <span aria-hidden className={cn('flex w-3 shrink-0 flex-col items-center pt-1', row.state === 'done' || strong ? 'text-[var(--ds-ink)]' : MUTED)}>
              <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                <StageMark done={row.state === 'done'} current={strong} />
              </span>
              {i < rows.length - 1 && <span className="mt-1 w-px flex-1 bg-[var(--ds-hairline)]" />}
            </span>
            <div className={cn('flex min-w-0 flex-1 flex-col items-start', i < rows.length - 1 && 'pb-2')}>
              <p className="m-0 text-[13px] leading-5">
                <span className={strong ? 'font-semibold text-[var(--ds-ink)]' : row.state === 'done' ? 'font-medium text-[var(--ds-ink)]' : MUTED}>{row.label}</span>
                <span className={MUTED}> · {row.stateWord}</span>
              </p>
              <p className={cn('m-0 text-xs leading-4 tabular-nums', MUTED, WRAP_TEXT)}>{row.left}</p>
              <button
                ref={(el) => {
                  targets.current[i] = el;
                }}
                type="button"
                onClick={() => onGo(row.target.place)}
                aria-describedby={`${id}-${row.stage}`}
                data-stage-map-target={row.stage}
                data-autofocus={row.leads || undefined}
                className={cn(
                  '-ml-1.5 inline-flex h-8 max-w-full items-center gap-1 rounded-[var(--ds-radius-control)] px-1.5 text-xs font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline coarse:h-11',
                  FOCUS_RING
                )}
              >
                <span className="min-w-0 truncate">{row.target.label}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
              <span id={`${id}-${row.stage}`} hidden>
                {row.sentence} {PLACE_HINT[row.target.place]}.
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface StageMapButtonProps {
  facts: StageFacts;
  onGo: (place: StagePlace) => void;
  /** The button's name ("Stage map"; the compact strip's marks say where the comic stands). */
  label?: string;
  /** What the button shows: a map glyph, or the compact strip's five marks. */
  children?: React.ReactNode;
  className?: string;
  /** The popover's edge on a wide screen: under the button's end (the strip's last control) or its start (the marks). */
  align?: 'start' | 'end';
}

/**
 * The stage strip's way in: a button that opens the map as a popover (a bottom sheet on phones). Choosing a target closes
 * it and goes there; Escape or a click outside closes it and returns focus to the button.
 */
export function StageMapButton({ facts, onGo, label = 'Stage map', children, className, align = 'end' }: StageMapButtonProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title="Stage map"
        data-stage-map-toggle
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] hover:bg-[var(--ds-hover)]',
          children ? 'h-11 min-w-11 gap-0.5 px-1.5' : 'h-8 min-w-8 text-[var(--ds-muted)] hover:text-[var(--ds-ink)] coarse:h-11 coarse:min-w-11',
          FOCUS_RING,
          className
        )}
      >
        {children ?? <MapIcon className="h-4 w-4" aria-hidden />}
      </button>
      <AdaptiveSheet
        open={open}
        onClose={() => setOpen(false)}
        label="Stage map"
        title="Stage map"
        anchorRef={button}
        placement="below"
        align={align}
        className="w-[min(20rem,calc(100vw-2rem))]"
      >
        <div className="px-4 py-3">
          <StageMap
            facts={facts}
            onGo={(place) => {
              setOpen(false);
              onGo(place);
            }}
          />
        </div>
      </AdaptiveSheet>
    </>
  );
}
