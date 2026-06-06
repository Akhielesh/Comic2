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

export { Confetti } from './Confetti';
export type { ConfettiProps } from './Confetti';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { CommandPalette } from './CommandPalette';
export type { Command, CommandPaletteProps } from './CommandPalette';

export { ShortcutsHelp } from './ShortcutsHelp';

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

export {
  studioTheme,
  STUDIO_THEMES,
  STUDIO_THEME_ORDER,
  DEFAULT_STUDIO_THEME,
} from './theme';
export type { StudioThemeId, StudioThemeTokens } from './theme';
export { useStudioTheme, useStudioThemeStore } from './themeStore';
export { ThemeSwitcher } from './ThemeSwitcher';
export { StudioAurora } from './StudioAurora';

export { ResizableSplit, applyGutterDelta } from './ResizableSplit';
export type { ResizableSplitProps } from './ResizableSplit';
export { useStudioFocus, STUDIO_FOCUS_ORDER } from './focusStore';
export type { StudioFocus } from './focusStore';
export { FocusToggle } from './FocusToggle';
export { useMediaQuery, useIsWide } from './useMediaQuery';
export { useDialogA11y } from './useDialogA11y';
