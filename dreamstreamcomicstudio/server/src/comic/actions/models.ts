// Feature actions "models" (models.md §3.4 item 7, §3.6 F): change_image_model — the user's CONFIRMED switch of the
// comic's locked image model, the ONLY path that changes doc.imageModel after the lock. Owner: M1-LOCK-SERVER.
//
// The server validates, in this order (models.md §3.4 item 7):
//   1. ack === true (the confirm said "character consistency can be affected")                 → 400
//   2. a registry id that is pickable and not deprecated — or the current lock, or the model just
//      switched away from (changes[0].from: "Switch back"); never a `replacement` mapping      → 400 / 422
//   3. access: the plan allows other models (caps.modelOverride), or the user's own key draws it  → 403
//   4. a transport for this payer's keys                                                         → 422
//   5. no `block` fit reason (4:5 on GPT Image is one)                                           → 422
//   6. no render run under way                                                                   → 409 RUN_ACTIVE
//   7. the server's own redrawQuote within 15% + $0.01 of the confirmed quotedUsd, else a requote → nothing changes
//   8. budget: a redraw over the budget gets the normal budget gate (the redraw is its own spend action)
// On success, one batch: the new lock (origin 'user_change', a changes[] entry) + the §3.6 F notice. A redraw runs
// as the normal render action(s) for the drawn targets with `force` and the confirmed quote (re-gated as usual).
// The switch itself is free: nothing is reserved or spent by this action.

import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { REDRAW_SCOPES, type ComicDoc, type ImageModelLock, type NextStep, type RedrawScope } from '../../../../shared/comic/doc.js';
import { FREE_PLAN_IMAGE_MODEL, drawnTargets, modelFit, redrawQuote, type RedrawQuote } from '../../../../shared/comic/modelLock.js';
import { IMAGE_MODELS, type ImageModelSpec } from '../../../../shared/comic/models.js';
import type { SpendAction, StudioAction } from '../../../../shared/comic/ops.js';
import { BILLING_ENABLED } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { costFormatterFor } from '../costText.js';
import type { ActionHandler } from '../extensions.js';
import {
  RUN_ACTIVE,
  commitWithMessage,
  hasActiveRun,
  imageRouteFor,
  lockOf,
  lockedSpecId,
  priceBookFor,
  startAction,
  type RunActionOptions,
  type StartedAction
} from '../jobs.js';
import { modelName } from '../sanitize/models.js';
import { StudioError, type StudioContext } from '../types.js';

type ChangeImageModel = Extract<StudioAction, { type: 'change_image_model' }>;

/** The same tolerance as gateStillHolds / quoteIsStale (models.md §3.4 item 7.7). */
export const quoteDrifted = (serverUsd: number, quotedUsd: number): boolean => Math.abs(serverUsd - quotedUsd) > quotedUsd * 0.15 + 0.01;

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const finished = (outcome: StartedAction['outcome']): StartedAction => ({ outcome, done: Promise.resolve() });

/** "3 pages and the cover" / "the cover" / "2 character sheets" — what is drawn, parts at zero left out (§3.6 C). */
const drawnPhrase = (doc: ComicDoc, scope: RedrawScope | 'mention'): { text: string; count: number } => {
  const t = drawnTargets(doc);
  const parts = [t.pages.length ? plural(t.pages.length, 'page') : '', t.cover ? 'the cover' : ''];
  if (scope === 'all') parts.push(t.sheets.length ? plural(t.sheets.length, 'character sheet') : '', t.places.length ? plural(t.places.length, 'place') : '');
  const list = parts.filter(Boolean);
  const count = t.pages.length + (t.cover ? 1 : 0) + (scope === 'all' ? t.sheets.length + t.places.length : 0);
  const text = list.length <= 1 ? list[0] || '' : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return { text, count };
};

const bad = (message: string, status = 400) => new StudioError('BAD_REQUEST', message, { status });

/** The render action(s) that redraw `scope` on the (new) locked model, each carrying its share of the confirmed quote. */
export const redrawActions = (doc: ComicDoc, scope: RedrawScope, quote: RedrawQuote, quotedUsd: number): SpendAction[] => {
  if (scope === 'none') return [];
  const t = drawnTargets(doc);
  const lineUsd = (...labels: string[]) => quote.lines.filter((l) => labels.includes(l.label)).reduce((s, l) => s + (l.usd ?? 0), 0);
  const total = quote.usd ?? 0;
  const share = (part: number) => (total > 0 ? round4((quotedUsd * part) / total) : 0);
  const out: SpendAction[] = [];
  const sheetIds = scope === 'all' ? [...t.sheets, ...t.places] : [];
  // Sheets first: every page uses them as identity anchors.
  if (sheetIds.length) out.push({ type: 'render_sheets', characterIds: sheetIds, force: true, quotedUsd: share(lineUsd('Character sheets', 'Places')) });
  const pagesShare = sheetIds.length ? share(lineUsd('Pages', 'Cover')) : quotedUsd;
  if (t.pages.length) out.push({ type: 'render_pages', pageIds: t.pages, force: true, ...(t.cover ? { includeCover: true } : {}), quotedUsd: pagesShare });
  else if (t.cover) out.push({ type: 'render_cover', quotedUsd: pagesShare });
  return out;
};

async function changeImageModel(ctx: StudioContext, action: ChangeImageModel, opts: RunActionOptions): Promise<StartedAction> {
  // 1. The user's confirm.
  if (!action || (action as { ack?: unknown }).ack !== true) {
    throw bad('Confirm the switch first: a different model can change how your characters look.');
  }
  if (typeof action.modelId !== 'string' || !action.modelId) throw bad('Choose a model to switch to.');
  if (!REDRAW_SCOPES.includes(action.redraw)) throw bad('Choose what should happen to the drawn images.');
  if (typeof action.quotedUsd !== 'number' || !Number.isFinite(action.quotedUsd) || action.quotedUsd < 0) throw bad('That switch has no price on it. Open the model picker again.');

  // The PriceBook first (async): everything after reads the doc synchronously, up to the commit.
  const prices = await priceBookFor(ctx);
  const doc = ctx.session.doc;
  const prior = lockOf(doc);
  const priorId = prior ? lockedSpecId(prior.modelId) : undefined;
  const caps = opts.caps ?? ctx.caps ?? DEFAULT_CAPS;

  // 2. A registry id (never a provider id, never a `replacement` mapping).
  const spec: ImageModelSpec | undefined = IMAGE_MODELS.find((m) => m.id === action.modelId);
  if (!spec) throw bad("That image model isn't in Comic Studio.");
  const switchBack = !!prior?.changes?.[0] && prior.changes[0].from === spec.id;
  if (prior && spec.id === priorId) {
    const text = `This comic already draws with ${spec.nickname} — nothing changed.`;
    commitWithMessage(ctx, opts, [], text, []);
    return finished({ status: 'done', message: text });
  }
  if ((!spec.pickable || spec.lifecycle === 'deprecated') && !switchBack) throw bad(`${spec.nickname} isn't available in Comic Studio yet.`, 422);

  // 3. Access: the plan (or the user's own key drawing it).
  const route = imageRouteFor(spec, ctx.keys);
  const current = prior ? modelName(prior.modelId) : undefined;
  if (!caps.modelOverride && spec.id !== FREE_PLAN_IMAGE_MODEL && !route?.byok) {
    const stays = current ? ` Your comic stays on ${current}.` : '';
    throw new StudioError(
      'FORBIDDEN',
      BILLING_ENABLED
        ? `${spec.nickname} needs a paid plan or your own key.${stays}`
        : `${spec.nickname} isn't part of your included usage yet — add your own Gemini or OpenRouter key in Settings → API keys to use it.${stays}`,
      { status: 403 }
    );
  }

  // 4. A transport for this payer's keys.
  if (!route) throw bad(`${spec.nickname} needs ${spec.routes.openrouter ? 'an OpenRouter' : 'a Gemini'} key. Add one in Settings → API keys.`, 422);

  // 5. Nothing that blocks this comic (access and visibility were judged above, with the own-key rule).
  const blocks = modelFit(spec, doc, caps).filter((r) => r.severity === 'block' && r.code !== 'access' && r.code !== 'hidden');
  if (blocks.length) {
    const err = bad(`${spec.nickname} can't draw this comic: ${blocks.map((b) => b.text.replace(/\.$/, '')).join('; ')}.`, 422);
    throw Object.assign(err, { reason: blocks[0].code });
  }

  // 6. Never under a running render.
  if (hasActiveRun(ctx.session)) throw new StudioError(RUN_ACTIVE, 'Wait for the current drawing to finish, or stop it first.', { status: 409 });

  // Before the first image there is no lock to change: the choice is the pre-lock preference (models.md §3.2).
  if (!prior) {
    const text = `This comic will draw with ${spec.nickname}. It locks to it when the first image is drawn, so every page matches.`;
    commitWithMessage(ctx, opts, [{ op: 'settings', patch: { imageModelOverride: spec.id } }], text, [], undefined, 'Choose model');
    return finished({ status: 'done', message: text });
  }

  // 7. The server's own quote, from real prices; a drifted confirm is re-quoted and nothing changes.
  const cost = costFormatterFor(ctx);
  const quote = redrawQuote(doc, spec.id, action.redraw, prices, route.byok);
  if (action.redraw !== 'none' && quote.usd !== null && quoteDrifted(quote.usd, action.quotedUsd)) {
    const text = `The redraw price changed: ${cost.approx(quote.usd)} now (you saw ${cost.approx(action.quotedUsd)}). Nothing was switched — review the new price and confirm again.`;
    commitWithMessage(ctx, opts, [], text, [], [{ label: 'Review the new price', client: { type: 'open_model_picker', suggest: spec.id } }]);
    return finished({ status: 'blocked', code: 'CONFLICT', message: text, requote: { usd: quote.usd, quotedUsd: action.quotedUsd, lines: quote.lines } });
  }

  // Success: the new lock and its history, with the notice, in one batch.
  const at = Date.now();
  const lock: ImageModelLock = {
    modelId: spec.id,
    providerModel: route.model,
    lockedAt: at,
    origin: 'user_change',
    changes: [{ from: priorId!, to: spec.id, at, redraw: action.redraw, quotedUsd: round4(action.quotedUsd) }, ...(prior.changes ?? [])].slice(0, DOC_LIMITS.modelChanges)
  };
  const fromName = modelName(prior.modelId);
  const steps: NextStep[] = [];
  let text: string;
  const actions = redrawActions(doc, action.redraw, quote, action.quotedUsd);
  if (actions.length) {
    const parts = drawnPhrase(doc, action.redraw);
    text = `Switched to ${spec.nickname}. Redrawing ${parts.text} (${cost.approx(action.quotedUsd)})…`;
  } else {
    const parts = drawnPhrase(doc, 'mention');
    text = parts.count
      ? `Switched to ${spec.nickname}. ${parts.text[0].toUpperCase()}${parts.text.slice(1)} ${parts.count === 1 ? 'was' : 'were'} drawn with ${fromName} and ${parts.count === 1 ? 'stays as it is' : 'stay as they are'}.`
      : `Switched to ${spec.nickname}. New images will be drawn with it.`;
    // §3.6 F chips: the paid redraw (its quote on the chip) and "Switch back" (opens the confirm with "Free now").
    const pagesCover = redrawQuote(doc, spec.id, 'pages_cover', prices, route.byok);
    const redraw = redrawActions(doc, 'pages_cover', pagesCover, pagesCover.usd ?? 0)[0];
    if (redraw && pagesCover.usd !== null) steps.push({ label: `Redraw them · ${cost.approx(pagesCover.usd)}`, action: redraw, usd: pagesCover.usd });
    steps.push({ label: `Switch back to ${fromName}`, client: { type: 'open_model_picker', suggest: priorId! } });
  }
  commitWithMessage(ctx, opts, [{ op: 'image_model', lock }], text, [], steps, 'Change model');
  logger.info('comic_model_changed', { projectId: ctx.projectId, from: priorId, to: spec.id, redraw: action.redraw, quotedUsd: action.quotedUsd });

  if (!actions.length) return finished({ status: 'done', message: text, nextSteps: steps });
  // The redraw is the normal spend: the same gate, budget and quote checks as any confirmed render (sheets first).
  const redrawOpts: RunActionOptions = { ...opts, confirmed: true };
  const first = await startAction(ctx, actions[0], redrawOpts);
  if (actions.length === 1) return first;
  const rest = actions.slice(1);
  const done = first.done.then(async () => {
    for (const next of rest) {
      const started = await startAction(ctx, next, redrawOpts);
      await started.done;
    }
  });
  return { outcome: first.outcome, done: done.catch(() => undefined) };
}

export const changeImageModelAction: ActionHandler<ChangeImageModel> = {
  type: 'change_image_model',
  spend: false,
  run: (ctx, action, opts) => changeImageModel(ctx, action, opts)
};

export const MODELS_ACTIONS: ActionHandler[] = [changeImageModelAction];
