import React, { createContext, useContext } from 'react';

// Every widget ships in two versions: a `compact` glance card (key facts only) and a
// `detailed` expansive view (full data, controls, breakdowns). The WidgetFrame that
// wraps each artifact owns the current mode (user toggle, AI hint, saved preference)
// and provides it here; cards read it with `useDensity()` and branch their layout.
//
// Cards that implement a real compact layout register themselves in
// DENSITY_AWARE_TYPES (ChatArtifacts.tsx). Cards that don't are clamped by the frame
// to a short height with a fade + "Show more", so EVERY widget has two sizes even
// before it gets a bespoke compact design.

export type WidgetDensity = 'compact' | 'detailed';

const DensityContext = createContext<WidgetDensity>('detailed');

export const DensityProvider: React.FC<{ value: WidgetDensity; children: React.ReactNode }> = ({ value, children }) => (
  <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
);

/** Current widget density. Defaults to 'detailed' outside a WidgetFrame (panels, tests). */
export const useDensity = (): WidgetDensity => useContext(DensityContext);

/** True when the widget should render its glance (compact) version. */
export const useCompact = (): boolean => useContext(DensityContext) === 'compact';
