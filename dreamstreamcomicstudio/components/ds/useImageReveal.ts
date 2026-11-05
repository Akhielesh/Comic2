/**
 * useImageReveal — art never animates before it arrives (styles.md §7.3 M1/M2; Program 3 MO-1, bug B13).
 *
 * The order for every art surface: the caller's reserved box, then its placeholder (a procedural tile, a calm
 * token surface), then the bytes arrive (`load`), then `img.decode()` resolves, and only then the art is shown
 * and its entrance plays. Before, an entrance started on mount, so a page that took longer than the entrance to
 * download finished its "develop" invisible and then popped in.
 *
 * The hook only tracks that moment. `ref` takes the `<img>` itself, or an element that contains one (the first
 * `<img>` inside is watched, so a component that is handed its picture as children still waits for it); with
 * no `<img>` there is nothing to wait for and it reveals at once. Phases: `loading` (no bytes yet) → `decoding`
 * (`load` fired, `decode()` pending) → `revealed`; or `error`, when the caller's own error path takes over.
 * An image the browser already holds (complete with pixels when it mounts) is revealed in the same frame and
 * flagged `fromCache`, so a list that scrolls back into view does not replay its entrances. A `decode()` that
 * rejects or never settles cannot strand the art: the image has loaded, so it is revealed anyway (after
 * REVEAL_DECODE_TIMEOUT_MS at most). A changed `key` (a new picture) starts over at `loading`.
 *
 * Entrances are the caller's, played with the helpers below on the Web Animations API, which runs opacity and
 * transform on the compositor: no React render per frame and no layout. They read the --ds-motion-* tokens
 * from the element's computed style. Under reduced motion (`reduced`) the art still waits for its decode and
 * then swaps in with no entrance. Filter effects (a develop blur) are allowed only where they are cheap:
 * `allowFilterEffects` refuses coarse pointers, low-power devices and art wider than 640 px.
 *
 * Nothing here fetches and nothing here polls: the one timer is the decode fallback, armed after `load` and
 * cleared on reveal or unmount.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

export type ImageRevealPhase = 'loading' | 'decoding' | 'revealed' | 'error';

/** After `load`, the art is revealed by this time even if `decode()` has not settled (it has arrived). */
export const REVEAL_DECODE_TIMEOUT_MS = 1000;
/** Wider art than this never animates a filter: a blur repaints the whole layer every frame. */
export const REVEAL_FILTER_MAX_WIDTH_PX = 640;

/** Decodes a loaded image; null when the browser cannot (the image is shown on `load`). */
export type DecodeImage = (img: HTMLImageElement) => Promise<unknown> | null;

export const decodeImage: DecodeImage = (img) => (typeof img.decode === 'function' ? img.decode() : null);

export interface ImageRevealOptions {
  /** false: no gate (a history render, a static tile). The art shows at once and nothing is to play. Default true. */
  enabled?: boolean;
  /** Replaces `HTMLImageElement#decode` (tests, special images). */
  decode?: DecodeImage;
  /** The decode fallback, in ms after `load`. */
  decodeTimeoutMs?: number;
}

export interface ImageReveal {
  /** Callback ref: the `<img>`, or an element containing it. Stable across renders. */
  ref: (node: Element | null) => void;
  /** The element `ref` was given (null before mount). */
  element: Element | null;
  phase: ImageRevealPhase;
  /** Show the art now: decoded, failed (the caller's error path takes over) or not gated. */
  shown: boolean;
  /** Revealed because the art was already in memory when it mounted: swap it in without an entrance. */
  fromCache: boolean;
  /** The OS asks for reduced motion: wait for the decode, then swap in without an entrance. */
  reduced: boolean;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function findImage(node: Element | null): HTMLImageElement | null {
  if (!node) return null;
  if (node.tagName === 'IMG') return node as HTMLImageElement;
  return node.querySelector('img');
}

const hasPixels = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

interface RevealState {
  key: string;
  phase: ImageRevealPhase;
  fromCache: boolean;
}

/**
 * Gate a picture's entrance on its arrival. `key` names the picture (its url, or an id@rev): a new key starts
 * over. Pass a key without the query string where a re-signed url points at the same file.
 */
export function useImageReveal(key: string | null | undefined, options: ImageRevealOptions = {}): ImageReveal {
  const { enabled = true, decode = decodeImage, decodeTimeoutMs = REVEAL_DECODE_TIMEOUT_MS } = options;
  const reduced = useReducedMotion();
  const id = key ?? '';
  const [element, setElement] = useState<Element | null>(null);
  const [state, setState] = useState<RevealState>({ key: id, phase: 'loading', fromCache: false });
  // The decode function is read when the image loads, never a reason to start over.
  const decodeRef = useRef(decode);
  decodeRef.current = decode;

  useIsoLayoutEffect(() => {
    if (!enabled) return;
    setState((s) => (s.key === id ? s : { key: id, phase: 'loading', fromCache: false }));
    if (!element) return;
    let live = true;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = (phase: ImageRevealPhase, fromCache = false) => {
      if (live) setState({ key: id, phase, fromCache });
    };
    const img = findImage(element);
    if (!img) {
      set('revealed');
      return () => {
        live = false;
      };
    }
    const reveal = (fromCache: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      set('revealed', fromCache);
    };
    const onLoad = () => {
      if (started) return;
      started = true;
      let pending: Promise<unknown> | null = null;
      try {
        pending = decodeRef.current(img);
      } catch {
        pending = null;
      }
      if (!pending) {
        reveal(false);
        return;
      }
      set('decoding');
      timer = setTimeout(() => reveal(false), decodeTimeoutMs);
      // A rejected decode (a src swapped mid-decode, a format the decoder refuses) still shows what loaded.
      pending.then(
        () => reveal(false),
        () => reveal(false)
      );
    };
    const onError = () => {
      started = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      set('error');
    };
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
    if (hasPixels(img)) {
      // Already in memory: shown in this frame, with nothing to wait for and no entrance to replay.
      started = true;
      reveal(true);
    }
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
    };
  }, [enabled, element, id, decodeTimeoutMs]);

  const current = state.key === id ? state : { key: id, phase: 'loading' as const, fromCache: false };
  const phase: ImageRevealPhase = enabled ? current.phase : 'revealed';
  return {
    ref: setElement,
    element,
    phase,
    shown: phase === 'revealed' || phase === 'error',
    fromCache: enabled && current.fromCache,
    reduced
  };
}

// ---- Entrance helpers -------------------------------------------------------------------------------

export interface RevealEnvironment {
  /** The primary pointer is a finger (phones, tablets). */
  coarse: boolean;
  /** Save-Data is on, or the device is clearly low-end (≤ 4 cores and ≤ 2 GB). */
  lowPower: boolean;
  /** The art's rendered width in CSS px (0 when it could not be measured). */
  width: number;
}

type HintNavigator = Partial<Navigator> & { deviceMemory?: number; connection?: { saveData?: boolean } };

/** The reader's static low-power rule (components/comicstudio/immersive/useLowPower.ts), device hints only. */
export function isLowPowerDevice(nav: HintNavigator | undefined = typeof navigator !== 'undefined' ? (navigator as HintNavigator) : undefined): boolean {
  if (!nav) return false;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 8;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 4;
  return (cores <= 4 && memory <= 2) || !!nav.connection?.saveData;
}

export function isCoarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Read once, when the art is revealed: one style and layout read per picture. */
export function readRevealEnvironment(el: Element | null | undefined): RevealEnvironment {
  let width = 0;
  try {
    width = el ? el.getBoundingClientRect().width : 0;
  } catch {
    width = 0;
  }
  return { coarse: isCoarsePointer(), lowPower: isLowPowerDevice(), width: Number.isFinite(width) ? width : 0 };
}

/** A filter (blur, brightness) may animate only on a fine pointer, a capable device and measured art ≤ 640 px. */
export function allowFilterEffects(env: RevealEnvironment): boolean {
  return !env.coarse && !env.lowPower && env.width > 0 && env.width <= REVEAL_FILTER_MAX_WIDTH_PX;
}

function readToken(el: Element | null | undefined, token: string): string {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return '';
  try {
    return window.getComputedStyle(el).getPropertyValue(token).trim();
  } catch {
    return '';
  }
}

/** A `--ds-motion-*` token in ms ("420ms", "0.42s"), or the fallback when it is missing or malformed. */
export function parseMotionMs(raw: string, fallbackMs: number): number {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/.exec(raw.trim());
  if (!m) return fallbackMs;
  const value = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
  return Number.isFinite(value) ? value : fallbackMs;
}

export function motionMs(el: Element | null | undefined, token: string, fallbackMs: number): number {
  return parseMotionMs(readToken(el, token), fallbackMs);
}

/** A `--ds-ease*` token as a timing function, or the fallback. */
export function motionEase(el: Element | null | undefined, token: string, fallback: string): string {
  const raw = readToken(el, token);
  return /^(?:cubic-bezier\([^()]*\)|linear|ease(?:-in|-out|-in-out)?|steps\([^()]*\))$/.test(raw) ? raw : fallback;
}

/**
 * Index.css defaults, used where the tokens cannot be read (pinned to index.css by useImageReveal.tokens.test).
 * camelCase on purpose: a SCREAMING_CASE string export is read as a class list by ds.hygiene.test.
 */
export const revealTokenFallbacks = {
  '--ds-motion-fast': 120,
  '--ds-motion-slow': 300,
  '--ds-motion-enter': 280,
  '--ds-motion-enter-slow': 420,
  '--ds-ease-enter': 'cubic-bezier(0.16, 1, 0.3, 1)'
} as const;

/** Plays a Web Animation, or returns null where the browser has none (the static end state simply shows). */
export function playEntrance(el: Element | null | undefined, keyframes: Keyframe[], timing: KeyframeAnimationOptions): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return null;
  try {
    return (el as HTMLElement).animate(keyframes, timing);
  } catch {
    return null;
  }
}

/** Whether this browser can play an entrance at all (decides whether to mount the layers an entrance moves). */
export function canPlayEntrances(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
}
