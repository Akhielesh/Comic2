// ToolButton — one tool on the Pro editor's rail (master plan §2.7 chrome rules): an icon button whose active state is
// SEGMENTED_ACTIVE (never a hue), a 36 px square on a fine pointer and 44 × 44 under a coarse one, with its key in the
// tooltip and in aria-keyshortcuts. A tool that is off says why (aria-disabled + a description), so a keyboard or
// screen-reader user still finds it and hears the reason; its click does nothing.

import React, { useId } from 'react';
import { cn } from '../../../../lib/utils';
import { DENSITY, FOCUS_RING, MUTED, RADIUS_CONTROL, SEGMENTED_ACTIVE, TRANSITION } from '../../../chat/studioDesign';

export interface ToolButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  /** The tool's name ("Balloon"). */
  label: string;
  /** Its single key ("B"). */
  shortcut?: string;
  icon: React.ReactNode;
  active?: boolean;
  /** Why the tool is off (in words); absent = available. */
  disabledReason?: string;
  /** Show the name under the icon (wide rails / tool rows). */
  showLabel?: boolean;
}

export const TOOL_BUTTON_BASE = `inline-flex shrink-0 select-none items-center justify-center gap-0.5 ${RADIUS_CONTROL} ${TRANSITION} motion-reduce:transition-none`;
export const TOOL_BUTTON_IDLE = `${MUTED} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`;

export const ToolButton = React.forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { label, shortcut, icon, active = false, disabledReason, showLabel = false, className, onClick, ...rest },
  ref
) {
  const reasonId = useId();
  const off = !!disabledReason;
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      data-slot="tool-button"
      data-active={active || undefined}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      aria-disabled={off || undefined}
      aria-describedby={off ? reasonId : undefined}
      title={off ? `${label} — ${disabledReason}` : shortcut ? `${label} (${shortcut})` : label}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={`${cn(
        TOOL_BUTTON_BASE,
        showLabel ? 'h-11 min-w-11 flex-col px-1.5' : 'size-9',
        DENSITY.coarseSquare,
        active ? SEGMENTED_ACTIVE : TOOL_BUTTON_IDLE,
        off && 'cursor-not-allowed opacity-40',
        className
      )} ${FOCUS_RING}`}
    >
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
      {showLabel && (
        <span aria-hidden="true" className="whitespace-nowrap text-[10.5px] font-medium leading-none">
          {label}
        </span>
      )}
      {off && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </button>
  );
});
