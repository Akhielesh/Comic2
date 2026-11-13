/**
 * MessageText — a message that may be long (an error, a warning, a server notice): it wraps a long URL or id inside its
 * box (WRAP_TEXT, `data-slot="message"`, which the index.css safety net also covers) and, when it runs past `lines`,
 * shows its first lines and a "Show more" text button (SPEC-overflow §3.4; docs/design/design-system.md "Long words").
 *
 * - No colour of its own: the banner, card or row around it owns the tone. No spark, price, timer or network.
 * - A short message renders exactly one element (the body): no toggle, no wrapper, so today's look holds.
 * - `role` / `aria-live` / `id` land on the BODY only, and the toggle is the body's next sibling, never inside it: a live
 *   role never announces the toggle, and nothing is inserted into a live region after the first paint. Never put a
 *   MessageText inside a live region; pass the role to it instead.
 * - Measured only while collapsed (`scrollHeight > clientHeight + 1`), in a layout effect on the text and from one
 *   ResizeObserver while collapsed (none while expanded, none where the browser has no ResizeObserver). Once expanded,
 *   "Show less" stays. New text starts collapsed again and is measured in the same layout effect.
 */
import React, { useId, useLayoutEffect, useRef, useState } from 'react';
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

export interface MessageTextProps {
  children: React.ReactNode;
  /** Lines shown while collapsed (default 3). */
  lines?: MessageTextLines;
  as?: 'p' | 'div';
  /** On the body only. */
  role?: React.AriaRole;
  'aria-live'?: 'polite' | 'assertive' | 'off';
  id?: string;
  className?: string;
}

export function MessageText({ children, lines = 3, as: Body = 'p', role, 'aria-live': ariaLive, id, className }: MessageTextProps) {
  const generated = useId();
  const bodyId = id ?? `message-${generated.replace(/:/g, '')}`;
  const ref = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const shown = useRef(children);

  // New text starts collapsed, and is measured again in this same layout effect (M11 b, c).
  useLayoutEffect(() => {
    const changed = shown.current !== children;
    shown.current = children;
    if (changed && expanded) {
      setExpanded(false);
      setCanExpand(false);
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
  }, [children, lines, expanded]);

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
  return (
    <>
      {body}
      {canExpand ? (
        <button type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((v) => !v)} className={MESSAGE_TOGGLE}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}
