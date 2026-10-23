// Acting chips under the director's latest reply (contract §4.7 NextStep; director.md §3.12).
// A chip either RUNS something directly (a studio action — no director call, so no chat cost),
// navigates on the client (open the reader, a tab, undo), or sends text to the director.
// Paid chips carry their price ("Make the cover · ≈$0.07", the click is the confirmation and
// the action's quotedUsd makes a stale chip re-quote instead of overspending); free ones say
// "Free". Old messages keep working: plain `suggestions` strings still send themselves, and
// v4 object suggestions ({ label, action | tab | say }) are upgraded on the fly.

import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { isPageStale, isValidNextStep, type ComicDoc, type Msg, type NextStep, type StudioTab } from '../../../../shared/comic/doc';
import { DOC_LIMITS } from '../../../../shared/comic/limits';
import { SPEND_ACTION_TYPES } from '../../../../shared/comic/ops';
import { formatUsd } from '../../../../shared/comic/models';
import type { ComicStudioController } from '../../useStudio';
import { ChipButton, cx } from '../ui';
import { hasRecap } from './recap';

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

/** Price badge text: "Free" at $0, "≈$0.07" when paid, nothing when unpriced. */
export const priceBadge = (usd: number | undefined): string | undefined => {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return undefined;
  return usd === 0 ? 'Free' : `≈${formatUsd(usd)}`;
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
  return own ?? quoted;
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

/** Text chips go to the director, so they wait while a turn is streaming. */
const sendsText = (c: ChipModel) => c.legacy || (!c.step.action && !c.step.client);

export const NextStepChips: React.FC<{ chips: ChipModel[]; studio: ComicStudioController; className?: string }> = ({ chips, studio, className }) => {
  // Per chip: a long-running action (a render streams until it lands) must not freeze the
  // other chips — "Read it" stays tappable while "Make the cover" draws.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!chips.length) return null;

  const tap = async (chip: ChipModel, key: string) => {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    try {
      if (chip.legacy) await studio.send(chip.step.label);
      else await studio.runNextStep(stepToRun(chip.step));
    } catch (err) {
      console.warn('[comicstudio] next step failed', err);
    } finally {
      pendingRef.current.delete(key);
      if (mounted.current) setPending(new Set(pendingRef.current));
    }
  };

  return (
    <div className={cx('flex flex-wrap gap-2 pt-0.5', className)} role="group" aria-label="Next steps">
      {chips.map((chip, i) => {
        const key = `${chip.step.label}:${i}`;
        const usd = chipUsd(chip.step);
        const badge = priceBadge(usd);
        const busy = pending.has(key);
        // Text chips wait for the director; a second text chip waits for the first one's turn.
        const disabled = busy || (sendsText(chip) && (studio.messageBusy || chips.some((c, j) => sendsText(c) && pending.has(`${c.step.label}:${j}`))));
        return (
          <ChipButton
            key={key}
            onClick={() => void tap(chip, key)}
            disabled={disabled}
            aria-busy={busy || undefined}
            aria-label={badge ? `${chip.step.label}, ${badge === 'Free' ? 'free' : `about ${formatUsd(usd!)}`}` : undefined}
            className="min-w-0"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{chip.step.label}</span>
            {badge && (
              <span
                className={cx(
                  'shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
                  badge === 'Free' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'
                )}
                title={
                  badge === 'Free'
                    ? chip.step.action || chip.step.client
                      ? 'Free — done by the editor, no AI cost'
                      : 'Free'
                    : 'Estimate — tapping is your OK, and the price is re-checked before anything is drawn'
                }
                aria-hidden
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
