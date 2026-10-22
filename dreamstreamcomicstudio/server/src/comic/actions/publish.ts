// Feature actions "publish" (contract §12.1; sharing.md §3.6/§9): publish, update_publication,
// unpublish, regenerate_link, decline_publish. Owner: P1-PUBLISH.
//
// These run ONLY from the owner's own tap (a card button or the Share sheet) on the owner's
// authenticated stream — a share link can never reach them. They call the same functions as
// the REST routes (one code path), keep the originating `publish` card's status honest
// (pending → running → done | failed | declined) and always say what happened.

import { newId, type Card, type Msg } from '../../../../shared/comic/doc.js';
import type { StudioAction } from '../../../../shared/comic/ops.js';
import { logger } from '../../lib/logger.js';
import type { ActionHandler } from '../extensions.js';
import type { RunActionOptions, StartedAction } from '../jobs.js';
import { cardPatchOps, PublishError, publishWithOutcome, regenerateLink, unpublish, updatePublication } from '../publication/publication.js';
import { StudioError, type StudioContext } from '../types.js';

type A<T extends StudioAction['type']> = Extract<StudioAction, { type: T }>;

const done = (message: string): StartedAction => ({ outcome: { status: 'done', message }, done: Promise.resolve() });
const blocked = (message: string, code?: StudioError['code']): StartedAction => ({ outcome: { status: 'blocked', message, ...(code ? { code } : {}) }, done: Promise.resolve() });

/** Say it: into the director's message when collecting, else as a new assistant message. */
function say(ctx: StudioContext, opts: RunActionOptions, text: string, tone: 'success' | 'info' | 'warn' | 'error', extra: Card[] = []): void {
  const cards: Card[] = [{ type: 'notice', id: newId('card'), tone, text }, ...extra];
  if (opts?.collectCard) {
    cards.forEach((c) => opts.collectCard!(c));
    return;
  }
  const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), cards };
  ctx.session.commit([{ op: 'message', msg }], { origin: 'job' });
}

const setCard = (ctx: StudioContext, cardId: string | undefined, patch: Parameters<typeof cardPatchOps>[2]) => {
  const ops = cardPatchOps(ctx.session.doc, cardId, patch);
  if (ops.length) ctx.session.commit(ops, { origin: 'job' });
};

const errorText = (err: unknown): string => {
  if (err instanceof StudioError) return err.userMessage;
  logger.warn('comic_publish_action_failed', { message: (err as Error)?.message });
  return "Publishing didn't work just now. Your comic is unchanged — please try again.";
};

const codeOf = (err: unknown): StudioError['code'] | undefined => (err instanceof StudioError ? err.code : 'INTERNAL');

const publishAction: ActionHandler<A<'publish'>> = {
  type: 'publish',
  spend: false,
  async run(ctx, action, opts) {
    setCard(ctx, action.cardId, { status: 'running' });
    try {
      const { view, blockers, firstTime } = await publishWithOutcome(ctx, action.request);
      setCard(ctx, action.cardId, { status: 'done', result: { ...(view.url ? { url: view.url } : {}), ...(blockers.length ? { blockers } : {}) } });
      const who = view.visibility === 'public' ? 'anyone with the link, and it’s listed in the public gallery' : 'anyone with the link';
      const text = firstTime
        ? `Published! ${who.charAt(0).toUpperCase()}${who.slice(1)} can read it — read-only${view.allowDownload ? ', with downloads' : ''}. ${view.url ?? ''}`.trim()
        : `Updated — readers now see your latest version. ${view.url ?? ''}`.trim();
      say(ctx, opts, text, 'success', [{ type: 'share', id: newId('card') }]);
      return done(text);
    } catch (err) {
      const message = errorText(err);
      const details = err instanceof PublishError ? err.details : undefined;
      const blockers = Array.isArray(details?.blockers) ? (details!.blockers as NonNullable<Extract<Card, { type: 'publish' }>['result']>['blockers']) : undefined;
      setCard(ctx, action.cardId, { status: 'failed', result: { error: message, ...(blockers?.length ? { blockers } : {}) } });
      say(ctx, opts, message, err instanceof PublishError && err.reason === 'SAFETY_BLOCKED' ? 'warn' : 'error');
      return blocked(message, codeOf(err));
    }
  }
};

const updateAction: ActionHandler<A<'update_publication'>> = {
  type: 'update_publication',
  spend: false,
  async run(ctx, action, opts) {
    setCard(ctx, action.cardId, { status: 'running' });
    try {
      const view = await updatePublication(ctx, action.patch);
      setCard(ctx, action.cardId, { status: 'done', result: view.url ? { url: view.url } : {} });
      const text = `Link settings saved${action.patch.visibility ? ` — it's now ${view.visibility === 'public' ? 'public (in the gallery)' : 'unlisted (link only)'}` : ''}.`;
      say(ctx, opts, text, 'success');
      return done(text);
    } catch (err) {
      const message = errorText(err);
      setCard(ctx, action.cardId, { status: 'failed', result: { error: message } });
      say(ctx, opts, message, 'error');
      return blocked(message, codeOf(err));
    }
  }
};

const unpublishAction: ActionHandler<A<'unpublish'>> = {
  type: 'unpublish',
  spend: false,
  async run(ctx, action, opts) {
    setCard(ctx, action.cardId, { status: 'running' });
    try {
      await unpublish(ctx);
      setCard(ctx, action.cardId, { status: 'done', result: {} });
      const text = 'Unpublished. The link no longer works for anyone. Publishing again creates a new link.';
      say(ctx, opts, text, 'info');
      return done(text);
    } catch (err) {
      const message = errorText(err);
      setCard(ctx, action.cardId, { status: 'failed', result: { error: message } });
      say(ctx, opts, message, 'error');
      return blocked(message, codeOf(err));
    }
  }
};

const regenerateAction: ActionHandler<A<'regenerate_link'>> = {
  type: 'regenerate_link',
  spend: false,
  async run(ctx, action, opts) {
    setCard(ctx, action.cardId, { status: 'running' });
    try {
      const view = await regenerateLink(ctx);
      setCard(ctx, action.cardId, { status: 'done', result: view.url ? { url: view.url } : {} });
      const text = `New link ready — the old one has stopped working. ${view.url ?? ''}`.trim();
      say(ctx, opts, text, 'success', [{ type: 'share', id: newId('card') }]);
      return done(text);
    } catch (err) {
      const message = errorText(err);
      setCard(ctx, action.cardId, { status: 'failed', result: { error: message } });
      say(ctx, opts, message, 'error');
      return blocked(message, codeOf(err));
    }
  }
};

const declineAction: ActionHandler<A<'decline_publish'>> = {
  type: 'decline_publish',
  spend: false,
  async run(ctx, action) {
    setCard(ctx, action.cardId, { status: 'declined' });
    return done('Okay — nothing was published.');
  }
};

export const PUBLISH_ACTIONS: ActionHandler[] = [
  publishAction as ActionHandler,
  updateAction as ActionHandler,
  unpublishAction as ActionHandler,
  regenerateAction as ActionHandler,
  declineAction as ActionHandler
];
