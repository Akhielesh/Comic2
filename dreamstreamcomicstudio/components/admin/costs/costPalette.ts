import type { CostCategoryId } from '../../../shared/types/costCentre';

// Cost-category colors. Validated with the dataviz skill's validate_palette.js against this
// app's real surfaces (light ≈ #fdfcfa, dark ≈ #2e2e2c): the four categorical slots pass every
// gate on the adjacent pairlist in BOTH modes (worst CVD ΔE 9.1 light / 8.4 dark, normal-vision
// ≥ 19.8). Fixed plan fees are context, not the story, so they wear the de-emphasis gray.
// Light-mode aqua/yellow sit under 3:1 contrast → relieved by the legend + table view.
//
// Color follows the ENTITY (never rank), and the stack order (bottom → top) keeps every
// touching pair a validated neighbour: fixed · ai · containers · connectors · email.
//
// Values are CSS custom properties set on the cost-centre root, so the dark steps swap in
// with the app's `.dark` class (services/theme.ts) — a selected dark palette, not a flip.

export const COST_PALETTE_CLASS =
  '[--cc-fixed:#898781] [--cc-ai:#2a78d6] [--cc-containers:#eb6834] [--cc-connectors:#1baf7a] [--cc-email:#eda100] ' +
  'dark:[--cc-ai:#3987e5] dark:[--cc-containers:#d95926] dark:[--cc-connectors:#199e70] dark:[--cc-email:#c98500]';

export const CATEGORY_COLOR: Record<CostCategoryId, string> = {
  fixed: 'var(--cc-fixed)',
  ai: 'var(--cc-ai)',
  containers: 'var(--cc-containers)',
  connectors: 'var(--cc-connectors)',
  email: 'var(--cc-email)'
};

/** Stack order, bottom → top. */
export const STACK_ORDER: readonly CostCategoryId[] = ['fixed', 'ai', 'containers', 'connectors', 'email'];

export const CATEGORY_SHORT_LABEL: Record<CostCategoryId, string> = {
  fixed: 'Fixed plans',
  ai: 'AI providers',
  containers: 'Sandbox',
  connectors: 'Connectors',
  email: 'Email'
};

/** Status colors (fixed, never themed) — always paired with an icon + label. */
export const STATUS = {
  warning: '#fab219',
  critical: '#d03b3b'
} as const;
