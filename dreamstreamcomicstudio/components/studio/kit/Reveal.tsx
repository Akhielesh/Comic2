// Reveal — fade + rise a block in on mount. CSS-driven and *visible-by-default*: the animation
// only enhances; content is never gated behind JS running (see index.css .studio-reveal).

import React from 'react';

export interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Extra delay before the reveal (seconds). */
  delay?: number;
  /** Kept for API compatibility (no longer used; reveal direction is fixed). */
  distance?: number;
}

export const Reveal: React.FC<RevealProps> = ({ children, className, delay = 0 }) => (
  <div className={`studio-reveal ${className ?? ''}`} style={delay ? { animationDelay: `${delay}s` } : undefined}>
    {children}
  </div>
);
