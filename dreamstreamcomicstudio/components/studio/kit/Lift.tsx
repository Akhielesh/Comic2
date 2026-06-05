// Lift — a hover-lift / press-depress wrapper for cards, tiles and CTAs. Generic motion.div
// so it can wrap anything; the interactive element (button/link) lives inside. Static under
// reduced motion.

import React from 'react';
import { motion } from 'framer-motion';
import { springSnappy, usePrefersReducedMotion } from './motion';

export interface LiftProps {
  children: React.ReactNode;
  className?: string;
  /** Lift distance on hover, in px. */
  lift?: number;
  /** Scale on hover (1 = none). */
  hoverScale?: number;
  /** Scale on press (1 = none). */
  tapScale?: number;
}

export const Lift: React.FC<LiftProps> = ({
  children,
  className,
  lift = 2,
  hoverScale = 1.02,
  tapScale = 0.97,
}) => {
  const reduce = usePrefersReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      whileHover={{ y: -lift, scale: hoverScale }}
      whileTap={{ scale: tapScale, y: 0 }}
      transition={springSnappy}
    >
      {children}
    </motion.div>
  );
};
