// Client feature module: the immersive reader (Leaf). Owner: P1-READER (contract §13.2).
//
// The reader is not a board tab, card or header control: hosts open it directly (studio Read tab
// "Read full screen" / "Preview as reader", the public reader's cover card), so the module registers
// nothing. It re-exports the reader's public surface for those hosts (wave 2: P2-BOARD, P2-READER-PUBLIC).

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};

export { ImmersiveReader, trimAspect, type ImmersiveReaderProps, type ImmersiveReaderEndCard } from './ImmersiveReader';
export { decideLayout, layoutFor, readerLayout, spreadFits, bookViews, bookGeometry, layoutPrefFrom, type LayoutDecision, type LayoutPref, type ReaderLayout } from './readerLayout';
export { parseReaderParams, withReaderParams, type ReaderParams } from './readerUrl';
export { introPlayed, markIntroPlayed, readLayoutPref, writeLayoutPref, readPosition } from './readerPrefs';
export { pageImageCache, pickVariant } from './pageImageCache';
export { LeafDemo } from './LeafDemo';
