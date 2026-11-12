// Pro Edit client part "compose" (master plan §2.12 PE-COMPOSE = pro plan B1): one page node tree used by the screen,
// print, PNG, PDF and ZIP.
//
// - pageNodes.ts: the tree (paper, frames with the picture each shows and its procedural border, overlays — images,
//   shapes, effects through renderFx, stickers by their same-origin URL — as g[data-layer-id]), in the editor scene's
//   draw order, from shared/comic/panelize/compose.ts. Guide-only (print: false) and opaque layers are never drawn in
//   readers or exports; a page without Pro or Ship 2 data does not compose, so every renderer takes its old path.
// - ComposeLayer.tsx: the tree as React SVG (board/ComposedArt.tsx mounts it inside ComicPageView).
// - composeCanvas.ts: the same tree on a canvas (export/rasterize.ts).
// - Effect drawings load lazily (pageNodes.ts setFxLoader / ensureFxDrawings, the PE-FX seam): ComicPageView re-draws
//   once they arrive; every export and the print document wait for them before drawing a page that holds an effect.
//
// Every Pro edit is free software: this folder never imports editActionFor and never calls studio.act
// (proEdit.contract.test.ts scans it). Nothing here writes an op.

import type { ProEditPart } from '../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'compose', ready: true };

export {
  composeScene,
  composeSceneIfAny,
  composeSvgNodes,
  ensureFxDrawings,
  fxDrawingsPending,
  pageComposes,
  setFxLoader,
  type ComposeNode,
  type FxLoader,
  type ComposeResolve,
  type ComposeScene,
  type ComposeSceneOptions,
  type LayerContent,
  type PlacedImage
} from './pageNodes';
export { ComposeLayer, type ComposeLayerProps } from './ComposeLayer';
export { drawComposeScene, type ComposeCanvasOptions, type ComposeImage } from './composeCanvas';
