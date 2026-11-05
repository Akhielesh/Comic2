// "notice" card: a short, honest status line from the studio (missing key, billing,
// a finished job). Tones are tinted, never alarming unless it really is an error.
// Long URLs and tokens wrap anywhere so they never spill across the column (visualqa P1-3).
//
// Fix chips (plan §5.1, §6; K1 contract): a notice may carry `fixes` — the server's held-back notice ("Use the
// layout that fits" · "Draw page 2 anyway") and its page-check notice (qcNotice.ts: "Make Meera's line in panel 6
// a caption" · "Redraw panel 6 with Meera"). They render as chips under the text, FREE FIRST:
//   - a free chip runs its action as is (a `patch` of client-patchable ops — the server re-validates it) and says
//     "Free";
//   - a paid chip shows its quote in THIS user's terms (conversation/cost.ts → services/costDisplay
//     formatCostForUser: a share of the usage for governed users, never dollars; "on your key" for comics drawn on
//     the user's own key) and goes through the existing spend gate: the action is sent with its `quotedUsd`, the
//     tap is the confirmation, and the server re-gates it (an approval card) if the fresh price is higher.
// A chip is free only when its action spends nothing: a "free" flag on a spend action is treated as paid. A paid
// chip is offered only with a positive quote — the servers quote every real one, and a quote of 0 means nothing is
// left to draw — so a spend never reads "Free" and never runs unpriced.
// Extra flags on an action (`safe: true` for a safer take) pass through untouched.
//
// Chips are re-checked against the LIVE doc (studio.doc), so an old notice never offers a stale fix:
//   - a patch that is already in the doc reads "Done" (derived, so it survives a reload and clears again if the
//     server rejects the edit); one that would put a drawn, current page out of date (a layout fix after the page
//     was drawn anyway) or that targets something no longer there is hidden;
//   - a paid chip whose page is drawing reads "Started"; a render_pages chip with nothing left to draw
//     (quoteRenderPages `nothing`, or a "Draw page N anyway" whose page N was drawn meanwhile) is hidden; a paid
//     chip that ran reads "Started" until the doc changes. (A message's `at` is not the notice's time — a run's
//     outcome keeps its progress message's — so "drawn again since the notice" is not inferred from it.)

import React from 'react';
import { CircleCheck, CircleX, Info, Loader2, TriangleAlert } from 'lucide-react';
import { isPageStale, type Card, type ComicDoc, type NoticeFix, type Page } from '../../../../shared/comic/doc';
import { applyOps, isSpendAction, type DocOp, type StudioAction } from '../../../../shared/comic/ops';
import { pageTargets, quoteRenderPages } from '../../../../shared/comic/plan';
import { TONE_SURFACE, TONE_TEXT } from '../../../chat/studioDesign';
import type { StudioCaps } from '../../../../shared/comic/capabilities';
import { useCostFormat, type CostFormat } from '../cost';
import { ChipBadge, ChipButton, cx } from '../ui';
import { chipLabel } from './NextStepChips';
import { stopsSequence, useAction } from './useAction';

type NoticeCardData = Extract<Card, { type: 'notice' }>;

const TONES: Record<NoticeCardData['tone'], { cls: string; icon: React.ReactNode; role: 'status' | 'alert' }> = {
  info: {
    cls: 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
    icon: <Info className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />,
    role: 'status'
  },
  success: {
    cls: `${TONE_SURFACE.success} text-[var(--ds-ink)]`,
    icon: <CircleCheck className={cx('h-4 w-4', TONE_TEXT.success)} aria-hidden />,
    role: 'status'
  },
  warn: {
    cls: `${TONE_SURFACE.warning} text-[var(--ds-ink)]`,
    icon: <TriangleAlert className={cx('h-4 w-4', TONE_TEXT.warning)} aria-hidden />,
    role: 'status'
  },
  error: {
    cls: `${TONE_SURFACE.danger} text-[var(--ds-ink)]`,
    icon: <CircleX className={cx('h-4 w-4', TONE_TEXT.danger)} aria-hidden />,
    role: 'alert'
  }
};

/** What a notice needs from the studio to run its fix chips (the live controller, or a test fake). */
export interface NoticeCardStudio {
  act(action: StudioAction): Promise<unknown> | unknown;
  /** The comic draws on the user's own key: prices read "on your key". */
  byok?: boolean;
  caps?: Pick<StudioCaps, 'byok' | 'admin' | 'usage'> | null;
  /** The live doc: each chip is re-checked against it (already done, nothing left to do, already started). */
  doc?: ComicDoc | null;
}

/** A positive, finite quote (a paid chip's price), else undefined. */
const positiveUsd = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** A chip as rendered: paid when its action spends (whatever its `free` flag says), with the quote it carries. */
export interface NoticeChip {
  fix: NoticeFix;
  paid: boolean;
  /** Paid chips: the action's quotedUsd (always > 0 — a paid fix without a positive quote is not offered). */
  usd?: number;
  /** The action as it is sent (a paid one carries its quotedUsd). */
  action: StudioAction;
}

/**
 * The card's fixes as chips, free first (stable within each group). A paid fix is offered only with a positive
 * quote: the servers quote every real one (qcNotice's offerPaid drops what it cannot price; jobs.ts quotes "Draw
 * anyway"), and a quote of 0 means nothing is left to draw — so a spend is never badged "Free" or sent unpriced.
 */
export const noticeChips = (fixes: NoticeFix[] | undefined): NoticeChip[] => {
  if (!Array.isArray(fixes)) return [];
  const chips: NoticeChip[] = [];
  for (const fix of fixes) {
    if (!fix || typeof fix.label !== 'string' || !fix.label.trim() || !fix.action || typeof fix.action.type !== 'string') continue;
    const paid = isSpendAction(fix.action) || fix.free !== true;
    if (!paid) {
      chips.push({ fix, paid, action: fix.action });
      continue;
    }
    const usd = positiveUsd((fix.action as { quotedUsd?: unknown }).quotedUsd);
    if (usd !== undefined) chips.push({ fix, paid, usd, action: fix.action });
  }
  return [...chips.filter((c) => !c.paid), ...chips.filter((c) => c.paid)];
};

/**
 * A paid amount in THIS user's terms — "≈1% of your usage" (governed: never dollars) · "≈$0.05 on your key" (BYOK)
 * · "≈$0.05" (admins). The one implementation: the breakdown card's `paidAmount` is this function.
 */
export const noticePrice = (cost: CostFormat, usd: number, byok: boolean): string => (!cost.governed && byok ? `${cost.badge(usd)} on your key` : cost.badge(usd));

// ── Chips against the live doc ────────────────────────────────────────────────

/** How a chip shows right now: offered, already applied (free), already running (paid), or not offered. */
export type NoticeChipState = 'live' | 'done' | 'started' | 'hidden';

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Every field a patch sets already has that value. */
const patchIsIn = (target: object, patch: object): boolean =>
  Object.entries(patch).every(([k, v]) => same((target as Record<string, unknown>)[k], v));
const isBusyPage = (p: Page) => p.render.status === 'queued' || p.render.status === 'rendering';

/** The page an op edits and whether it is already applied (null: its target is gone; undefined: can't tell). */
const opCheck = (doc: ComicDoc, op: DocOp): { pageId?: string; noop?: boolean } | null => {
  switch (op.op) {
    case 'page': {
      const page = doc.pages.find((p) => p.id === op.id);
      return page ? { pageId: page.id, noop: !!op.patch && patchIsIn(page, op.patch) } : null;
    }
    case 'panel': {
      const page = doc.pages.find((p) => p.id === op.pageId);
      const panel = page?.panels.find((x) => x.id === op.id);
      return page && panel ? { pageId: page.id, noop: !!op.patch && patchIsIn(panel, op.patch) } : null;
    }
    case 'line': {
      const page = doc.pages.find((p) => p.id === op.pageId);
      const line = page?.panels.find((x) => x.id === op.panelId)?.lines.find((l) => l.id === op.id);
      if (!page) return null;
      if (op.patch === null) return { pageId: page.id, noop: !line };
      return line ? { pageId: page.id, noop: patchIsIn(line, op.patch) } : null;
    }
    default:
      return { noop: false };
  }
};

/** Pages a paid action draws or checks (for "Started"). */
const spendPages = (action: StudioAction): string[] => {
  const a = action as { type: string; pageId?: unknown; pageIds?: unknown; drawOverfull?: unknown };
  if (typeof a.pageId === 'string') return [a.pageId];
  if (a.type !== 'render_pages') return [];
  const ids = Array.isArray(a.pageIds) && a.pageIds.length ? a.pageIds : Array.isArray(a.drawOverfull) ? a.drawOverfull : [];
  return ids.filter((id): id is string => typeof id === 'string');
};

type RenderPagesAction = Extract<StudioAction, { type: 'render_pages' }>;

/**
 * What a render_pages chip would draw NOW, quoted exactly as the server will (shared plan.ts, the comic's lock, this
 * user's key): a "Render all" holds overfull pages back as the server's gate does, except its drawOverfull.
 */
const liveRenderQuote = (doc: ComicDoc, action: RenderPagesAction, byok: boolean) => {
  const pageIds = Array.isArray(action.pageIds) && action.pageIds.length ? action.pageIds : undefined;
  const renderAll = !pageIds && !action.force;
  const anyway = Array.isArray(action.drawOverfull) ? action.drawOverfull.filter((id): id is string => typeof id === 'string') : [];
  const quote = quoteRenderPages(doc, {
    ...(pageIds ? { pageIds } : {}),
    ...(action.force ? { force: true } : {}),
    ...(action.includeCover ? { includeCover: true } : {}),
    byok,
    tier: doc.settings.quality,
    modelOverride: doc.settings.imageModelOverride,
    // "Render all" holds overfull pages back, as the server's gate does.
    ...(renderAll ? { holdBack: { drawOverfull: anyway } } : {})
  });
  return { quote, renderAll, anyway };
};

/**
 * A paid "draw" chip as it stands NOW: priced at what it would draw now, and sent with that quote — never the price
 * from when the notice was posted (after the open Render all ran, "Draw page 3 anyway (with the rest)" draws page 3
 * alone, at a fraction of the posted price). "(with the rest)" is dropped once nothing else is drawn with it. The
 * server still re-checks: a higher fresh price is gated again. Other chips (and no doc, older hosts) are as posted.
 */
export const liveNoticeChip = (doc: ComicDoc | null | undefined, chip: NoticeChip, byok = false): NoticeChip => {
  if (!doc || !chip.paid || chip.action.type !== 'render_pages') return chip;
  const { quote, anyway } = liveRenderQuote(doc, chip.action, byok);
  if (quote.nothing || !(quote.usd > 0)) return chip;
  const usd = Math.round(quote.usd * 10000) / 10000;
  const alone = anyway.length > 0 && !quote.cover && quote.pageIds.every((id) => anyway.includes(id));
  const label = alone ? chip.fix.label.replace(/\s*\(with the rest\)\s*$/i, '') : chip.fix.label;
  return { ...chip, usd, action: { ...chip.action, quotedUsd: usd }, fix: label === chip.fix.label ? chip.fix : { ...chip.fix, label } };
};

/**
 * A chip's state against the live doc. Pure; no doc ⇒ 'live' (older hosts). `postedAt` (the notice's message time):
 * a paid chip whose page was checked again after the notice was posted is hidden — that newer check, not this old
 * notice, says what the page needs now (a redrawn page checked clean is never offered a paid fix for the old take).
 */
export const noticeChipState = (doc: ComicDoc | null | undefined, chip: NoticeChip, byok = false, postedAt?: number): NoticeChipState => {
  if (!doc) return 'live';
  const action = chip.action;
  if (!chip.paid) {
    if (action.type !== 'patch') return 'live';
    const ops = Array.isArray(action.ops) ? action.ops : [];
    const checks = ops.map((op) => (op && typeof op === 'object' ? opCheck(doc, op) : null));
    if (checks.some((c) => c === null)) return 'hidden';
    if (checks.every((c) => c!.noop)) return 'done';
    // Free must stay free: an edit that would put a drawn, current page out of date (only a paid redraw brings it
    // back in line — e.g. the layout fix after the page was drawn anyway) is not offered.
    const touched = new Set(checks.map((c) => c!.pageId).filter((id): id is string => !!id));
    const current = doc.pages.filter((p) => touched.has(p.id) && p.render.status === 'ready' && !isPageStale(doc, p));
    if (!current.length) return 'live';
    try {
      const after = applyOps(doc, ops);
      return current.some((p) => {
        const next = after.pages.find((x) => x.id === p.id);
        return !!next && isPageStale(after, next);
      })
        ? 'hidden'
        : 'live';
    } catch {
      return 'live';
    }
  }
  const ids = spendPages(action);
  const pages = ids.map((id) => doc.pages.find((p) => p.id === id));
  if (typeof (action as { pageId?: unknown }).pageId === 'string' && !pages[0]) return 'hidden';
  const present = pages.filter((p): p is Page => !!p);
  if (present.some(isBusyPage)) return 'started';
  if (typeof postedAt === 'number' && postedAt > 0 && present.some((p) => (p.render.qc?.checkedAt ?? 0) > postedAt)) return 'hidden';
  if (action.type === 'render_pages') {
    const { quote, renderAll, anyway } = liveRenderQuote(doc, action, byok);
    // "Draw page 2 anyway (with the rest)": once page 2 itself needs no drawing, the chip has nothing left to do.
    if (renderAll && anyway.length && !pageTargets(doc, { pageIds: anyway }).length) return 'hidden';
    if (quote.nothing) return 'hidden';
  }
  return 'live';
};

const STATE_TITLE: Partial<Record<NoticeChipState, string>> = {
  done: 'Done — already in your comic',
  started: 'Started — no need to tap again'
};

const NoticeFixChips: React.FC<{ chips: NoticeChip[]; studio: NoticeCardStudio; cardId: string; postedAt?: number }> = ({ chips, studio, cardId, postedAt }) => {
  const byok = !!(studio.byok || studio.caps?.byok);
  const cost = useCostFormat({ byok, caps: studio.caps ?? null });
  const doc = studio.doc;
  // What each run resolved to (by action object), so a paid chip reads "Started" only when it really went through
  // (not refused, cancelled or turned into an approval card).
  const results = React.useRef(new Map<StudioAction, unknown>());
  const studioAct = studio.act;
  const act = React.useCallback(
    async (action: StudioAction) => {
      const result = await studioAct(action);
      results.current.set(action, result);
      return result;
    },
    [studioAct]
  );
  const { run, isPending } = useAction(act);
  // Paid chips that ran: "Started" until the doc changes (stamped with the doc first seen after the run).
  const [ran, setRan] = React.useState<ReadonlyMap<string, { doc?: ComicDoc | null }>>(() => new Map());
  React.useEffect(() => {
    if (!ran.size) return;
    let changed = false;
    const next = new Map(ran);
    for (const [k, v] of ran) {
      if (!('doc' in v)) {
        next.set(k, { doc });
        changed = true;
      } else if (v.doc !== doc) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) setRan(next);
  }, [ran, doc]);
  const states = React.useMemo(() => chips.map((c) => noticeChipState(doc, c, byok, postedAt)), [chips, doc, byok, postedAt]);
  // Paid draw chips show and send what they would draw now (liveNoticeChip), not the price when posted.
  const live = React.useMemo(() => chips.map((c) => liveNoticeChip(doc, c, byok)), [chips, doc, byok]);
  const shown = live.map((c, i) => ({ c, i, state: states[i] })).filter((x) => x.state !== 'hidden');
  if (!shown.length) return null;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 pl-[1.625rem]" role="group" aria-label="Fixes">
      {shown.map(({ c, i, state: derived }) => {
        const key = `${cardId}:${i}`;
        const busy = isPending(key);
        const state: NoticeChipState = derived === 'live' && c.paid && ran.has(key) ? 'started' : derived;
        const price = c.paid ? noticePrice(cost, c.usd ?? 0, byok) : 'Free';
        const badge = state === 'done' ? 'Done' : state === 'started' ? 'Started' : price;
        return (
          <ChipButton
            key={key}
            className="min-w-0 !text-[12.5px] coarse:!text-[13px]"
            disabled={busy || state !== 'live'}
            aria-busy={busy || undefined}
            data-fix={c.paid ? 'paid' : 'free'}
            data-state={state}
            title={
              STATE_TITLE[state] ??
              (c.paid
                ? 'Estimate — tapping is your OK, and the price is re-checked before anything is drawn'
                : c.action.type === 'patch'
                  ? 'Free — done by the editor, no AI cost'
                  : 'Free — no charge to you')
            }
            onClick={() => {
              void run(key, c.action).then((ok) => {
                if (ok && c.paid && !stopsSequence(results.current.get(c.action))) setRan((prev) => new Map(prev).set(key, {}));
                results.current.delete(c.action);
              });
            }}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
            {state === 'done' && <CircleCheck className={cx('h-3.5 w-3.5 shrink-0', TONE_TEXT.success)} aria-hidden />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{chipLabel(c.fix.label, price)}</span>
            {/* The name a screen reader hears is the visible text: "Use the layout that fits, Free". */}
            <span className="sr-only">,</span>{' '}
            {/* The badge wraps only between words, never inside one; a one-word badge (Free, Done, Started, a dollar
                amount) never wraps at all (ui.tsx ChipBadge, shared with the breakdown's fixes). */}
            <ChipBadge data-fix-badge tone={c.paid ? 'paid' : 'free'}>
              {badge}
            </ChipBadge>
          </ChipButton>
        );
      })}
    </div>
  );
};

/**
 * `studio` is optional so the card still renders where no controller is passed (older hosts): the text shows, and
 * the fix chips — which need the controller to run — appear wherever the host passes it (CardRenderer).
 */
export const NoticeCard: React.FC<{ card: NoticeCardData; studio?: NoticeCardStudio; postedAt?: number }> = ({ card, studio, postedAt }) => {
  const tone = TONES[card.tone] || TONES.info;
  const hasStudio = !!studio;
  const chips = React.useMemo(() => (hasStudio ? noticeChips(card.fixes) : []), [hasStudio, card.fixes]);
  // The live region holds the words only: the chips sit beside it, so a chip turning "Done" is not re-announced.
  return (
    <div className={cx('min-w-0 rounded-xl border px-3.5 py-2.5 text-[13px] leading-snug', tone.cls)}>
      <div role={tone.role} className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{tone.icon}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{typeof card.text === 'string' ? card.text : ''}</span>
      </div>
      {studio && chips.length > 0 && <NoticeFixChips chips={chips} studio={studio} cardId={card.id} postedAt={postedAt} />}
    </div>
  );
};
