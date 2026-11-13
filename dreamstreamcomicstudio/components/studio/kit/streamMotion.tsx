// Stream Motion — the signature "next-gen" motions for the Comic Studio v3 Agent Stream.
//
// Built entirely on the kit's motion tokens (springs > linear eases; see ./motion) and the
// reduced-motion gate, so every beat degrades to a calm, instant fallback when the user (or
// the OS) asks for reduced motion. These are the choreography pieces the stream needs that
// the base kit (Reveal/Stagger/Shimmer/StatusPulse) does not yet cover:
//
//   • StreamList / StreamItem — cards arrive in the conversation column with a blur-up,
//     spring rise and stagger, then settle with layout animation as later cards push in.
//   • AgentThinking          — the "composing the next card" indicator (looping dots).
//   • ImageDevelop           — an AI render "develops" in once it has loaded and decoded
//     (components/ds/useImageReveal): over-bright and a touch large → crisp, with a one-shot
//     sheen sweep, on the compositor (opacity and transform only, never a filter). Only fresh
//     art that has just arrived develops: never a picture already in memory, never a box with
//     no picture in it. On-theme for a generative-image product.
//   • SelectPop              — style/cover tile selection: spring lift, accent ring draw,
//     check-mark pop (enter/exit via AnimatePresence).
//   • CountUp                — cost/number ticks up (the `$0.42` chip), rAF-tweened.
//   • PanelGrid / PanelPop   — page panels pop in one-by-one as they render.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { springSnappy, springSoft, STAGGER_STEP, usePrefersReducedMotion } from './motion';
import {
  canPlayEntrances,
  motionEase,
  motionMs,
  playEntrance,
  revealTokenFallbacks,
  useImageReveal,
} from '../../ds/useImageReveal';

// ---- Variants -------------------------------------------------------------------------

/** A stream card: blur-up + rise + faint scale, settling on the soft spring. */
export const streamItemVariants: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985, filter: 'blur(8px)' },
  shown: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', transition: springSoft },
};

/** Container that staggers its `StreamItem` children in, newest last. */
export const streamListVariants = (step: number = STAGGER_STEP): Variants => ({
  hidden: {},
  shown: { transition: { staggerChildren: step } },
});

/** A page panel popping into the grid as it finishes rendering. */
export const panelPopVariants: Variants = {
  hidden: { opacity: 0, scale: 0.8, y: 8 },
  shown: { opacity: 1, scale: 1, y: 0, transition: springSnappy },
};

// ---- Stream column --------------------------------------------------------------------

export interface StreamListProps {
  children: React.ReactNode;
  className?: string;
  /** Per-child stagger delay (seconds). */
  step?: number;
}

/** Wraps the agent-stream column; staggers `StreamItem` children in on mount. */
export const StreamList: React.FC<StreamListProps> = ({ children, className, step }) => {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={streamListVariants(step)} initial="hidden" animate="shown">
      {children}
    </motion.div>
  );
};

export interface StreamItemProps {
  children: React.ReactNode;
  className?: string;
}

/** A single agent card. `layout` keeps the column smooth as heights change above it. */
export const StreamItem: React.FC<StreamItemProps> = ({ children, className }) => {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div layout className={className} variants={streamItemVariants}>
      {children}
    </motion.div>
  );
};

// ---- Agent thinking -------------------------------------------------------------------

export interface AgentThinkingProps {
  label?: string;
  className?: string;
}

/** The "agent is composing the next card" affordance — three looping accent dots. */
export const AgentThinking: React.FC<AgentThinkingProps> = ({ label = 'Designing the next card…', className }) => {
  const reduced = usePrefersReducedMotion();
  return (
    <div className={`inline-flex items-center gap-2 ${className ?? ''}`} role="status" aria-live="polite">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]"
            animate={reduced ? undefined : { opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 1.1, repeat: Infinity, delay: i * 0.16, ease: 'easeInOut' }}
          />
        ))}
      </span>
      <span className="text-[12px] text-[var(--ds-muted)]">{label}</span>
    </div>
  );
};

// ---- Image develop --------------------------------------------------------------------

export interface ImageDevelopProps {
  src?: string;
  alt?: string;
  className?: string;
  rounded?: string;
  /** Play the develop-in (default true). Set false to render the resolved image statically. */
  active?: boolean;
  /**
   * Placeholder content when there is no `src` yet (e.g. a tinted block). A picture handed over here as an
   * `<img>` (the board passes its own) is waited for exactly like `src`.
   */
  children?: React.ReactNode;
  /** `<img loading>` for `src`: lazy by default; eager only for the art the user is waiting on (the newest card). */
  loading?: 'lazy' | 'eager';
  /** `<img decoding>` for `src`: async by default, so decoding stays off the main thread. */
  decoding?: 'async' | 'sync' | 'auto';
  /** `<img srcset>` for `src`: lets a small tile fetch a small variant. */
  srcSet?: string;
  /** `<img sizes>` for `src`, read with `srcSet`. */
  sizes?: string;
}

/**
 * The develop's two keyframes: opacity and a 3 % settle (transform), both on the compositor, and never a
 * filter (the owner asked for transform and opacity only; a filter repaints the whole picture every frame).
 * Any filter effect added later must pass `allowFilterEffects` (components/ds/useImageReveal).
 */
export const developKeyframes = (): Keyframe[] => [
  { opacity: 0, transform: 'scale(1.03)' },
  { opacity: 1, transform: 'none' },
];

/**
 * The over-exposed start (what `brightness(1.35)` used to do): light over the art, fading out by opacity
 * alone; then one sheen sweep, moved by transform. Both colours are skin tokens (`--ds-develop-light`,
 * `--ds-develop-sheen`; index.css, light and dark), with the light values as inline fallbacks; dark softens
 * the light (an alpha in the token) so a noir page does not start milky.
 */
const DEVELOP_LIGHT = 'var(--ds-develop-light, rgb(255 255 255))';
const DEVELOP_LIGHT_OPACITY = 0.35;
const DEVELOP_SHEEN = 'linear-gradient(105deg, transparent 30%, var(--ds-develop-sheen, rgba(255,255,255,0.18)) 50%, transparent 70%)';
const HIDDEN: React.CSSProperties = { opacity: 0 };

/** One picture, whatever its signature: a re-signed url for the same file must not hide and develop it again. */
const pictureKey = (src?: string) => (src ? src.split(/[?#]/)[0] : '');

/**
 * An AI render that "develops" in once it has arrived. Until the image has loaded and decoded, a calm static
 * token surface holds its box (never an animation over nothing); then the picture resolves from over-exposed
 * and slightly large to crisp, with one sheen sweep, on the motion tokens (`--ds-motion-enter-slow` for the
 * develop, `--ds-motion-slow` after `--ds-motion-fast` for the sheen). Opacity and transform only, on the Web
 * Animations API (the compositor), and never a filter. Under reduced motion the picture still waits for its
 * decode, then simply appears. A picture the browser already holds (a remount, a second surface on the same
 * url) swaps in with no develop, and a box with no `<img>` (a tint block before the url arrives) never
 * develops: only art that has just arrived does. `active={false}` (history, not a fresh render) shows the
 * image at once with no gate. A develop cut short (`active` drops, a new picture, reduced motion turning on)
 * cancels its animations, so nothing keeps moving over art that is meant to be still.
 */
export const ImageDevelop: React.FC<ImageDevelopProps> = ({
  src,
  alt = '',
  className,
  rounded = 'rounded-xl',
  active = true,
  children,
  loading = 'lazy',
  decoding = 'async',
  srcSet,
  sizes,
}) => {
  const key = pictureKey(src);
  const reveal = useImageReveal(key, { enabled: active });
  const layerRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLDivElement>(null);
  const sheenRef = useRef<HTMLDivElement>(null);
  const [canAnimate] = useState(canPlayEntrances);
  const [developedKey, setDevelopedKey] = useState<string | null>(null);
  const waiting = active && !reveal.shown;
  // Only art that has just arrived develops: not a picture already in memory, not a box with no picture.
  const developing =
    active && !reveal.reduced && !reveal.fromCache && !reveal.empty && canAnimate && reveal.phase === 'revealed' && developedKey !== key;
  const box = reveal.element;

  useLayoutEffect(() => {
    if (!developing) return;
    const duration = motionMs(box, '--ds-motion-enter-slow', revealTokenFallbacks['--ds-motion-enter-slow']);
    const easing = motionEase(box, '--ds-ease-enter', revealTokenFallbacks['--ds-ease-enter']);
    // The sheen starts one fast step in and runs for the slow step, cut to what is left of the develop, so it
    // never sweeps a picture that has already finished developing (the skin's entrances are shorter).
    const sheenDelay = motionMs(box, '--ds-motion-fast', revealTokenFallbacks['--ds-motion-fast']);
    const sheenDuration = Math.max(0, Math.min(motionMs(box, '--ds-motion-slow', revealTokenFallbacks['--ds-motion-slow']), duration - sheenDelay));
    const animations = [
      playEntrance(layerRef.current, developKeyframes(), { duration, easing, fill: 'backwards' }),
      playEntrance(lightRef.current, [{ opacity: DEVELOP_LIGHT_OPACITY }, { opacity: 0 }], { duration, easing, fill: 'both' }),
      playEntrance(sheenRef.current, [{ transform: 'translateX(-130%)' }, { transform: 'translateX(130%)' }], {
        duration: sheenDuration,
        delay: sheenDelay,
        easing: 'ease-in-out',
        fill: 'both',
      }),
    ].filter((a): a is Animation => !!a);
    let live = true;
    const finish = () => {
      if (live) setDevelopedKey(key);
    };
    if (!animations.length) {
      finish();
      return;
    }
    Promise.all(animations.map((a) => a.finished)).then(finish, finish);
    return () => {
      live = false;
      for (const a of animations) a.cancel();
    };
  }, [developing, key, box]);

  return (
    <div ref={reveal.ref} className={`relative overflow-hidden ${rounded} ${className ?? ''}`} data-develop={active ? reveal.phase : undefined}>
      {(waiting || developing) && <div aria-hidden data-develop-placeholder="" className="absolute inset-0 bg-[var(--ds-skeleton)]" />}
      <div ref={layerRef} className="relative h-full w-full" style={waiting ? HIDDEN : undefined}>
        {src ? (
          <img
            src={src}
            srcSet={srcSet}
            sizes={sizes}
            alt={alt}
            loading={loading}
            decoding={decoding}
            className={`h-full w-full object-cover ${rounded}`}
          />
        ) : (
          children
        )}
      </div>
      {developing && (
        <>
          <div ref={lightRef} aria-hidden data-develop-light="" className="pointer-events-none absolute inset-0" style={{ opacity: 0, backgroundColor: DEVELOP_LIGHT }} />
          <div ref={sheenRef} aria-hidden data-develop-sheen="" className="pointer-events-none absolute inset-0" style={{ transform: 'translateX(130%)', backgroundImage: DEVELOP_SHEEN }} />
        </>
      )}
    </div>
  );
};

// ---- Select pop -----------------------------------------------------------------------

export interface SelectPopProps {
  selected?: boolean;
  children: React.ReactNode;
  className?: string;
  rounded?: string;
  onClick?: () => void;
  ariaLabel?: string;
}

/** A selectable tile (style board / cover) — spring lift on hover/press, accent ring + check on select. */
export const SelectPop: React.FC<SelectPopProps> = ({ selected, children, className, rounded = 'rounded-xl', onClick, ariaLabel }) => {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={!!selected}
      aria-label={ariaLabel}
      className={`relative block ${rounded} ${className ?? ''}`}
      whileHover={reduced ? undefined : { y: -2 }}
      whileTap={reduced ? undefined : { scale: 0.98 }}
      transition={springSnappy}
    >
      {children}
      <AnimatePresence>
        {selected && (
          <motion.span
            key="ring"
            aria-hidden
            className={`pointer-events-none absolute inset-0 ${rounded} ring-2 ring-[var(--ds-accent)]`}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={springSnappy}
            style={{ boxShadow: '0 0 0 4px rgba(217,119,87,0.15)' }}
          />
        )}
        {selected && (
          <motion.span
            key="check"
            aria-hidden
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-[var(--ds-accent)] text-[12px] text-white"
            initial={reduced ? false : { scale: 0, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0 }}
            transition={springSnappy}
          >
            ✓
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
};

// ---- Count up -------------------------------------------------------------------------

export interface CountUpProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  durationMs?: number;
  className?: string;
}

/** Tweens a number up to `value` (rAF + ease-out cubic); jumps instantly under reduced motion. */
export const CountUp: React.FC<CountUpProps> = ({ value, prefix = '', suffix = '', decimals = 2, durationMs = 800, className }) => {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState<number>(reduced ? value : 0);
  const fromRef = useRef<number>(0);

  useEffect(() => {
    if (reduced || typeof requestAnimationFrame !== 'function') {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const to = value;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, reduced]);

  return (
    <span className={className}>
      {prefix}
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
};

// ---- Panel grid -----------------------------------------------------------------------

export interface PanelGridProps {
  children: React.ReactNode;
  className?: string;
  step?: number;
}

/** Container for page panels that pop in one-by-one as they render. */
export const PanelGrid: React.FC<PanelGridProps> = ({ children, className, step = 0.05 }) => {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={streamListVariants(step)} initial="hidden" animate="shown">
      {children}
    </motion.div>
  );
};

export interface PanelPopProps {
  children: React.ReactNode;
  className?: string;
}

/** A single page panel that pops in (pairs with `PanelGrid`). */
export const PanelPop: React.FC<PanelPopProps> = ({ children, className }) => {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={panelPopVariants}>
      {children}
    </motion.div>
  );
};
