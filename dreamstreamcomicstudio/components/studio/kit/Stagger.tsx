// Stagger — reveal a list/grid of children in sequence (CSS, visible-by-default). The container
// gives each direct child an incremental entrance delay (see index.css .studio-stagger). Wrap
// items in <StaggerItem/> (a passthrough that exists for readable call-sites + future hooks).

import React from 'react';

export interface StaggerProps {
  children: React.ReactNode;
  className?: string;
  /** Kept for API compatibility (delays are CSS-driven now). */
  step?: number;
  delay?: number;
}

export const Stagger: React.FC<StaggerProps> = ({ children, className }) => (
  <div className={`studio-stagger ${className ?? ''}`}>{children}</div>
);

export interface StaggerItemProps {
  children: React.ReactNode;
  className?: string;
  distance?: number;
}

export const StaggerItem: React.FC<StaggerItemProps> = ({ children, className }) => (
  <div className={className}>{children}</div>
);
