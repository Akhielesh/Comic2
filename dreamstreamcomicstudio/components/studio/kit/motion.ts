// Motion Kit — shared motion tokens + the reduced-motion gate.
//
// The kit is the cross-cutting "design/motion" foundation from the Code Studio product
// plan (Sprint 0, S0.5). It is a thin, house-styled layer over Framer Motion so every
// surface animates consistently (spring physics, staggered reveals, status pulses) and
// every primitive degrades to a calm, static fallback when the user prefers reduced motion.

import { useEffect, useState } from 'react';
import type { Transition, Variants } from 'framer-motion';

// ---- Motion tokens (springs > linear eases; see plan §5) -------------------------------

/** Soft spring for panels, reveals, layout — settles without overshoot. */
export const springSoft: Transition = { type: 'spring', stiffness: 320, damping: 30, mass: 0.9 };
/** Snappier spring for press/hover micro-interactions. */
export const springSnappy: Transition = { type: 'spring', stiffness: 520, damping: 32 };
/** A house ease used where a duration reads better than a spring. */
export const easeOut: Transition = { duration: 0.45, ease: [0.2, 0.7, 0.2, 1] };

/** Default per-child delay for staggered reveals. */
export const STAGGER_STEP = 0.06;

// ---- Variants --------------------------------------------------------------------------

/** Fade + rise. Used by `Reveal` for page/section mounts. */
export const revealVariants = (distance = 12): Variants => ({
  hidden: { opacity: 0, y: distance },
  shown: { opacity: 1, y: 0 },
});

/** Container that staggers its `StaggerItem` children in. */
export const staggerContainer = (step: number = STAGGER_STEP, delayChildren = 0): Variants => ({
  hidden: {},
  shown: { transition: { staggerChildren: step, delayChildren } },
});

/** A single staggered child (pairs with `staggerContainer`). */
export const staggerItem = (distance = 10): Variants => ({
  hidden: { opacity: 0, y: distance },
  shown: { opacity: 1, y: 0 },
});

// ---- Reduced-motion gate ---------------------------------------------------------------

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

const readInitial = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
};

/**
 * Whether the user has asked for reduced motion. matchMedia-safe (returns `false` when
 * unavailable, e.g. SSR/jsdom) so every primitive can branch to a static fallback. We roll
 * our own rather than lean on Framer's hook so the kit is testable without a matchMedia mock.
 */
export const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(REDUCE_QUERY);
    const onChange = () => setReduced(mql.matches);
    onChange();
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange); // Safari < 14
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  return reduced;
};
