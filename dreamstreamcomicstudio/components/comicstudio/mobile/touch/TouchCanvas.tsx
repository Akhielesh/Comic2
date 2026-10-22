// TouchCanvas (contract §13.3; owner P1-SHELL): pinch-zoom / pan surface with a ZoomContext.
// Wave 0 (P0-C) stub: a passthrough (no wrapper element, so layout is untouched) that
// provides scale 1 to children that already read ZoomContext.

import React, { createContext, useContext } from 'react';

export interface ZoomState {
  /** Current zoom (1 = fit). Handles divide their visual and hit sizes by it. */
  scale: number;
}

export const ZoomContext = createContext<ZoomState>({ scale: 1 });
export const useZoom = (): ZoomState => useContext(ZoomContext);

export interface TouchCanvasProps {
  children: React.ReactNode;
  maxScale?: number;
  oneFingerPan?: 'always' | 'whenZoomed' | 'never';
  onZoomChange?(scale: number): void;
  onEdgeOverscroll?(dir: -1 | 1): void;
  disabled?: boolean;
}

const UNZOOMED: ZoomState = { scale: 1 };

export const TouchCanvas: React.FC<TouchCanvasProps> = ({ children }) => <ZoomContext.Provider value={UNZOOMED}>{children}</ZoomContext.Provider>;

export default TouchCanvas;
