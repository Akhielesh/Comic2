/**
 * Toast — the ONE toast slot for the whole app and its host (redesign plan §2 "Toasts", §11.3 M1b; master plan §1.1).
 *
 * The slot. Every toast in the app takes the same single slot: a new claim takes it from whoever holds it, and the
 * holder is told once (`onLost`), so nudges, a delete's Undo and a save's Undo never stack. This is the rule
 * `claimUndoToast` introduced for the studio's timeline (components/comicstudio/timeline/UndoToast.tsx, which now
 * re-exports `claimToast` from here): component toasts (the timeline's Undo toast, History's restore toast) claim the
 * slot and step aside when they lose it; app toasts go through `toast()` and the host below. There is no queue: the
 * newest toast wins and the one it replaced is gone (it was a heads-up, never the only way to reach something).
 *
 * The host. `<ToastHost />`, mounted once at the app root, renders the slot's app toast: a port of Atlas
 * components/GlobalNotificationBar.tsx onto the TOAST recipes (components/chat/studioDesign.ts) — a monochrome card
 * whose status hue is only its 4 px edge, its icon and its time-left bar; a title that says what happened (two lines
 * at most) and an optional message (three) and action. Its clock runs while the toast is left alone and holds while
 * it is hovered or focused (`data-paused`, which also holds the time-left bar); Esc or the close button dismisses it.
 * It sits above the phone tab bar and the safe area (`--tabbar-h` + `--sa-bottom-eff`), on the toast layer, centred
 * and at most 420 px wide, so it never covers the tab bar at 320 px. A second mounted host renders nothing, so a
 * scene or a test can mount one without doubling the app's. Under reduced motion it neither enters nor leaves with
 * an animation (the hook drops the classes; the skin's CSS stops them as well). Timers exist only while a toast is
 * on screen: an idle page runs none.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '../../lib/utils';
// The toast recipes are not in components/ds/recipes.ts yet (a wave note adds them); they come from the single source.
import { TOAST, TOAST_COUNTDOWN, TOAST_EDGE, TOAST_ENTER, TOAST_EXIT, TOAST_EXIT_FALLBACK_MS, TOAST_MESSAGE, TOAST_TITLE } from '../chat/studioDesign';
import { STATUS_DOT, STATUS_INK, Z, type StatusState } from './recipes';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { useReducedMotion } from './useReducedMotion';

/** How long a toast stays when nobody touches it (the timeline's UNDO_TOAST_MS, the invite notice's 8 s). */
export const TOAST_DURATION_MS = 8000;

// ---------------------------------------------------------------------------------------------------------------
// The one slot
// ---------------------------------------------------------------------------------------------------------------

let claimSeq = 0;
let slotOwner = 0;
const slotListeners = new Set<() => void>();
const publishSlot = (id: number) => {
  slotOwner = id;
  slotListeners.forEach((listener) => listener());
};

/** A claim on the slot: its id, and `release()` to stop listening for its loss (the claim itself stays until replaced). */
interface SlotClaim {
  id: number;
  release(): void;
}

function claimSlot(onLost?: () => void): SlotClaim {
  claimSeq += 1;
  const id = claimSeq;
  publishSlot(id);
  if (!onLost) return { id, release: () => undefined };
  const watch = () => {
    if (slotOwner === id) return;
    slotListeners.delete(watch);
    onLost();
  };
  slotListeners.add(watch);
  return { id, release: () => void slotListeners.delete(watch) };
}

/**
 * Claims the one toast slot and returns the claim's id: whoever held it steps aside. A newer claim takes the slot
 * back; `onLost`, when given, is told once when that happens. (The timeline's `claimUndoToast` is this function.)
 */
export function claimToast(onLost?: () => void): number {
  return claimSlot(onLost).id;
}

/** Subscribes to slot changes (a claim); returns the unsubscribe. */
export function subscribeToastSlot(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => void slotListeners.delete(listener);
}

/** The id of the claim that holds the slot now (0 before any claim). */
export function toastSlotOwner(): number {
  return slotOwner;
}

/** Whether the claim `id` holds the slot, live. */
export function useToastSlot(id: number | null | undefined): boolean {
  const owner = useSyncExternalStore(subscribeToastSlot, toastSlotOwner, toastSlotOwner);
  return id != null && id > 0 && id === owner;
}

// ---------------------------------------------------------------------------------------------------------------
// App toasts (the host's)
// ---------------------------------------------------------------------------------------------------------------

/** The status vocabulary (studioDesign StatusState): healthy, active, waiting, attention, error. */
export type ToastTone = StatusState;

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  /** What happened, in words ("Invite accepted"). Two lines at most. */
  title: string;
  /** One more sentence, when the title needs it. Three lines at most. */
  message?: string;
  /** The status (its edge, icon and time-left bar); `healthy` by default. `error` is announced at once. */
  tone?: ToastTone;
  /** One action ("Undo", "View"); pressing it also dismisses the toast. */
  action?: ToastAction;
  /** Milliseconds it stays untouched: TOAST_DURATION_MS by default; 0 (or Infinity) keeps it until dismissed. */
  duration?: number;
  /** Told once when the toast leaves: its time ran out, it was closed, its action was pressed or dismissToast. */
  onDismiss?(): void;
  /** Told once when a newer toast (any claim on the slot) replaces it before that. */
  onLost?(): void;
}

export interface ToastHandle {
  readonly id: number;
  /** Dismisses this toast if it is still the one shown. */
  dismiss(): void;
}

interface HostToast {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
  action?: ToastAction;
  duration: number;
  onDismiss?(): void;
  release(): void;
}

interface HostSnapshot {
  /** The app toast holding the slot. */
  current: HostToast | null;
  /** A dismissed toast playing its exit (replaced at once by a newer toast; never kept for a lost one). */
  exiting: HostToast | null;
}

const EMPTY: HostSnapshot = { current: null, exiting: null };
let host: HostSnapshot = EMPTY;
const hostListeners = new Set<() => void>();
const setHost = (next: HostSnapshot) => {
  host = next;
  hostListeners.forEach((listener) => listener());
};
const subscribeHost = (listener: () => void) => {
  hostListeners.add(listener);
  return () => void hostListeners.delete(listener);
};
const hostSnapshot = () => host;
const serverSnapshot = () => EMPTY;

const timed = (duration: number) => duration > 0 && Number.isFinite(duration);

/** Shows an app toast in the slot (the host renders it) and returns its handle. */
export function toast(options: ToastOptions): ToastHandle {
  const duration = options.duration ?? TOAST_DURATION_MS;
  const entry: HostToast = {
    id: 0,
    title: options.title,
    message: options.message,
    tone: options.tone ?? 'healthy',
    action: options.action,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    onDismiss: options.onDismiss,
    release: () => undefined
  };
  const claim = claimSlot(() => {
    // A newer claim took the slot: this toast goes at once, without an exit, so two toasts never show together.
    if (host.current?.id === entry.id) setHost(EMPTY);
    options.onLost?.();
  });
  entry.id = claim.id;
  entry.release = claim.release;
  setHost({ current: entry, exiting: null });
  return { id: entry.id, dismiss: () => void dismissToast(entry.id) };
}

/** Dismisses the shown app toast (only if it is `id`, when given). Returns whether one was dismissed. */
export function dismissToast(id?: number): boolean {
  const shown = host.current;
  if (!shown || (id !== undefined && shown.id !== id)) return false;
  shown.release();
  setHost({ current: null, exiting: shown });
  shown.onDismiss?.();
  return true;
}

const finishExit = (id: number) => {
  if (host.exiting?.id === id) setHost({ current: host.current, exiting: null });
};

/** Test seam: forget every app toast (the slot's claims are kept; they are ids, not state). */
export function resetToastsForTests(): void {
  host.current?.release();
  setHost(EMPTY);
}

// ---------------------------------------------------------------------------------------------------------------
// The card and the host
// ---------------------------------------------------------------------------------------------------------------

/** Where the host sits: above the phone tab bar and the safe area, on the toast layer, centred. */
export const TOAST_HOST = `pointer-events-none fixed inset-x-0 ${Z.toast} flex justify-center px-4 bottom-[calc(var(--tabbar-h,56px)+var(--sa-bottom-eff,0px)+12px)]`;
/** The card's width and its content column. */
export const TOAST_CARD_WIDTH = 'w-full max-w-[420px]';
export const TOAST_BODY = 'min-w-0 flex-1';
export const TOAST_ICON = 'mt-0.5 shrink-0 [&_svg]:size-4';
export const TOAST_ACTIONS = 'mt-2 flex flex-wrap items-center gap-2';

const ICONS: Record<ToastTone, React.ComponentType<{ 'aria-hidden'?: boolean }>> = {
  healthy: CircleCheck,
  active: Info,
  waiting: Info,
  attention: TriangleAlert,
  error: CircleAlert
};

export interface ToastCardProps {
  title: string;
  message?: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds before it dismisses itself (the clock holds while hovered or focused); 0 = it stays. */
  duration?: number;
  /** The close button, Esc and the end of the clock call this; without it the card has no close button. */
  onDismiss?(): void;
  /** Leaving: the exit plays (none under reduced motion) and `onExited` follows when it ends. */
  leaving?: boolean;
  onExited?(): void;
  className?: string;
}

/** One toast card (the host's, or a static one in a scene). */
export const ToastCard = React.forwardRef<HTMLDivElement, ToastCardProps>(function ToastCard(
  { title, message, tone = 'healthy', action, duration = 0, onDismiss, leaving = false, onExited, className },
  ref
) {
  const reduce = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(duration);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const clocked = timed(duration) && !!onDismiss;

  // The dismiss clock (Atlas ToastClock): runs while the toast is left alone, holds while hovered or focused and
  // resumes with the time that was left.
  useEffect(() => {
    if (!clocked || paused || leaving) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => dismissRef.current?.(), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [clocked, paused, leaving]);

  const Icon = ICONS[tone];
  return (
    <div
      ref={ref}
      data-slot="toast"
      data-tone={tone}
      data-paused={paused ? '' : undefined}
      data-state={leaving ? 'closed' : 'open'}
      // Errors are announced at once; everything else politely, through the host's status region.
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(TOAST, TOAST_CARD_WIDTH, !reduce && (leaving ? TOAST_EXIT : TOAST_ENTER), className)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onDismiss) {
          event.stopPropagation();
          onDismiss();
        }
      }}
      onAnimationEnd={(event) => {
        // Only the card's own exit ends a dismissal (the icon or the bar may animate too).
        if (leaving && event.target === event.currentTarget) onExited?.();
      }}
    >
      <span aria-hidden="true" data-toast-edge="" className={cn(TOAST_EDGE, STATUS_DOT[tone])} />
      {clocked && !leaving ? (
        <span
          aria-hidden="true"
          data-toast-countdown=""
          className={cn(TOAST_COUNTDOWN, STATUS_DOT[tone])}
          style={{ '--ds-toast-duration': `${duration}ms` } as React.CSSProperties}
        />
      ) : null}
      <span className={cn(TOAST_ICON, STATUS_INK[tone])}>
        <Icon aria-hidden />
      </span>
      <div className={TOAST_BODY}>
        <p className={cn('m-0', TOAST_TITLE)}>{title}</p>
        {message ? <p className={cn('mb-0', TOAST_MESSAGE)}>{message}</p> : null}
        {action ? (
          <div className={TOAST_ACTIONS}>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => {
                action.onClick();
                onDismiss?.();
              }}
            >
              {action.label}
            </Button>
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <IconButton label="Dismiss" title={null} size="sm" className="-mr-0.5 rounded-full text-[var(--ds-muted)]" onClick={onDismiss}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
});

// Only the first mounted host renders, so a second one (a QA scene, a test) never doubles the toast.
let hostSeq = 0;
const mountedHosts: number[] = [];
const hostOrderListeners = new Set<() => void>();
const firstHost = () => mountedHosts[0] ?? 0;
const subscribeHostOrder = (listener: () => void) => {
  hostOrderListeners.add(listener);
  return () => void hostOrderListeners.delete(listener);
};
const announceHostOrder = () => hostOrderListeners.forEach((listener) => listener());

export interface ToastHostProps {
  className?: string;
}

/** The app's toast host: mount once, at the root. Renders the slot's app toast (see `toast`). */
export function ToastHost({ className }: ToastHostProps): React.ReactElement | null {
  const { current, exiting } = useSyncExternalStore(subscribeHost, hostSnapshot, serverSnapshot);
  const reduce = useReducedMotion();
  const [me] = useState(() => (hostSeq += 1));
  const first = useSyncExternalStore(subscribeHostOrder, firstHost, firstHost);
  useEffect(() => {
    mountedHosts.push(me);
    announceHostOrder();
    return () => {
      const at = mountedHosts.indexOf(me);
      if (at >= 0) mountedHosts.splice(at, 1);
      announceHostOrder();
    };
  }, [me]);

  // A dismissed toast leaves after its exit, or after the fallback when no animationend comes; at once under
  // reduced motion (nothing animates, so nothing would end).
  useEffect(() => {
    if (!exiting) return;
    if (reduce) {
      finishExit(exiting.id);
      return;
    }
    const timer = window.setTimeout(() => finishExit(exiting.id), TOAST_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [exiting, reduce]);

  const dismiss = useCallback((id: number) => void dismissToast(id), []);
  if (first !== me || typeof document === 'undefined') return null;
  const shown = current ?? exiting;
  return createPortal(
    <div data-slot="toast-host" role="status" aria-live="polite" className={cn(TOAST_HOST, className)}>
      {shown ? (
        <ToastCard
          key={shown.id}
          title={shown.title}
          message={shown.message}
          tone={shown.tone}
          action={shown.action}
          duration={shown.duration}
          leaving={!current}
          onDismiss={current ? () => dismiss(shown.id) : undefined}
          onExited={() => finishExit(shown.id)}
        />
      ) : null}
    </div>,
    document.body
  );
}
