// Client feature module: multi-reference uploads (cards: refs). Owner: P1-REFS.
// Registered through ../features.ts (contract §13.2).
//
// The drawer, strip and queue are mounted by their hosts: CastTab / PlaceCard / StyleTab (P2-BOARD)
// use <RefStrip>, the composer (P2-CONVERSATION) uses useRefUpload(studio).add(files, {kind:'inbox'})
// with <UploadQueue> rows and prepareImageFile for its own previews.

import type { FeatureModule } from '../extensions';
import { RefsCard } from './RefsCard';

export const feature: FeatureModule = {
  cards: [{ type: 'refs', Component: RefsCard }]
};

export { RefsCard } from './RefsCard';
export { RefsDrawer, RefsDrawerBody } from './RefsDrawer';
export type { RefsDrawerProps } from './RefsDrawer';
export { RefStrip } from './RefStrip';
export type { RefStripProps } from './RefStrip';
export { RefTile, RefActions } from './RefTile';
export { UploadQueue } from './UploadQueue';
export {
  createUploadQueue,
  isActiveUpload,
  overCapCopy,
  RefUploadError,
  scheduleRefresh,
  uploadQueueFor,
  useRefUpload,
  xhrTransport,
  xhrUploadRef,
  type UploadItem,
  type UploadQueueStore,
  type UploadResponse,
  type UploadState,
  type UploadTransport
} from './useRefUpload';
export { ACCEPT_ATTR, MAX_EDGE, PrepareError, prepareImageFile, quickReject, sha256Hex16, type PreparedImage } from './downscale';
export { HEIC_HELP, isHeicFile } from './heic';
export * as refsModel from './refsModel';
