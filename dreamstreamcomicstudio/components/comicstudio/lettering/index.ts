// Client feature module: lettering inspector, presets and the balloon layer (owner P1-LETTER-UI).
// Registered through ../features.ts (contract §13.2). Lettering lives inside the page editor and the
// board's page views (BalloonLayer / ComicPageView / PageEditor), not in a card, tab or header slot, so
// the registration itself is empty by design; the public API is re-exported below for other features
// (export, reader, style tab) to import from one place.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};

export { LetteringSvg, svgNodeToReact } from './LetteringSvg';
export { CoverTitleLayer, planCoverTitle } from './CoverTitleLayer';
export { LetteringInspector, placeInspector } from './LetteringInspector';
export { EasyLetteringPanel } from './EasyLetteringPanel';
export { ProLetteringPanel } from './ProLetteringPanel';
export { ColorField } from './ColorField';
export { FontPicker } from './FontPicker';
export { ShapePicker, TailPicker, EasyShapePicker, ShapeIcon } from './ShapePicker';
export { PresetGallery, PlansPreview } from './PresetGallery';
export { BalloonTextEditor } from './BalloonTextEditor';
export { LetteringToolbar } from './LetteringToolbar';
export { SnapGuides, computeSnap, snapTargets } from './SnapGuides';
export { useLetteringSelection } from './useLetteringSelection';
export { useLetteringFontsReady } from './useLetteringFontsReady';
export { useLetterPlans, resolvePlacements } from './useLetterPlans';
export { ensureFonts, fontFaceCss, isFontReady } from './fontLoader';
export { createMeasure, measureForGeneration } from './measure';
export { letteringNodes, letteringSvgMarkup, nodesToMarkup, paintOf } from './svgMarkup';
export * as styleOps from './styleOps';
