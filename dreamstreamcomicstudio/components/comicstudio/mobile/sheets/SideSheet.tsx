// SideSheet (mobile.md §4.1/§4.3): the tablet presentation of panel-like sheets (settings, the
// lettering inspector, the media bin, versions). Right or left, safe-area aware, never wider than
// the viewport. Modal → scrim + focus trap + back gesture; non-modal → a labelled region and the
// board behind stays interactive. `container="parent"` docks it inside the nearest positioned
// ancestor (e.g. inside the board pane) instead of the viewport.

import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { HAIRLINE } from '../../../chat/studioDesign';
import { useSheetBehaviour } from '../../conversation/PopSheet';
import { useBackLayer } from '../backStack';
import { useFormFactor } from '../useFormFactor';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  label: string;
  title?: string;
  side?: 'right' | 'left';
  /** Default false (the board stays usable beside it). */
  modal?: boolean;
  /** Panel width in px (default 420). */
  width?: number;
  /** 'viewport' (default, portalled) or 'parent' (absolute inside the positioned ancestor). */
  container?: 'viewport' | 'parent';
  anchorRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  children: React.ReactNode;
}

export const SideSheet: React.FC<SideSheetProps> = ({
  open,
  onClose,
  label,
  title,
  side = 'right',
  modal = false,
  width = 420,
  container = 'viewport',
  anchorRef,
  className,
  children
}) => {
  const ff = useFormFactor();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useSheetBehaviour(open, onClose, ref, anchorRef, { closeOnOutside: false, trapFocus: modal, autoFocus: modal });
  useBackLayer(open && modal, onClose, `side:${label}`);
  if (!open) return null;

  const inViewport = container === 'viewport';
  const panel = (
    <div
      ref={ref}
      role={modal ? 'dialog' : 'region'}
      aria-modal={modal || undefined}
      aria-label={label}
      tabIndex={-1}
      data-sheet="side"
      className={cx(
        `${inViewport ? 'fixed' : 'absolute'} inset-y-0 z-[86] flex w-full flex-col ${HAIRLINE} border-y-0 bg-[var(--ds-surface-strong)] shadow-[0_0_48px_rgba(0,0,0,0.16)] backdrop-blur-xl focus:outline-none`,
        side === 'right' ? 'right-0 border-r-0' : 'left-0 border-l-0',
        ff.reducedMotion ? 'animate-fade-in' : 'studio-reveal',
        className
      )}
      style={{
        maxWidth: `min(${width}px, 100%)`,
        ...(inViewport
          ? {
              paddingTop: 'var(--sa-top, 0px)',
              paddingBottom: 'var(--sa-bottom-eff, 0px)',
              ...(side === 'right' ? { paddingRight: 'var(--sa-right, 0px)' } : { paddingLeft: 'var(--sa-left, 0px)' })
            }
          : {})
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--ds-hairline-soft)] py-1.5 pl-4 pr-1.5">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">
          {title || label}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:w-11"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );

  const tree = modal ? (
    <>
      <div className={cx(inViewport ? 'fixed' : 'absolute', 'inset-0 z-[85] bg-black/30 animate-fade-in')} aria-hidden onClick={onClose} data-sheet-scrim />
      {panel}
    </>
  ) : (
    panel
  );
  return inViewport && typeof document !== 'undefined' ? createPortal(tree, document.body) : tree;
};

export default SideSheet;
