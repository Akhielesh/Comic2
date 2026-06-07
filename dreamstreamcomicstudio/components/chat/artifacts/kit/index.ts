// Rich-output Primitive Kit — the shared building blocks every artifact card (and
// any AI-authored component) composes. Import from '@/components/chat/artifacts/kit'
// to get the house style, charts, and formatters for free.

export { Surface, Expandable } from './Surface';
export { Chart } from './Chart';
export type { ChartPoint, Candle, ChartVariant } from './Chart';
export { Sparkline } from './Sparkline';
export { RadialGauge, LinearGauge, Compass, SunArc } from './Gauges';
export { RangeTabs } from './RangeTabs';
export { TrendPill, Badge, Chip } from './Pills';
export { resolveTheme, withAlpha, PALETTES, BULL, BEAR, NEUTRAL } from './theme';
export type { PaletteName, Palette, ThemeInput, ResolvedTheme } from './theme';
export { compactNumber, formatPrice, formatPriceCompact, formatPercent, formatSigned, relativeTime, shortDate } from './format';
