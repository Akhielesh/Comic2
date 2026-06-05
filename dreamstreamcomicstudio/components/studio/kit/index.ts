// Motion Kit — house-styled motion primitives for DreamStream Studio (Sprint 0, S0.5).
// Thin wrappers over Framer Motion that match the brand and respect reduced motion. Reuse
// these everywhere in the studio (and, later, app-wide) instead of hand-rolling animations.

export { Reveal } from './Reveal';
export type { RevealProps } from './Reveal';

export { Stagger, StaggerItem } from './Stagger';
export type { StaggerProps, StaggerItemProps } from './Stagger';

export { Lift } from './Lift';
export type { LiftProps } from './Lift';

export { Shimmer, Skeleton } from './Shimmer';
export type { ShimmerProps, SkeletonProps } from './Shimmer';

export { StatusPulse } from './StatusPulse';
export type { StatusPulseProps, RunStatus } from './StatusPulse';

export {
  usePrefersReducedMotion,
  springSoft,
  springSnappy,
  easeOut,
  revealVariants,
  staggerContainer,
  staggerItem,
  STAGGER_STEP,
} from './motion';

export { studioTheme } from './theme';
export type { StudioTheme } from './theme';
