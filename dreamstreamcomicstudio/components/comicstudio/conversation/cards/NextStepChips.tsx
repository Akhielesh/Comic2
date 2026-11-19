// Acting chips under the director's latest reply (contract §4.7 NextStep; director.md §3.12).
// A chip either RUNS something directly (a studio action — no director call, so no chat cost),
// navigates on the client (open the reader, a tab, undo), or sends text to the director.
// Paid chips carry their price ("Make the cover · ≈$0.07", the click is the confirmation and
// the action's quotedUsd makes a stale chip re-quote instead of overspending); free ones say
// "Free". Governed users see the price as a share of their usage ("≈2% of your usage") —
// never dollars (conversation/cost.ts). Old messages keep working: plain `suggestions` strings
// still send themselves, and v4 object suggestions ({ label, action | tab | say }) are upgraded
// on the fly. The chip's accessible name is its visible text (label + price), so voice-control
// users can say what they see.
//
// Live queue (agent-editor plan §3 A1; only while the controller carries `queue`): while a run holds the turn with
// nothing sent (plan_pages), a text chip tapped goes to Up next (send() queues it) instead of doing nothing; a chip that
// runs an action waits until the turn is free, so nothing spends behind the director's back; client chips (open the
// reader, a tab, undo) never reach the server and stay live.
//
// Q-SETTLE (the options vanish once the creator has answered): the chips are live only while their reply is the newest
// ask and nothing was sent (ConversationPane). A tap on a chip that does something (sends words or runs an action)
// collapses the row at once to one line, "You chose: Make the cover", while it runs; the message it posts then takes the
// row away for good. A refused tap brings the chips back. A text chip already waiting in Up next keeps the row collapsed,
// and a free edit chip whose edit is already in the comic is not offered again (both read live state, so a reload
// agrees). Navigation chips (Read it, See the pages) never collapse the row: they answer nothing.

import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { isPageStale, isValidNextStep, type ComicDoc, type Msg, type NextStep, type StudioTab } from '../../../../shared/comic/doc';
import { DOC_LIMITS } from '../../../../shared/comic/limits';
import { SPEND_ACTION_TYPES, type DocOp } from '../../../../shared/comic/ops';
import type { ComicStudioController } from '../../useStudio';
import { DOLLAR_CONTEXT } from '../../../../services/costDisplay';
import { costFormat, useCostFormat, type CostFormat } from '../cost';
import { MUTED, TONE_CHIP } from '../../../chat/studioDesign';
import { ChipButton, cx } from '../ui';
import { hasRecap } from './recap';
import { patchStateOf } from './patchState';

/** A chip as rendered: a structured step, or a legacy string that is simply sent. */
export interface ChipModel {
  step: NextStep;
  /** Legacy `suggestions` string: tapping sends the label as the user's message. */
  legacy?: boolean;
}

const TABS: ReadonlySet<string> = new Set<StudioTab>(['story', 'cast', 'style', 'pages', 'media', 'languages', 'read']);

/** v4 `SuggestionChip` objects ({ label, action?, tab?, say? }) → NextStep. */
const upgradeLegacyObject = (s: unknown): NextStep | null => {
  if (!s || typeof s !== 'object') return null;
  const o = s as { label?: unknown; action?: unknown; tab?: unknown; say?: unknown; usd?: unknown };
  if (typeof o.label !== 'string' || !o.label.trim()) return null;
  const usd = typeof o.usd === 'number' && Number.isFinite(o.usd) && o.usd >= 0 ? { usd: o.usd } : {};
  if (o.action && typeof o.action === 'object' && typeof (o.action as { type?: unknown }).type === 'string') {
    const a = o.action as { type: string; pageId?: unknown };
    // open_reader / open_page used to ride in `action`; they are client actions now.
    if (a.type === 'open_reader') return { label: o.label, client: { type: 'open_reader' }, usd: 0 };
    if (a.type === 'open_page' && typeof a.pageId === 'string') return { label: o.label, client: { type: 'open_page', pageId: a.pageId }, usd: 0 };
    return { label: o.label, action: o.action as NextStep['action'], ...usd };
  }
  if (typeof o.tab === 'string' && TABS.has(o.tab)) return { label: o.label, client: { type: 'open_tab', tab: o.tab as StudioTab }, usd: 0 };
  return { label: o.label, ...(typeof o.say === 'string' && o.say.trim() ? { say: o.say } : {}), ...usd };
};

/** Free, client-only next steps for a reply that carries none (never leave the user without a move). */
export const fallbackNextSteps = (doc: ComicDoc | null): NextStep[] => {
  if (!doc || (doc.gate && doc.gate.status === 'open')) return [];
  const pages = doc.pages;
  if (!pages.length) return hasRecap(doc) ? [{ label: 'Plan the pages', say: 'Plan the pages' }] : [];
  const drawable = pages.filter((p) => p.panels.length > 0);
  const allDrawn = drawable.length > 0 && drawable.every((p) => p.render.status === 'ready' && !isPageStale(doc, p));
  if (allDrawn) return [{ label: 'Read it', client: { type: 'open_reader' }, usd: 0 }];
  return [{ label: 'See the pages', client: { type: 'open_tab', tab: 'pages' }, usd: 0 }];
};

/** The chips a message offers: nextSteps → legacy suggestions → free fallbacks. */
export const chipsFor = (msg: Msg, doc: ComicDoc | null, opts: { fallback?: boolean } = {}): ChipModel[] => {
  const steps = Array.isArray(msg.nextSteps) ? msg.nextSteps.filter(isValidNextStep).slice(0, DOC_LIMITS.nextSteps) : [];
  if (steps.length) return steps.map((step) => ({ step }));
  const legacy = Array.isArray(msg.suggestions) ? (msg.suggestions as unknown[]) : [];
  const fromLegacy: ChipModel[] = [];
  for (const s of legacy) {
    if (typeof s === 'string') {
      if (s.trim() && !fromLegacy.some((c) => c.step.label === s)) fromLegacy.push({ step: { label: s }, legacy: true });
    } else {
      const step = upgradeLegacyObject(s);
      if (step) fromLegacy.push({ step });
    }
    if (fromLegacy.length >= 4) break;
  }
  if (fromLegacy.length) return fromLegacy;
  return opts.fallback ? fallbackNextSteps(doc).map((step) => ({ step })) : [];
};

const DOLLARS = costFormat(DOLLAR_CONTEXT);

/**
 * Price badge text: "Free" at $0, "≈$0.07" when paid (or "≈2% of your usage" for a governed
 * user), nothing when unpriced.
 */
export const priceBadge = (usd: number | undefined, cost: CostFormat = DOLLARS): string | undefined => {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return undefined;
  return usd === 0 ? 'Free' : cost.badge(usd);
};

const priceOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The chip runs a paid action (the server bills it without another gate: the tap is the OK). */
export const isSpendStep = (step: NextStep): boolean => !!step.action && SPEND_ACTION_TYPES.has(step.action.type);

/**
 * The chip's price: its own `usd`, else the quote its spend action carries. A paid action is
 * never shown cheaper than the quote it will be billed against (a "Free" badge on a $0.14
 * action would be a lie), so for spend actions the higher of the two wins.
 */
export const chipUsd = (step: NextStep): number | undefined => {
  const own = priceOf(step.usd);
  const quoted = isSpendStep(step) ? priceOf((step.action as { quotedUsd?: unknown }).quotedUsd) : undefined;
  if (own !== undefined && quoted !== undefined) return Math.max(own, quoted);
  // Client steps (open the reader, a tab, undo…) never reach the server: free by construction,
  // so "Read it" is badged the same whether or not the server priced it.
  if (own === undefined && quoted === undefined && step.client && !step.action) return 0;
  return own ?? quoted;
};

/** A price as servers write it at the end of a label: Free, ≈$0.14, ≈2% of your usage, <0.1% of your usage. */
const PRICE = String.raw`(?:free|[≈<]\s*\$[\d.,]+|[≈<]\s*[\d.,]+%\s*of\s+your\s+usage)`;
const PRICE_SUFFIX = new RegExp(String.raw`(?:\s*\(${PRICE}\)|\s+[·•–—-]\s*${PRICE})\s*$`, 'i');

/**
 * The label as shown next to its badge: a server label that already spells out the price
 * ("Fit to 4:5 (Free)", "Draw 2 pages · ≈$0.14", "Draw 2 pages · ≈2% of your usage") loses that
 * suffix, so the price reads once — and a governed user never sees a dollar suffix.
 */
export const chipLabel = (label: string, badge: string | undefined): string => {
  if (!badge) return label;
  const trimmed = label.replace(PRICE_SUFFIX, '').trim();
  return trimmed || label;
};

/**
 * The step as it is run. A spend action always carries the quote the user saw: an unpriced one
 * gets quotedUsd 0, so anything that costs money comes back as a priced approval card instead of
 * being billed on a tap that showed no price (the server re-gates a quote it would exceed).
 */
export const stepToRun = (step: NextStep): NextStep => {
  if (!isSpendStep(step) || priceOf((step.action as { quotedUsd?: unknown }).quotedUsd) !== undefined) return step;
  return { ...step, action: { ...step.action!, quotedUsd: priceOf(step.usd) ?? 0 } as NextStep['action'] };
};

/** Actions the editor does in software (no model call at all) — the ones that earn "no AI cost". */
const SOFTWARE_ACTIONS: ReadonlySet<string> = new Set([
  'patch', 'fit_render', 'restore_render', 'show_breakdown', 'approve_plan', 'pick_style', 'cancel', 'decline_gate', 'ref_crop'
]);

/** The trust line on a "Free" badge: only work done purely in software claims "no AI cost". */
export const freeTitle = (step: NextStep): string => {
  if (step.client && !step.action) return 'Free — done by the editor, no AI cost';
  const a = step.action as { type?: string; useVision?: boolean } | undefined;
  if (a?.type && (SOFTWARE_ACTIONS.has(a.type) || (a.type === 'relayout_balloons' && !a.useVision))) return 'Free — done by the editor, no AI cost';
  return 'Free — no charge to you';
};

/** Text chips go to the director, so they wait while a turn is streaming (or queue, with the live queue on). */
export const sendsText = (c: ChipModel) => c.legacy || (!c.step.action && !c.step.client);

/** The words a text chip sends (runNextStep: its `say`, else its label). */
export const chipText = (c: ChipModel): string => ((!c.legacy && typeof c.step.say === 'string' && c.step.say.trim() ? c.step.say : c.step.label) || '').trim();

/** A chip that answers the reply (sends words or runs an action); navigation chips (Read it, a tab) answer nothing. */
export const answersReply = (c: ChipModel): boolean => sendsText(c) || !!c.step.action;

const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/** A free edit chip whose edit is already in the comic (or whose page is gone): not offered (read from the live doc). */
export const chipAlreadyDone = (c: ChipModel, doc: ComicDoc | null | undefined): boolean =>
  !!doc && c.step.action?.type === 'patch' && patchStateOf(doc, (c.step.action as { ops?: DocOp[] }).ops) !== 'live';

/**
 * Whether a chip is unavailable right now. Without the live queue a text chip waits for the director (and for a text
 * chip already on its way). With it, a text chip queues instead and only an action chip waits for the turn lock.
 */
export const chipDisabled = (chip: ChipModel, opts: { pending: boolean; textPending: boolean; messageBusy: boolean; queueMode: boolean; turnLocked: boolean }): boolean => {
  if (opts.pending) return true;
  if (opts.queueMode) return !!chip.step.action && !chip.legacy && opts.turnLocked;
  return sendsText(chip) && (opts.messageBusy || opts.textPending);
};

export const NextStepChips: React.FC<{ chips: ChipModel[]; studio: ComicStudioController; className?: string }> = ({ chips: offered, studio, className }) => {
  // Per chip: a long-running action (a render streams until it lands) must not freeze the
  // other chips — "Read it" stays tappable while "Make the cover" draws.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // Q-SETTLE: the chip the creator tapped, while it runs (the row reads one line until its message takes the row away).
  const [chosen, setChosen] = useState<string | null>(null);
  const cost = useCostFormat(studio);
  const pendingRef = useRef(new Set<string>());
  const mounted = useRef(true);
  const queueMode = Array.isArray(studio.queue);
  const turnLocked = queueMode ? (studio.turnLocked ?? studio.messageBusy) : studio.messageBusy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A free edit already in the comic is not offered again (derived from the live doc, so a reload agrees).
  const chips = offered.filter((c) => !chipAlreadyDone(c, studio.doc));
  if (!chips.length) return null;
  const keyOf = (chip: ChipModel, i: number) => `${chip.step.label}:${i}`;
  // A text chip already waiting in Up next answered this reply too (the queue is the controller's, kept per project).
  const queuedTexts = queueMode ? (studio.queue || []).map((n) => (typeof n?.text === 'string' ? n.text : '')).filter(Boolean) : [];
  const queuedIndex = chips.findIndex((c) => sendsText(c) && queuedTexts.some((t) => sameWords(t, chipText(c))));
  const chosenIndex = chosen !== null ? chips.findIndex((c, i) => keyOf(c, i) === chosen) : -1;
  const settledIndex = chosenIndex >= 0 ? chosenIndex : queuedIndex;
  if (settledIndex >= 0) {
    const chip = chips[settledIndex];
    const running = chosenIndex >= 0 && pending.has(chosen!);
    const label = chipLabel(chip.step.label, priceBadge(chipUsd(chip.step), cost));
    return (
      <div
        className={cx('flex min-h-7 min-w-0 items-center gap-2 pt-0.5 coarse:min-h-11', className)}
        role="group"
        aria-label="Next steps"
        aria-busy={running || undefined}
        data-chips-settled=""
      >
        <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
          {running ? <Loader2 className={cx('size-3.5 animate-spin motion-reduce:animate-none', MUTED)} /> : <Check className={cx('size-3.5', MUTED)} strokeWidth={2.5} />}
        </span>
        <span className="min-w-0 text-[13px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          You chose: <span className="text-[var(--ds-ink)]">{label}</span>
          {chosenIndex < 0 ? ' · Up next' : ''}
        </span>
      </div>
    );
  }

  const tap = async (chip: ChipModel, key: string) => {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    // Answering the reply collapses the row at once; navigating does not.
    if (answersReply(chip)) setChosen(key);
    try {
      if (chip.legacy) await studio.send(chip.step.label);
      else await studio.runNextStep(stepToRun(chip.step));
    } catch (err) {
      console.warn('[comicstudio] next step failed', err);
    } finally {
      pendingRef.current.delete(key);
      if (mounted.current) {
        setPending(new Set(pendingRef.current));
        // Done: the message it posted has already taken this row away (only the newest reply shows chips). Still here
        // means nothing was posted (refused, or a free edit, which is then not offered again): the chips come back.
        setChosen((cur) => (cur === key ? null : cur));
      }
    }
  };

  return (
    <div className={cx('flex flex-wrap gap-2 pt-0.5', className)} role="group" aria-label="Next steps">
      {chips.map((chip, i) => {
        const key = keyOf(chip, i);
        const usd = chipUsd(chip.step);
        const badge = priceBadge(usd, cost);
        const label = chipLabel(chip.step.label, badge);
        const busy = pending.has(key);
        // Text chips wait for the director (or queue into Up next); a second text chip waits for the first one's turn.
        const disabled = chipDisabled(chip, {
          pending: busy,
          textPending: chips.some((c, j) => sendsText(c) && pending.has(keyOf(c, j))),
          messageBusy: studio.messageBusy,
          queueMode,
          turnLocked
        });
        const queuesNow = queueMode && turnLocked && sendsText(chip);
        return (
          <ChipButton
            key={key}
            onClick={() => void tap(chip, key)}
            disabled={disabled}
            aria-busy={busy || undefined}
            title={queuesNow ? 'Adds to Up next. The director reads it when it finishes this step' : disabled && queueMode && turnLocked ? 'Available once the director finishes this step' : undefined}
            className="min-w-0"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
            {/* The name a screen reader announces is the visible text: "Make the cover, ≈2% of your usage". */}
            {badge && <span className="sr-only">,</span>}
            {badge && ' '}
            {badge && (
              <span
                className={cx(
                  'shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
                  badge === 'Free' ? TONE_CHIP.success : 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'
                )}
                title={
                  badge === 'Free'
                    ? freeTitle(chip.step)
                    : isSpendStep(chip.step)
                      ? 'Estimate — tapping is your OK, and the price is re-checked before anything is drawn'
                      : 'Estimate — I’ll confirm the price with you before anything is drawn'
                }
              >
                {badge}
              </span>
            )}
          </ChipButton>
        );
      })}
    </div>
  );
};
