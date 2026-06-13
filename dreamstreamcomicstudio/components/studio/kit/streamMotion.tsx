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
//   • ImageDevelop           — an AI render "develops" in: blur + over-bright → resolve,
//     with a one-shot sheen sweep. On-theme for a generative-image product.
//   • SelectPop              — style/cover tile selection: spring lift, accent ring draw,
//     check-mark pop (enter/exit via AnimatePresence).
//   • CountUp                — cost/number ticks up (the `$0.42` chip), rAF-tweened.
//   • PanelGrid / PanelPop   — page panels pop in one-by-one as they render.

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { springSnappy, springSoft, STAGGER_STEP, usePrefersReducedMotion } from './motion';

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
  /** Placeholder content when there is no `src` yet (e.g. a tinted block). */
  children?: React.ReactNode;
}

/** An AI render that "develops" in — blur + over-bright resolving to crisp, with a sheen sweep. */
export const ImageDevelop: React.FC<ImageDevelopProps> = ({
  src,
  alt = '',
  className,
  rounded = 'rounded-xl',
  active = true,
  children,
}) => {
  const reduced = usePrefersReducedMotion();
  const play = active && !reduced;
  return (
    <motion.div
      className={`relative overflow-hidden ${rounded} ${className ?? ''}`}
      initial={play ? { opacity: 0, scale: 1.05, filter: 'blur(14px) brightness(1.35)' } : false}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px) brightness(1)' }}
      transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {src ? <img src={src} alt={alt} className={`h-full w-full object-cover ${rounded}`} /> : children}
      {play && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          initial={{ x: '-130%' }}
          animate={{ x: '130%' }}
          transition={{ duration: 1.1, ease: 'easeInOut', delay: 0.15 }}
          style={{ background: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.18) 50%, transparent 70%)' }}
        />
      )}
    </motion.div>
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
