/**
 * One polite announcer for the whole app (redesign plan §9: "one polite announcer for result counts"). Search
 * results, a filter that narrows a grid and a shelf that loads more all speak through the same hidden live
 * region, so a screen-reader user hears "12 comics" once instead of three regions talking over each other.
 *
 * The region is created on first use (a visually hidden `role="status"` node at the end of <body>) and reused.
 * Saying the same words twice still speaks: the region is cleared first and the words land a moment later.
 * An urgent message (`assertive`) has its own region; use it only for something the person has to act on.
 * Nothing here polls; the one timer is the short gap between clearing and speaking, cleared on the next call.
 */
import { useEffect, useRef } from 'react';

export type AnnounceUrgency = 'polite' | 'assertive';

/** The pause between clearing the region and writing the words (screen readers skip an unchanged region). */
export const ANNOUNCE_GAP_MS = 60;

const REGION_ATTR = 'data-ds-announcer';
const timers: Partial<Record<AnnounceUrgency, ReturnType<typeof setTimeout>>> = {};

/** Visually hidden but read (the sr-only recipe, inline so the node needs no stylesheet). */
const HIDDEN_STYLE =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap';

function regionFor(urgency: AnnounceUrgency, doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): HTMLElement | null {
  if (!doc?.body) return null;
  const existing = doc.querySelector<HTMLElement>(`[${REGION_ATTR}="${urgency}"]`);
  if (existing) return existing;
  const node = doc.createElement('div');
  node.setAttribute(REGION_ATTR, urgency);
  node.setAttribute('role', urgency === 'assertive' ? 'alert' : 'status');
  node.setAttribute('aria-live', urgency);
  node.setAttribute('aria-atomic', 'true');
  node.setAttribute('style', HIDDEN_STYLE);
  doc.body.appendChild(node);
  return node;
}

/** Speak `message` once (polite by default). An empty message only clears the region. */
export function announce(message: string, urgency: AnnounceUrgency = 'polite'): void {
  const region = regionFor(urgency);
  if (!region) return;
  const text = String(message ?? '').trim().slice(0, 240);
  const pending = timers[urgency];
  if (pending !== undefined) clearTimeout(pending);
  region.textContent = '';
  if (!text) return;
  timers[urgency] = setTimeout(() => {
    timers[urgency] = undefined;
    region.textContent = text;
  }, ANNOUNCE_GAP_MS);
}

/** The hidden region's current words (tests and the QA scene read it). */
export function announcedText(urgency: AnnounceUrgency = 'polite'): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector(`[${REGION_ATTR}="${urgency}"]`)?.textContent ?? '';
}

/** Removes the regions and any pending words (tests). */
export function resetAnnouncer(): void {
  for (const urgency of ['polite', 'assertive'] as const) {
    const pending = timers[urgency];
    if (pending !== undefined) clearTimeout(pending);
    timers[urgency] = undefined;
  }
  if (typeof document === 'undefined') return;
  document.querySelectorAll(`[${REGION_ATTR}]`).forEach((n) => n.remove());
}

/**
 * A count in words, the way the kit says it everywhere: "No comics", "1 comic", "12 comics". `plural`
 * defaults to the noun plus "s". Numbers use the reader's grouping ("1,204 comics").
 */
export function countWords(n: number, noun: string, plural = `${noun}s`): string {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (count === 0) return `No ${plural}`;
  return `${count.toLocaleString()} ${count === 1 ? noun : plural}`;
}

/**
 * Announce `message` whenever it changes after the first render (the first result count is already on screen
 * and read with the page). `null` says nothing.
 */
export function useAnnounce(message: string | null | undefined, urgency: AnnounceUrgency = 'polite'): void {
  const first = useRef(true);
  const last = useRef<string | null | undefined>(message);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      last.current = message;
      return;
    }
    if (message === last.current) return;
    last.current = message;
    if (message) announce(message, urgency);
  }, [message, urgency]);
}
