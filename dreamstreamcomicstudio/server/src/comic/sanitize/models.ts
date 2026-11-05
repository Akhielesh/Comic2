// Client-patch rules for the image-model lock (models.md §3.4 item 5). Owner: M1-LOCK-SERVER.
//
// The lock itself is a server-only op (`image_model`): no client batch can carry it (CLIENT_PATCHABLE_OPS
// excludes it), so this package registers no op sanitizer of its own. What clients CAN send is a `settings`
// patch — a core op jobs.ts sanitizes — whose `imageModelOverride` is a PRE-LOCK preference only: once the comic
// is locked (the persisted lock, or the migration lock of a legacy doc), changing it would be a silent model
// switch (or would re-point a legacy comic's derived lock), so the batch is refused with 409 MODEL_LOCKED and the
// honest way out. A `quality` change stays allowed: on a locked comic the tier only picks the resolution.

import type { ComicDoc, Settings } from '../../../../shared/comic/doc.js';
import { getImageModel } from '../../../../shared/comic/models.js';
import { lockedModelId } from '../../../../shared/comic/modelLock.js';
import type { OpSanitizer } from '../extensions.js';
import { StudioError, type StudioErrorCode } from '../types.js';

/** models.md §3.4 error code. */
export const MODEL_LOCKED_CODE: StudioErrorCode = 'MODEL_LOCKED';

/** "Nano Banana 2.1" for a registry id; the id itself when the registry no longer lists it. */
export const modelName = (modelId: string): string => getImageModel(modelId)?.nickname ?? modelId;

/** models.md §3.4 item 5, exact copy. */
export const lockedSettingsMessage = (modelId: string): string =>
  `This comic is locked to ${modelName(modelId)}. Use Change model (consistency can be affected).`;

/** 409 MODEL_LOCKED with the copy above. */
export const modelLockedError = (message: string): StudioError => new StudioError(MODEL_LOCKED_CODE, message, { status: 409 });

/**
 * Throws 409 MODEL_LOCKED when a sanitized settings patch would change `imageModelOverride` on a locked comic.
 * Re-sending the current value (a client that echoes its whole settings object) is not a change and passes.
 */
export const assertSettingsPatchAllowed = (doc: ComicDoc, patch: Partial<Settings>): void => {
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'imageModelOverride')) return;
  const locked = lockedModelId(doc);
  if (!locked) return;
  const next = patch.imageModelOverride || undefined;
  const current = doc.settings.imageModelOverride || undefined;
  if (next === current) return;
  throw modelLockedError(lockedSettingsMessage(locked));
};

/** No feature op: the lock is server-only and `settings` is a core op (see the header). */
export const MODELS_SANITIZERS: OpSanitizer[] = [];
