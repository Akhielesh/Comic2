// Comic History — small shared pieces of the History UI (Atlas skin; package H5).
//
// Built only from the studioDesign recipes (--ds-* tokens): every control is a 44 px target (min-h-11), the focus
// ring is FOCUS_RING, hue appears only with a word or an icon (STATUS_* / TONE_*), motion reads the tokens and stops
// under reduced motion. HistorySheet is the one sheet API History uses: a BottomSheet on phones (registered on the
// back stack, so Android back closes the top layer first) and a 400 px right drawer elsewhere.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History as HistoryIcon, Sparkles, Undo2, User, Wand2, X } from 'lucide-react';
import {
  CONTROL_BTN,
  FOCUS_RING,
  OVERLINE,
  PRESS,
  PRIMARY_BTN,
  RADIUS_CONTROL,
  RADIUS_PILL,
  STATUS_DOT,
  STATUS_INK,
  TOAST,
  TOAST_EDGE,
  TOAST_TITLE,
  TRANSITION
} from '../../chat/studioDesign';
import { BottomSheet } from '../mobile/sheets/BottomSheet';
import { SideSheet } from '../mobile/sheets/SideSheet';
import type { SheetDetent } from '../mobile/sheets/snap';
import { useFormFactor } from '../mobile/useFormFactor';
import { UNDO_TOAST_MS } from '../timeline/UndoToast';
import type { ActorIcon as ActorIconName } from './historyModel';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Phones (compact width or height) take bottom sheets and the phone compare. */
export const useIsPhone = (): boolean => {
  const ff = useFormFactor();
  return ff.widthClass === 'compact' || ff.heightClass === 'compact';
};

/** Reduced motion (the OS setting, through the shared form-factor store). */
export const useHistoryReducedMotion = (): boolean => useFormFactor().reducedMotion;

// ── Buttons and chips (44 px) ─────────────────────────────────────────────────

const BTN_BASE = `inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 px-4 text-[13px] font-medium ${RADIUS_CONTROL} ${FOCUS_RING} ${PRESS} disabled:cursor-not-allowed disabled:opacity-50`;

export const PrimaryBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, children, type = 'button', ...rest }) => (
  <button type={type} className={cx(BTN_BASE, PRIMARY_BTN, className)} {...rest}>
    {children}
  </button>
);

export const QuietBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, children, type = 'button', ...rest }) => (
  <button type={type} className={cx(BTN_BASE, CONTROL_BTN, 'text-[var(--ds-ink)]', className)} {...rest}>
    {children}
  </button>
);

export const IconBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }> = ({ label, className, children, type = 'button', ...rest }) => (
  <button
    type={type}
    aria-label={label}
    title={label}
    className={cx('inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', RADIUS_CONTROL, FOCUS_RING, TRANSITION, className)}
    {...rest}
  >
    {children}
  </button>
);

/** A filter / language chip: a 44 px target, pressed state in words for screen readers (aria-pressed). */
export const ChipBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }> = ({ selected, className, children, type = 'button', ...rest }) => (
  <button
    type={type}
    aria-pressed={selected}
    className={cx(
      'inline-flex min-h-11 min-w-0 shrink-0 items-center gap-1.5 border px-3 text-[13px] font-medium',
      RADIUS_PILL,
      FOCUS_RING,
      TRANSITION,
      selected ? 'border-[var(--ds-ink)] bg-[var(--ds-accent-soft)] text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)]',
      className
    )}
    {...rest}
  >
    {children}
  </button>
);

/** A small mark with a word (never colour alone): "Changed", "New", "Draft 2", "Published". */
export const Mark: React.FC<{ icon?: React.ReactNode; children: React.ReactNode; tone?: 'neutral' | 'active' | 'attention'; className?: string }> = ({ icon, children, tone = 'neutral', className }) => (
  <span
    className={cx(
      'inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-medium leading-4',
      RADIUS_PILL,
      tone === 'attention' ? `border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] ${STATUS_INK.attention}` : tone === 'active' ? 'border-[var(--ds-ink)] text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] text-[var(--ds-muted)]',
      'bg-[var(--ds-canvas)]',
      className
    )}
  >
    {icon}
    <span className="min-w-0 truncate">{children}</span>
  </span>
);

export const Overline: React.FC<{ children: React.ReactNode; as?: 'h3' | 'p'; id?: string; className?: string }> = ({ children, as = 'h3', id, className }) =>
  React.createElement(as, { id, className: cx('m-0', OVERLINE, className) }, children);

const ACTOR_ICONS: Record<ActorIconName, React.FC<{ className?: string; 'aria-hidden'?: boolean }>> = {
  sparkles: Sparkles,
  user: User,
  wand: Wand2,
  history: HistoryIcon
};

export const ActorGlyph: React.FC<{ icon: ActorIconName; className?: string }> = ({ icon, className }) => {
  const Icon = ACTOR_ICONS[icon];
  return <Icon className={cx('h-4 w-4 shrink-0', className)} aria-hidden />;
};

/** A calm one-line note (an honest error or an empty state) with an optional action. */
export const Note: React.FC<{ children: React.ReactNode; action?: React.ReactNode; tone?: 'neutral' | 'attention' }> = ({ children, action, tone = 'neutral' }) => (
  <div role={tone === 'attention' ? 'alert' : undefined} className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-3 text-[13px] leading-5 text-[var(--ds-muted)]">
    <p className={cx('m-0 min-w-0 flex-1 [overflow-wrap:anywhere]', tone === 'attention' && STATUS_INK.attention)}>{children}</p>
    {action}
  </div>
);

// ── The one sheet History uses ────────────────────────────────────────────────

export interface HistorySheetProps {
  open: boolean;
  onClose(): void;
  /** Accessible name and the visible title. */
  label: string;
  title?: string;
  /** Phone detents (default: 60 % and full). */
  detents?: SheetDetent[];
  children: React.ReactNode;
  className?: string;
}

/** BottomSheet on phones (snaps 60 % / 100 %), a 400 px right drawer elsewhere; modal, on the back stack. */
export const HistorySheet: React.FC<HistorySheetProps> = ({ open, onClose, label, title, detents, children, className }) => {
  const phone = useIsPhone();
  if (phone) {
    return (
      <BottomSheet open={open} onClose={onClose} label={label} title={title ?? label} detents={detents ?? [0.6, 'full']} className={className}>
        <div data-history-sheet={label} className="min-w-0">
          {children}
        </div>
      </BottomSheet>
    );
  }
  return (
    <SideSheet open={open} onClose={onClose} label={label} title={title ?? label} modal width={400} className={className}>
      <div data-history-sheet={label} className="min-w-0">
        {children}
      </div>
    </SideSheet>
  );
};

// ── "Page 3 restored from Tue 10:42 · Undo" ──────────────────────────────────

export interface RestoredToastProps {
  /** null hides it. */
  message: string | null;
  /** 'attention' for a refusal ("Your comic changed while you were looking…"). Default 'healthy'. */
  tone?: 'healthy' | 'attention';
  /** Undo the restore (sends the before-restore moment back with the same scope); absent = no Undo yet. */
  onUndo?: () => void;
  /**
   * What the creator may do next ("Use the earlier drawing too · Free", "Redraw page 3 · ≈ $0.07"). A toast with a
   * choice waits for it: it does not time out (Dismiss closes it).
   */
  actions?: readonly ToastAction[];
  onDismiss(): void;
}

export interface ToastAction {
  label: string;
  onClick(): void;
  /** The primary choice (the free one). */
  primary?: boolean;
}

/**
 * The restore toast (Atlas TOAST recipe; same timing as the timeline's UndoToast): polite, pauses while hovered or
 * focused, sits above the safe area, no animation under reduced motion. Undo works after a reload too — it restores
 * the before-restore moment the server saved first.
 */
export const RestoredToast: React.FC<RestoredToastProps> = ({ message, tone = 'healthy', onUndo, actions, onDismiss }) => {
  const reduce = useHistoryReducedMotion();
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const choice = !!actions?.length;
  useEffect(() => {
    if (!message || paused || choice) return;
    const t = setTimeout(() => dismissRef.current(), UNDO_TOAST_MS);
    return () => clearTimeout(t);
  }, [message, paused, choice]);
  const tree = (
    <div className="pointer-events-none fixed inset-x-0 z-[90] flex justify-center px-4" style={{ bottom: 'calc(var(--sa-bottom-eff, 0px) + 16px)' }} role="status" aria-live="polite">
      {message && (
        <div
          data-history-toast
          className={cx(TOAST, 'w-full max-w-[420px] items-center', choice && 'flex-wrap', !reduce && 'ds-toast-enter')}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <span className={cx(TOAST_EDGE, STATUS_DOT[tone])} aria-hidden />
          <p className={cx('m-0 min-w-0 flex-1', TOAST_TITLE)}>{message}</p>
          {onUndo && (
            <button type="button" onClick={onUndo} className={cx('inline-flex min-h-11 shrink-0 items-center gap-1 px-3 text-[13px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', RADIUS_CONTROL, FOCUS_RING)}>
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
              Undo
            </button>
          )}
          <IconBtn label="Dismiss" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </IconBtn>
          {choice && (
            <div className="flex w-full min-w-0 basis-full flex-wrap gap-2" data-toast-actions>
              {actions!.map((a) =>
                a.primary ? (
                  <PrimaryBtn key={a.label} onClick={a.onClick} className="min-w-0 flex-1 px-3">
                    {a.label}
                  </PrimaryBtn>
                ) : (
                  <QuietBtn key={a.label} onClick={a.onClick} className="min-w-0 flex-1 px-3">
                    {a.label}
                  </QuietBtn>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
  // Portalled: a sheet's transform must never clip or move it.
  return typeof document !== 'undefined' ? createPortal(tree, document.body) : tree;
};
