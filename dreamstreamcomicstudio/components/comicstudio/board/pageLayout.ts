// Page geometry for the board: a thin re-export of the shared module (contract §11.1).
//
// The row-blueprint parser, the panel-box estimator and the region helpers used to be a hand
// port of the server's vision.ts logic kept "in step" by hand. They now live once, in
// shared/comic/pageGeometry.ts, which both the client and the server import. Every export name
// and signature here is unchanged, so PageEditor, ComicPageView, balloonGeometry and the export
// code keep working untouched.

export {
  MIN_REGION,
  estimatePanelBoxes,
  layoutPanelCount,
  panelAtPoint,
  panelBoxesFor,
  panelForRegion,
  parseLayout,
  regionFromPoints,
  synthesizeLayout,
  toPagePoint
} from '../../../shared/comic/pageGeometry';
export type { LayoutCell, LayoutOptions, ParsedLayout, Point } from '../../../shared/comic/pageGeometry';
