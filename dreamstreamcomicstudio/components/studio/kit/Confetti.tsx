// Confetti (Sprint 2, S2.7): a one-shot celebratory burst for green builds/deploys. Pure
// framer-motion particles (no external asset), reduced-motion safe, and self-removing.

import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { usePrefersReducedMotion } from './motion';

const COLORS = ['#FACC15', '#3B82F6', '#EF4444', '#22C55E', '#38BDF8', '#A855F7'];

export interface ConfettiProps {
  /** Number of particles. */
  count?: number;
  /** Fired once the burst finishes (to unmount). */
  onDone?: () => void;
}

export const Confetti: React.FC<ConfettiProps> = ({ count = 80, onDone }) => {
  const reduce = usePrefersReducedMotion();

  const pieces = useMemo(
    () => Array.from({ length: count }).map((_, i) => ({
      id: i,
      x: (Math.random() - 0.5) * 2, // -1..1 horizontal drift
      delay: Math.random() * 0.15,
      duration: 1.6 + Math.random() * 1.2,
      rotate: (Math.random() - 0.5) * 720,
      color: COLORS[i % COLORS.length],
      left: Math.random() * 100,
      size: 6 + Math.random() * 6,
      round: Math.random() > 0.5,
    })),
    [count]
  );

  // Respect reduced motion: skip the animation entirely.
  if (reduce) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden" aria-hidden>
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          initial={{ top: '-5%', left: `${p.left}%`, opacity: 1, rotate: 0 }}
          animate={{ top: '105%', left: `${p.left + p.x * 12}%`, opacity: [1, 1, 0.9, 0], rotate: p.rotate }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
          onAnimationComplete={p.id === 0 ? onDone : undefined}
          style={{ position: 'absolute', width: p.size, height: p.size, backgroundColor: p.color, borderRadius: p.round ? '9999px' : '2px' }}
        />
      ))}
    </div>
  );
};
