// Feature actions "breakdown" (contract §12.1): show_breakdown. Owner: P1-BOOKMODEL.
//
// show_breakdown is FREE and read-only: a chip or the intent router asks to see the book, and
// this posts the live `breakdown` card (cover + every page wireframe, panel counts, cost). It
// never commits anything but the assistant message that carries the card, never spends and
// never calls a model. Page ids from the client are untrusted: only ids of existing pages pass.

import { newId, type Msg } from '../../../../shared/comic/doc.js';
import type { StudioAction } from '../../../../shared/comic/ops.js';
import { summarizeBook } from '../../../../shared/comic/plan.js';
import type { ActionHandler } from '../extensions.js';
import { spendIsByok } from '../jobs.js';
import { breakdownCardFor, sanitizeBreakdownPageIds } from '../tools/breakdown.js';

type ShowBreakdown = Extract<StudioAction, { type: 'show_breakdown' }>;

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

export const showBreakdownAction: ActionHandler<ShowBreakdown> = {
  type: 'show_breakdown',
  spend: false,
  async run(ctx, action, opts) {
    const doc = ctx.session.doc;
    const deliver = (text: string, card?: Msg['cards']) => {
      if (opts?.collectCard) card?.forEach((c) => opts.collectCard!(c));
      else {
        const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), ...(card?.length ? { cards: card } : {}) };
        ctx.session.commit([{ op: 'message', msg }], opts?.origin ? { origin: opts.origin } : undefined);
      }
    };

    if (!doc.pages.length) {
      const message = 'There are no pages yet, so there is no breakdown to show. Tell me about the story and I’ll plan the pages.';
      deliver(message);
      return { outcome: { status: 'done', message }, done: Promise.resolve() };
    }

    const asked = Array.isArray(action?.pageIds) && action.pageIds.length > 0;
    const pageIds = sanitizeBreakdownPageIds(doc, action?.pageIds);
    const gone = asked && !pageIds?.length;
    const card = breakdownCardFor(doc, { pageIds: gone ? undefined : pageIds });
    const summary = summarizeBook(doc, { pageIds: card.pageIds, byok: spendIsByok(ctx.keys) });
    const panels = summary.pages.reduce((n, p) => n + p.panels.length, 0);
    const scope = card.pageIds ? `${plural(summary.pages.length, 'page')} of ${doc.pages.length}` : plural(summary.pages.length, 'page');
    const message = `${gone ? 'Those pages are no longer in the book, so here is the whole thing: ' : 'Here’s the breakdown: '}${scope} · ${plural(panels, 'panel')}.`;
    deliver(message, [card]);
    return { outcome: { status: 'done', message }, done: Promise.resolve() };
  }
};

export const BREAKDOWN_ACTIONS: ActionHandler[] = [showBreakdownAction];
