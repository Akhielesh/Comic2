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
//   8. budget: the redraw, priced on the post-switch pin, would go over budgetUsd (not approved) → nothing
//      changes; the answer says by how much and offers Raise the budget / switch without redrawing
// On success, one batch: the new lock (origin 'user_change', a changes[] entry) + the §3.6 F notice. A redraw runs
// as the normal render action(s) for the drawn targets with `force` and the confirmed quote (re-gated as usual).
// 'all' draws the character sheets first and starts the pages + cover only once every sheet is ready on the new
// model (the pages use them as identity anchors); otherwise the rest is offered as a priced chip, never started.
// The switch itself is free: nothing is reserved or spent by this action.

import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { REDRAW_SCOPES, type ComicDoc, type ImageModelLock, type NextStep, type RedrawScope } from '../../../../shared/comic/doc.js';
import { FREE_PLAN_IMAGE_MODEL, drawnTargets, modelFit, redrawQuote, type PriceBook, type RedrawQuote } from '../../../../shared/comic/modelLock.js';
import { IMAGE_MODELS, type ImageModelSpec } from '../../../../shared/comic/models.js';
import type { SpendAction, StudioAction } from '../../../../shared/comic/ops.js';
import { BILLING_ENABLED } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { costFormatterFor } from '../costText.js';
import type { ActionHandler } from '../extensions.js';
import {
  RAISE_BUDGET_STEP,
  RUN_ACTIVE,
  commitWithMessage,
  estimateSpendAction,
  gateDecision,
  hasActiveRun,
  imageRouteFor,
  lockOf,
  lockedSpecId,
  noticeCard,
  pendingUsdOf,
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

/** A character sheet or place sheet that is drawn (ready, with an asset) on `modelId`. */
const sheetReadyOn = (doc: ComicDoc, id: string, modelId: string): boolean => {
  const render = doc.cast.find((c) => c.id === id)?.sheet ?? doc.places.find((p) => p.id === id)?.sheet;
  if (!render || render.status !== 'ready' || !render.asset) return false;
  const model = render.asset.model ?? render.model;
  return !!model && lockedSpecId(model) === modelId;
};

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

  const at = Date.now();
  const lock: ImageModelLock = {
    modelId: spec.id,
    providerModel: route.model,
    lockedAt: at,
    origin: 'user_change',
    changes: [{ from: priorId!, to: spec.id, at, redraw: action.redraw, quotedUsd: round4(action.quotedUsd) }, ...(prior.changes ?? [])].slice(0, DOC_LIMITS.modelChanges)
  };
  const fromName = modelName(prior.modelId);
  const actions = redrawActions(doc, action.redraw, quote, action.quotedUsd);

  // 8. Budget (before anything changes): the redraw priced on the post-switch pin, at real prices. A switch the
  // budget can't redraw would leave the book mixed — the very thing "Switch and redraw" was chosen to avoid.
  if (actions.length) {
    const switched: ComicDoc = { ...doc, imageModel: lock };
    const estimates = actions.map((a) => estimateSpendAction(switched, a, route.byok, prices));
    const usd = round4(estimates.reduce((sum, e) => sum + e.usd, 0));
    const estimate = { usd, imageCount: estimates.reduce((n, e) => n + e.imageCount, 0), model: spec.nickname, lines: estimates.flatMap((e) => e.lines) };
    if (gateDecision(doc, estimate, true, { budgetApproved: opts.budgetApproved, pendingUsd: pendingUsdOf(ctx.session) }) === 'budget') {
      return overBudget(ctx, opts, doc, spec, action.redraw, usd);
    }
  }

  // Success: the new lock and its history, with the notice, in one batch.
  const steps: NextStep[] = [];
  let text: string;
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
  // The redraw is the normal spend: the same gate, budget and quote checks as any confirmed render.
  const redrawOpts: RunActionOptions = { ...opts, confirmed: true };
  const first = await startAction(ctx, actions[0], redrawOpts);
  if (actions.length === 1) return first;
  return chainAfterSheets(ctx, opts, redrawOpts, spec, actions, first, prices, route.byok);
}

/**
 * 'all' = sheets first, then the pages + cover. The pages start only when the sheets run started AND every sheet in
 * it ended ready on the new model; otherwise the rest is offered as one priced chip (never started on old-model
 * anchors, never over a still-open sheets gate), and an error is said, never swallowed.
 */
function chainAfterSheets(
  ctx: StudioContext,
  opts: RunActionOptions,
  redrawOpts: RunActionOptions,
  spec: ImageModelSpec,
  actions: SpendAction[],
  first: StartedAction,
  prices: PriceBook,
  byok: boolean
): StartedAction {
  const sheets = actions[0];
  const rest = actions[1];
  const cost = costFormatterFor(ctx);
  const what = drawnPhrase(ctx.session.doc, 'pages_cover').text || 'the pages';
  const restChip = (): NextStep => {
    const usd = estimateSpendAction(ctx.session.doc, rest, byok, prices).usd;
    const { quotedUsd: _old, ...fresh } = rest as SpendAction & { quotedUsd?: number };
    return { label: `Redraw ${what} · ${cost.approx(usd)}`, action: { ...(fresh as SpendAction), quotedUsd: usd }, usd };
  };
  if (first.outcome.status !== 'started') {
    // Gated (its gate stays the open one), blocked (an outage card says why) or nothing to draw: the rest waits.
    const text = `Redrawing ${what} waits for the new character sheets, so it hasn't started and nothing was charged for it. Start it once the sheets are drawn.`;
    commitWithMessage(ctx, opts, [], text, [noticeCard('info', text)], [restChip()]);
    return first;
  }
  // Later messages are this run's own (the director turn that started it is over by then).
  const later: RunActionOptions = { ...redrawOpts, collectCard: undefined, collectNextSteps: undefined };
  const ids = sheets.type === 'render_sheets' ? sheets.characterIds ?? [] : [];
  const done = first.done
    .then(async () => {
      const missing = ids.filter((id) => !sheetReadyOn(ctx.session.doc, id, spec.id));
      if (missing.length) {
        const n = missing.length;
        const text = `${n === ids.length ? 'The character sheets weren' : `${n} of the ${ids.length} character sheets weren`}'t redrawn on ${spec.nickname}, so I didn't start ${what}: they use the sheets to keep your characters consistent. Nothing was charged for ${what}.`;
        commitWithMessage(ctx, { ...later, origin: 'job' }, [], text, [noticeCard('warn', text)], [restChip()]);
        return;
      }
      const started = await startAction(ctx, rest, later);
      await started.done;
    })
    .catch((err: unknown) => {
      logger.warn('comic_model_change_redraw_failed', { projectId: ctx.projectId, to: spec.id, message: (err as Error)?.message });
      const reason = err instanceof StudioError ? ` (${err.userMessage.replace(/[.\s]+$/, '')})` : '';
      const text = `I couldn't start redrawing ${what} on ${spec.nickname}${reason}, so nothing was charged for it. You can start it here.`;
      try {
        commitWithMessage(ctx, { ...later, origin: 'job' }, [], text, [noticeCard('warn', text)], [restChip()]);
      } catch (inner) {
        logger.warn('comic_model_change_notice_failed', { projectId: ctx.projectId, message: (inner as Error)?.message });
      }
    });
  return { outcome: first.outcome, done };
}

/**
 * models.md §3.4 item 7.8: the switch-and-redraw would go over the comic's budget. Nothing is switched (no lock,
 * no changes[] entry); the answer says by how much and offers the ways forward (raise the budget, or the confirm
 * again to switch without redrawing).
 */
function overBudget(ctx: StudioContext, opts: RunActionOptions, doc: ComicDoc, spec: ImageModelSpec, scope: RedrawScope, usd: number): StartedAction {
  const cost = costFormatterFor(ctx);
  const budget = typeof doc.settings.budgetUsd === 'number' ? doc.settings.budgetUsd : 0;
  const over = round4(Math.max(0, doc.spend.totalUsd + pendingUsdOf(ctx.session) + usd - budget));
  const what = drawnPhrase(doc, scope).text;
  const by = cost.governed ? 'would go over the budget set for this comic' : `would go over this comic's budget by ${cost.approx(over)}`;
  const text = `Switching to ${spec.nickname} and redrawing ${what} (${cost.approx(usd)}) ${by}. Nothing was switched — raise the budget, or switch without redrawing.`;
  const steps: NextStep[] = [RAISE_BUDGET_STEP, { label: 'Switch without redrawing', client: { type: 'open_model_picker', suggest: spec.id } }];
  commitWithMessage(ctx, opts, [], text, [noticeCard('info', text)], steps);
  return finished({ status: 'blocked', code: 'BUDGET_EXCEEDED', message: text });
}

export const changeImageModelAction: ActionHandler<ChangeImageModel> = {
  type: 'change_image_model',
  spend: false,
  run: (ctx, action, opts) => changeImageModel(ctx, action, opts)
};

export const MODELS_ACTIONS: ActionHandler[] = [changeImageModelAction];
