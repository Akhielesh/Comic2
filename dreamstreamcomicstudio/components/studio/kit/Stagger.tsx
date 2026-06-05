// Stagger — reveal a list/grid of children in sequence. Wrap items in <StaggerItem/>.
// Both degrade to plain <div>s under reduced motion.

import React from 'react';
import { motion } from 'framer-motion';
import { springSoft, staggerContainer, staggerItem, usePrefersReducedMotion } from './motion';

export interface StaggerProps {
  children: React.ReactNode;
  className?: string;
  /** Per-child delay (seconds). */
  step?: number;
  /** Delay before the first child (seconds). */
  delay?: number;
}

export const Stagger: React.FC<StaggerProps> = ({ children, className, step, delay }) => {
  const reduce = usePrefersReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="shown"
      variants={staggerContainer(step, delay)}
    >
      {children}
    </motion.div>
  );
};

export interface StaggerItemProps {
  children: React.ReactNode;
  className?: string;
  /** Rise distance in px. */
  distance?: number;
}

export const StaggerItem: React.FC<StaggerItemProps> = ({ children, className, distance }) => {
  const reduce = usePrefersReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={staggerItem(distance)} transition={springSoft}>
      {children}
    </motion.div>
  );
};
