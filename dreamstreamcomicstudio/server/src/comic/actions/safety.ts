// Feature action "safety" (contract §12.1): safety_recheck — the owner's "This looks fine —
// check again". Owner: P1-SAFETY.
//
// Non-spend: the second look runs on the PLATFORM key (decisions-final #10). A director turn
// gets the result as a notice in its own message; a UI tap gets a new assistant message.

import { newId, type Card, type RenderTarget } from '../../../../shared/comic/doc.js';
import type { StudioAction } from '../../../../shared/comic/ops.js';
import type { ActionHandler } from '../extensions.js';
import { appealMessage, runAppeal } from '../safety/cases.js';
import { StudioError } from '../types.js';

type Recheck = Extract<StudioAction, { type: 'safety_recheck' }>;

const isTarget = (t: unknown): t is RenderTarget => {
  if (!t || typeof t !== 'object') return false;
  const k = (t as { kind?: unknown }).kind;
  if (k === 'cover') return true;
  return (k === 'page' || k === 'sheet' || k === 'place' || k === 'style_option') && typeof (t as { id?: unknown }).id === 'string' && !!(t as { id: string }).id;
};

export const safetyRecheckAction: ActionHandler<Recheck> = {
  type: 'safety_recheck',
  spend: false,
  async run(ctx, action, opts) {
    if (!isTarget(action?.target)) throw new StudioError('BAD_REQUEST', 'Pick the page, cover or sheet to check again.', { status: 400 });
    const note = typeof action.note === 'string' ? action.note.slice(0, 300) : undefined;
    const result = await runAppeal(ctx, action.target, note);
    if (opts?.collectCard) {
      const card: Card = { type: 'notice', id: newId('card'), tone: result.status === 'cleared' ? 'success' : 'info', text: result.message };
      opts.collectCard(card);
      if (result.nextSteps?.length) opts.collectNextSteps?.(result.nextSteps);
    } else {
      appealMessage(ctx.session, result);
    }
    return {
      outcome: { status: 'done', message: result.message, ...(result.nextSteps?.length ? { nextSteps: result.nextSteps } : {}) },
      done: Promise.resolve()
    };
  }
};

export const SAFETY_ACTIONS: ActionHandler[] = [safetyRecheckAction as unknown as ActionHandler];
