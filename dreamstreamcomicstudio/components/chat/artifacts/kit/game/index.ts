// Dependency-free game-engine kit — the shared building blocks every game widget
// composes (a delta-time loop, theme-resolved canvas colors, input helpers, and the
// GameShell that adds size + fullscreen chrome). Import from
// '@/components/chat/artifacts/kit/game'.

export { useGameLoop } from './useGameLoop';
export { useThemeColors } from './useThemeColors';
export type { GameColors } from './useThemeColors';
export { dirFromKey, isGameKey, useSwipe } from './useInput';
export type { Dir } from './useInput';
export { GameShell } from './GameShell';
export type { GameSize, GameDims } from './GameShell';
