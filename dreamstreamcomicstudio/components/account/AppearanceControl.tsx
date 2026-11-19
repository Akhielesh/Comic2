/**
 * The appearance control (navtheme NT-Q): Light · Dark · Paper · System, the one choice services/appearance.ts writes.
 *
 * - `AppearanceSegmented`: the choice as a ds Segmented named "Appearance" (Paper only where Comic Studio's Paper look
 *   applies: pass `paper`). Words, not icons, so it fits a 240 px menu and never asks the person to decode a symbol.
 * - `AppearanceButton`: a ds IconButton named for the current look ("Appearance: Dark", its icon Sun / Moon / BookOpen /
 *   Monitor) that opens a small panel holding the same Segmented: the OVERLAY recipe on the popover layer, anchored under
 *   the button from 600 px and full width under it below that. Focus moves to the checked choice on open; Esc closes it
 *   and gives focus back to the button; a press outside, or focus leaving it, closes it. A disclosure of plain buttons,
 *   no menu library, so the public landing's first load stays small.
 *
 * The choice repaints the page at once, with no reload, and holds for every Comic Studio screen in this browser.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OVERLAY, Z } from '../chat/studioDesign';
import { IconButton } from '../ds/IconButton';
import { Segmented, type SegmentedOption, type SegmentedSize } from '../ds/Segmented';
import { APPEARANCES, APPEARANCE_LABEL, useAppearance, type Appearance } from '../../services/appearance';

const ICON: Record<Appearance, LucideIcon> = { light: Sun, dark: Moon, paper: BookOpen, system: Monitor };

const ITEMS_FIT_THEIR_WORDS = '[&>[role=radio]]:flex-auto';

const WITH_PAPER: readonly SegmentedOption<Appearance>[] = APPEARANCES.map((value) => ({ value, label: APPEARANCE_LABEL[value] }));
const WITHOUT_PAPER: readonly SegmentedOption<Appearance>[] = WITH_PAPER.filter((o) => o.value !== 'paper');

export interface AppearanceSegmentedProps {
  /** Offer Paper (Comic Studio screens). */
  paper?: boolean;
  fullWidth?: boolean;
  size?: SegmentedSize;
  className?: string;
}

export function AppearanceSegmented({ paper = false, fullWidth, size, className }: AppearanceSegmentedProps): React.ReactElement {
  const { appearance, set } = useAppearance();
  return (
    <Segmented
      label="Appearance"
      value={appearance}
      onChange={set}
      options={paper ? WITH_PAPER : WITHOUT_PAPER}
      fullWidth={fullWidth}
      size={size}
      // Each item keeps its own word's width and they share what is left: equal shares cut "System" short in a menu.
      className={cn(ITEMS_FIT_THEIR_WORDS, className)}
    />
  );
}

export interface AppearanceButtonProps {
  /** Offer Paper (Comic Studio screens). */
  paper?: boolean;
  /** Placement classes from the header that hosts it. */
  className?: string;
}

/** Where the panel sits below 600 px: just under the button, set when it opens (the header's own height varies). */
const PANEL_TOP_VAR = '--appearance-panel-top';
const PANEL_GAP_PX = 8;

export function AppearanceButton({ paper = false, className }: AppearanceButtonProps): React.ReactElement {
  const { appearance } = useAppearance();
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState<number | null>(null);
  const panelId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const Icon = ICON[appearance];

  const toggle = () => {
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect();
      setTop(rect && rect.bottom > 0 ? Math.round(rect.bottom + PANEL_GAP_PX) : null);
    }
    setOpen((v) => !v);
  };

  // Focus the chosen look on open; Esc and a press outside close it. Listeners only while open.
  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPress = (e: PointerEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (open && next instanceof Node && !e.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <IconButton
        ref={buttonRef}
        label={`Appearance: ${APPEARANCE_LABEL[appearance]}`}
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        className={className}
        onClick={toggle}
      >
        <Icon />
      </IconButton>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          data-slot="appearance-panel"
          style={top === null ? undefined : ({ [PANEL_TOP_VAR]: `${top}px` } as React.CSSProperties)}
          className={cn(
            OVERLAY,
            Z.popover,
            'ds-scale-in fixed inset-x-4 top-[var(--appearance-panel-top,4rem)] origin-top p-3',
            'medium:absolute medium:inset-x-auto medium:right-0 medium:top-full medium:mt-2 medium:w-72 medium:origin-top-right'
          )}
        >
          <p aria-hidden="true" className="mb-2 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-ink)]">
            Appearance
          </p>
          <AppearanceSegmented paper={paper} fullWidth />
          <p className="mt-2 text-[length:var(--ds-text-xs)] text-[var(--ds-muted)]">{paper ? 'For Comic Studio in this browser.' : 'For this browser.'}</p>
        </div>
      )}
    </span>
  );
}
