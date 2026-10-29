// Feature actions "models" (models.md §2, W-M): change_image_model — the user's confirmed switch of
// the comic's locked image model. Owner: M1-LOCK-SERVER.
//
// This file is the M0 seam: the registry needs one handler per StudioAction type, and the contract
// added `change_image_model` before the lock server exists. Until M1-LOCK-SERVER replaces this module
// in place (same export names), the action is refused with a calm 501 — nothing is switched, quoted,
// reserved or spent. Never resolve a locked id to a replacement here; never switch without the ack.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import type { ActionHandler } from '../extensions.js';
import { StudioError } from '../types.js';

type ChangeImageModel = Extract<StudioAction, { type: 'change_image_model' }>;

export const NOT_BUILT_MESSAGE = 'Changing the image model is not available yet. Your comic keeps the model it was drawn with.';

export const changeImageModelAction: ActionHandler<ChangeImageModel> = {
  type: 'change_image_model',
  spend: false,
  async run() {
    throw new StudioError('NOT_AVAILABLE', NOT_BUILT_MESSAGE, { status: 501 });
  }
};

export const MODELS_ACTIONS: ActionHandler[] = [changeImageModelAction];
