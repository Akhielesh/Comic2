// Reveal — fade + rise a block in on mount. Calm static fallback under reduced motion.

import React from 'react';
import { motion } from 'framer-motion';
import { revealVariants, springSoft, usePrefersReducedMotion } from './motion';

export interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Extra delay before the reveal (seconds). */
  delay?: number;
  /** Rise distance in px. */
  distance?: number;
}

export const Reveal: React.FC<RevealProps> = ({ children, className, delay = 0, distance = 12 }) => {
  const reduce = usePrefersReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="shown"
      variants={revealVariants(distance)}
      transition={{ ...springSoft, delay }}
    >
      {children}
    </motion.div>
  );
};
