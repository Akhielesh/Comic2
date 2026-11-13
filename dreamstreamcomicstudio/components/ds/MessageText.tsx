/**
 * MessageText — a message that may be long (an error, a warning, a server notice): it wraps a long URL or id inside its
 * box (WRAP_TEXT, `data-slot="message"`, which the index.css safety net also covers) and, when it runs past `lines`,
 * shows its first lines and a "Show more" text button (docs/design/design-system.md "Long words").
 *
 * - No colour of its own: the banner, card or row around it owns the tone. No spark, price, timer or network.
 * - A short message renders exactly one element (the body): no toggle, no wrapper, so today's look holds.
 * - `role` / `aria-live` / `id` land on the BODY only, and the toggle is the body's next sibling, never inside it: a live
 *   role never announces the toggle, and nothing is inserted into a live region after the first paint. Never put a
 *   MessageText inside a live region; pass the role to it instead. A container that must own the live role (ErrorState)
 *   gives the toggle a place outside it with MessageToggleSlot: the toggle renders there, right after the region.
 * - Measured only while collapsed (`scrollHeight > clientHeight + 1`), in a layout effect on the text and from one
 *   ResizeObserver while collapsed (none while expanded, none where the browser has no ResizeObserver). Once expanded,
 *   "Show less" stays. New text starts collapsed again and is measured in the same layout effect; the toggle stays
 *   mounted through that, so keyboard focus on it is kept.
 * - "New text" means new words, not a new React element: `resetKey` when given, else the string, else the body's
 *   rendered text. A parent re-render that passes the same words in fresh JSX keeps the message as it is.
 */
import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, WRAP_TEXT } from './recipes';

export type MessageTextLines = 2 | 3 | 4 | 6;

/** A static map, so Tailwind sees each clamp class. */
export const LINE_CLAMP: Record<MessageTextLines, string> = {
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  6: 'line-clamp-6'
};

export const MESSAGE_TEXT = `m-0 whitespace-pre-line ${WRAP_TEXT}`;
export const MESSAGE_TOGGLE = `mt-1 inline-flex items-center self-start rounded-[var(--ds-radius-sm)] text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] underline-offset-4 hover:text-[var(--ds-ink)] hover:underline ${DENSITY.coarse} ${FOCUS_RING}`;

/**
 * Where a MessageText inside a live region puts its toggle. `undefined` (the default): next to the body. `null`: the
 * place is not mounted yet, so the toggle waits. An element: the toggle renders into it.
 */
export const MessageToggleSlotContext = createContext<HTMLElement | null | undefined>(undefined);

/**
 * For a container that owns a live role (ErrorState): wrap the region in
 * `<MessageToggleSlotContext.Provider value={el}>`, and render `<MessageToggleSlot slotRef={slotRef} />` just after the
 * region, outside it. The slot is an empty block (no height) until a toggle lands in it.
 */
export function useMessageToggleSlot() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return { el, slotRef: setEl };
}

export function MessageToggleSlot({ slotRef }: { slotRef: (node: HTMLElement | null) => void }) {
  return <div ref={slotRef} data-slot="message-toggle" />;
}

export interface MessageTextProps {
  children: React.ReactNode;
  /** When given, the message counts as new only when this changes (default: the words themselves). */
  resetKey?: string | number;
  /** Lines shown while collapsed (default 3). */
  lines?: MessageTextLines;
  as?: 'p' | 'div';
  /** On the body only. */
  role?: React.AriaRole;
  'aria-live'?: 'polite' | 'assertive' | 'off';
  id?: string;
  className?: string;
}

export function MessageText({ children, resetKey, lines = 3, as: Body = 'p', role, 'aria-live': ariaLive, id, className }: MessageTextProps) {
  const generated = useId();
  const bodyId = id ?? `message-${generated.replace(/:/g, '')}`;
  const ref = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const shown = useRef<string | null>(null);
  const slot = useContext(MessageToggleSlotContext);

  // New words start collapsed, and are measured again in this same layout effect (M11 b, c).
  useLayoutEffect(() => {
    const words =
      resetKey !== undefined ? `key:${resetKey}` : typeof children === 'string' || typeof children === 'number' ? String(children) : (ref.current?.textContent ?? '');
    const changed = shown.current !== null && shown.current !== words;
    shown.current = words;
    if (changed && expanded) {
      // canExpand is left as it is, so the toggle (and keyboard focus on it) stays while the collapsed render re-measures.
      setExpanded(false);
      return; // the collapsed render that follows runs this effect again and measures
    }
    if (expanded) return; // once expanded, "Show less" stays (M11 a)
    const el = ref.current;
    if (!el) return;
    const measure = () => setCanExpand(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, resetKey, lines, expanded]);

  const body = (
    <Body
      ref={ref as React.Ref<never>}
      id={bodyId}
      role={role}
      aria-live={ariaLive}
      data-slot="message"
      className={cn(MESSAGE_TEXT, !expanded && LINE_CLAMP[lines], className)}
    >
      {children}
    </Body>
  );
  // One Fragment either way, so the body is never remounted when the toggle appears.
  const toggle = canExpand ? (
    <button type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((v) => !v)} className={MESSAGE_TOGGLE}>
      {expanded ? 'Show less' : 'Show more'}
    </button>
  ) : null;
  return (
    <>
      {body}
      {slot === undefined ? toggle : slot && toggle ? createPortal(toggle, slot) : null}
    </>
  );
}
