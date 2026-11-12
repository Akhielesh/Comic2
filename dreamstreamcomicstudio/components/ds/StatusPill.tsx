/**
 * StatusPill — the studio header's one status (redesign plan §6.1), replacing the spend, savings and usage chips.
 * One state at a time, by priority: offline › error › waiting › drawing › uploading › saving › idle
 * (`pickPillState`). The words are the caller's, already formatted: "Waiting for you", "Drawing 2 of 6",
 * "Saving…", "62% left" for a governed user. The pill never formats or prints money itself; amounts arrive as
 * formatted strings from the single cost formatter. On a 320 px phone it shows `short` (≤ 5 characters: `2/6`,
 * `!`, `62%`) and keeps the full words as its accessible name.
 *
 * Drawing, uploading and saving are live: a LiveDot pings beside the words (paused off screen). Under reduced
 * motion the dot holds still — a plain dot, no ping and no animation of any kind. With `onOpen` the pill is a
 * button that opens its sheet (the screen passes the sheet in); otherwise it is a polite status.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { LiveDot } from './LiveDot';
import { DENSITY, FOCUS_RING, STATUS_CHIP, STATUS_CHIP_TONE, STATUS_DOT, STATUS_INK, type StatusState } from './recipes';
import { useReducedMotion } from './useReducedMotion';

export type StatusPillState = 'offline' | 'error' | 'waiting' | 'drawing' | 'uploading' | 'saving' | 'idle';

/** Highest first: the pill shows the first state that applies. */
export const PILL_PRIORITY: readonly StatusPillState[] = ['offline', 'error', 'waiting', 'drawing', 'uploading', 'saving', 'idle'];

/** Which state the pill shows when several apply. */
export function pickPillState(flags: Partial<Record<Exclude<StatusPillState, 'idle'>, boolean>>): StatusPillState {
  return PILL_PRIORITY.find((s) => s !== 'idle' && flags[s as Exclude<StatusPillState, 'idle'>]) ?? 'idle';
}

/** Each pill state in the one status vocabulary. */
export const pillStatus: Record<StatusPillState, StatusState> = {
  offline: 'attention',
  error: 'error',
  waiting: 'attention',
  drawing: 'active',
  uploading: 'active',
  saving: 'waiting',
  idle: 'healthy'
};

const LIVE: ReadonlySet<StatusPillState> = new Set(['drawing', 'uploading', 'saving']);

export interface StatusPillProps {
  state: StatusPillState;
  /** The words ("Drawing 2 of 6"). */
  label: string;
  /** ≤ 5 characters for the narrowest header ("2/6"); the full label stays the accessible name. */
  short?: string;
  /** Show `short` instead of the label (the 320 px header). */
  compact?: boolean;
  /** Opens the status sheet. */
  onOpen?: () => void;
  className?: string;
}

export function StatusPill({ state, label, short, compact = false, onOpen, className }: StatusPillProps) {
  const reduced = useReducedMotion();
  const status = pillStatus[state];
  const live = LIVE.has(state);
  const shown = compact && short ? short.slice(0, 5) : label;
  const dot =
    live && !reduced ? (
      // LiveDot paints currentColor (the dot and its ping): the state's ink.
      <LiveDot data-slot="status-pill-dot" className={cn('size-1.5 shrink-0', STATUS_INK[status])} />
    ) : (
      <span aria-hidden="true" data-slot="status-pill-dot" className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status])} />
    );
  const body = (
    <>
      {dot}
      <span className="min-w-0 truncate tabular-nums">{shown}</span>
    </>
  );
  const common = cn(STATUS_CHIP, STATUS_CHIP_TONE[status], className);
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={shown === label ? undefined : label}
        aria-haspopup="dialog"
        data-slot="status-pill"
        data-state={state}
        className={`${cn(common, DENSITY.coarse, 'hover:brightness-95')} ${FOCUS_RING}`}
      >
        {body}
      </button>
    );
  }
  return (
    <span role="status" aria-label={shown === label ? undefined : label} data-slot="status-pill" data-state={state} className={common}>
      {body}
    </span>
  );
}
