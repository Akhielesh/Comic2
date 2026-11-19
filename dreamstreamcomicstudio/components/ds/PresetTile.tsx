/**
 * PresetTile — one choice with a picture (redesign plan §4; styles.md §7.3 M5, amendment A2 to DS-R9): a style, a
 * format, a lettering look. The art is passed in (a LibraryImage, a PresetThumb, a page wireframe), so the tile is
 * the same chrome everywhere: the art box (MediaTile, built from spans: a button holds phrasing content only, so
 * the art passed in must be phrasing content too — an <img>, an <svg>, a span), the label under it, an optional
 * one-line description and a badge ("Free", "New"). It replaces the three hand-built style tiles and the lettering
 * preset tile chrome.
 *
 * Semantics come from the group (PresetGrid): `radio` (one of a set; aria-checked) or `pressed` (a toggle;
 * aria-pressed). On a pointer that really hovers the tile lifts (LIFT), every press dips (PRESS) and the chosen
 * tile's check pops in (`ds-pop`); under reduced motion only the ring and the check change. The chosen tile is
 * ringed in ink and carries a check, so the choice never rests on colour alone. No `transition-all`, no literal hue.
 *
 * `hint` (declutter DX-0) is the explanation that does not belong on the tile (a style's blurb): the button's native
 * title (a hover hint on a mouse) and, always, its accessible description (a hidden span it points at with
 * aria-describedby), so a screen reader announces it on focus and it never adds to the tile's name.
 */
import React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MediaTile } from './MediaTile';
import { PRESS } from './recipes';
import { DENSITY, FOCUS_RING, LIFT, RADIUS_PANEL } from './recipes';

export type PresetSemantics = 'radio' | 'pressed';

export interface PresetTileProps {
  label: string;
  description?: string;
  /** Off-tile explanation: the native title and the accessible description (never visible text on the tile). */
  hint?: string;
  art: React.ReactNode;
  /** CSS aspect-ratio of the art box ("4 / 5" by default). */
  aspect?: string;
  selected: boolean;
  onSelect: () => void;
  semantics?: PresetSemantics;
  badge?: React.ReactNode;
  /**
   * The top corner the chosen check sits in ('right' by default). Art that draws into its top-right corner asks for
   * 'left' (a right-to-left lettering sample starts there); the badge sits top-left, so 'left' is for badge-less tiles.
   */
  checkSide?: 'right' | 'left';
  disabled?: boolean;
  /** Roving focus (PresetGrid): only one tile in the tab order. */
  tabIndex?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  className?: string;
}

/** The tile control: the panel radius, a hairline, the chosen ring in ink. */
export const PRESET_TILE = `group/preset relative flex w-full min-w-0 flex-col gap-2 border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-2 text-left ${RADIUS_PANEL} ${LIFT} ${PRESS} disabled:cursor-not-allowed disabled:opacity-50 aria-checked:border-[var(--ds-ink)] aria-pressed:border-[var(--ds-ink)] aria-checked:ring-1 aria-checked:ring-[var(--ds-ink)] aria-pressed:ring-1 aria-pressed:ring-[var(--ds-ink)] ${DENSITY.coarse}`;

export function PresetTile({ label, description, hint, art, aspect = '4 / 5', selected, onSelect, semantics = 'radio', badge, checkSide = 'right', disabled = false, tabIndex, onKeyDown, buttonRef, className }: PresetTileProps) {
  const hintId = React.useId();
  return (
    <button
      ref={buttonRef}
      type="button"
      role={semantics === 'radio' ? 'radio' : undefined}
      aria-checked={semantics === 'radio' ? selected : undefined}
      aria-pressed={semantics === 'pressed' ? selected : undefined}
      disabled={disabled}
      title={hint || undefined}
      aria-describedby={hint ? hintId : undefined}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      data-slot="preset-tile"
      data-state={selected ? 'on' : 'off'}
      className={`${cn(PRESET_TILE, className)} ${FOCUS_RING}`}
    >
      {/* Spans only: a button holds phrasing content, never a <div>. */}
      <MediaTile as="span" aspect={aspect} lift={false} chip={badge} className="pointer-events-none">
        {art}
      </MediaTile>
      {selected ? (
        <span aria-hidden="true" data-slot="preset-check" className={`ds-pop absolute ${checkSide === 'left' ? 'left-3' : 'right-3'} top-3 inline-flex size-6 items-center justify-center rounded-full bg-[var(--ds-ink)] text-[var(--ds-canvas)] [&_svg]:size-3.5`}>
          <Check strokeWidth={3} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col gap-0.5 px-0.5 pb-0.5">
        <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-[var(--ds-ink)]">{label}</span>
        {description ? <span className="line-clamp-2 text-[12px] leading-4 text-[var(--ds-muted)]">{description}</span> : null}
      </span>
      {/* `hidden`: out of the tile's name and never shown, yet still its description (aria-describedby reads it). */}
      {hint ? (
        <span id={hintId} hidden data-slot="preset-hint">
          {hint}
        </span>
      ) : null}
    </button>
  );
}
