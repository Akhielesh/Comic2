// The `credit` conversation card (docs/features/credit-safety.md): money is why a paid step did not run.
//
//   stopped  a run reached a key with no credit part-way: what was drawn, that the rest was not started and cost
//            nothing, and what to do — Top up (the provider's own page), Switch key (Settings → API keys), and
//            Draw the rest once that is done (priced fresh for exactly what did not start).
//   short    a paid step would not fit what is left: what it needs, what is left, Top up / Switch key, and
//            Draw what fits (the leading pages whose quote fits) where that makes sense.
//
// Who pays decides the words. Own key: real dollars (the person's own provider balance). DreamStream's allowance:
// percentages and plain words only — the card stores no dollar figure for it, and its prices go through the viewer's
// cost format. Ink on paper throughout: no colour on or beside a price or a control that spends.

import React from 'react';
import { ExternalLink, KeyRound, Wallet } from 'lucide-react';
import type { CreditCard as CreditCardData } from '../../../shared/comic/credit';
import { formatUsd } from '../../../shared/comic/models';
import { getProviderDef } from '../../../shared/providers';
import { readingAge } from '../../../services/keyBalance';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, HAIRLINE, INK, MUTED, RADIUS_CONTROL, TRANSITION } from '../../chat/studioDesign';
import type { CardProps } from '../extensions';
import { useCostFormat } from '../conversation/cost';
import { useAction } from '../conversation/cards/useAction';
import { CardShell, GhostButton } from '../conversation/ui';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12%", "0.4%", "almost none" — a share of the usage, never a dollar figure. */
export const shareWords = (pct: number): string => {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  if (p <= 0) return 'none';
  if (p < 0.1) return 'almost none';
  return p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(p)}%`;
};

export interface CreditWords {
  title: string;
  body: string;
  /** A quieter line: when the provider reported the balance. */
  detail?: string;
  /** "Switch key" (own key) · "Use my own key" (the allowance). */
  keyLabel: string;
}

/** The card's words (pure). Own-key amounts are dollars; the allowance is only ever a share of the usage. */
export function creditWords(card: CreditCardData, now: number = Date.now()): CreditWords {
  const provider = card.provider === 'gemini' ? 'Gemini' : 'OpenRouter';
  const own = card.payer === 'own_key';
  const keyLabel = own ? 'Switch key' : 'Use my own key';
  if (card.reason === 'stopped') {
    const drawn = card.drawn ?? 0;
    const rest = card.notStarted ?? 0;
    const counts = [
      drawn ? `${plural(drawn, 'picture')} ${drawn === 1 ? 'was' : 'were'} drawn first.` : '',
      rest ? `${plural(rest, 'picture')} ${rest === 1 ? 'wasn’t' : 'weren’t'} started and cost nothing.` : ''
    ]
      .filter(Boolean)
      .join(' ');
    if (!own) {
      return {
        title: 'Drawing paused',
        body: `DreamStream’s drawing service ran out of capacity, so I stopped before the rest of this run. ${counts} Nothing more was used from your usage. Try again later, or use your own key.`.replace(/\s+/g, ' ').trim(),
        keyLabel
      };
    }
    const todo = card.noQuota
      ? `Turn on billing for that key’s Google project, or switch key in Settings, then draw the rest.`
      : `Top up ${provider} (or raise the key’s spending limit), or switch key in Settings, then draw the rest.`;
    return {
      title: card.noQuota ? `Your ${provider} key has no image quota` : `Your ${provider} key ran out of credit`,
      body: `I stopped before the rest of this run. ${counts} ${todo}`.replace(/\s+/g, ' ').trim(),
      keyLabel
    };
  }
  // "It needs ≈ $0.21 for pages 1–3": reads right for one picture or many ("the cover", "an edit of page 2").
  const forWhat = card.what ? ` for ${card.what}` : '';
  if (own) {
    const need = typeof card.needUsd === 'number' ? `≈ ${formatUsd(card.needUsd)}` : 'more than is left';
    const left = typeof card.leftUsd === 'number' ? formatUsd(card.leftUsd) : 'too little';
    return {
      title: 'Not enough credit',
      body: `It needs ${need}${forWhat}, and your ${provider} key has ${left} left. Nothing was started or charged.`,
      ...(typeof card.checkedAt === 'number' ? { detail: `${provider} reported the balance ${readingAge(card.checkedAt, now)}.` } : {}),
      keyLabel
    };
  }
  const need = typeof card.needPct === 'number' ? `about ${shareWords(card.needPct)} of your usage` : 'more of your usage than is left';
  const leftPct = card.leftPct ?? 0;
  const left = leftPct > 0 ? `${shareWords(leftPct)} is left` : 'none is left';
  return {
    title: 'Not enough credit',
    body: `It needs ${need}${forWhat}, and ${left}. Nothing was started. Ask us for a top-up, or use your own key.`,
    keyLabel
  };
}

const LINK_BUTTON = cn(
  'inline-flex h-8 items-center justify-center gap-1.5 bg-[var(--ds-surface-soft)] px-3 text-[12px] font-medium hover:bg-[var(--ds-hover)] coarse:h-11 coarse:px-3.5',
  HAIRLINE,
  RADIUS_CONTROL,
  INK,
  TRANSITION,
  FOCUS_RING
);

export const CreditCardView: React.FC<CardProps<CreditCardData>> = ({ card, studio }) => {
  const own = card?.payer === 'own_key';
  // Own-key amounts are the person's own money: dollars. The allowance's prices follow the viewer (governed: usage words).
  const viewerCost = useCostFormat(studio);
  const ownCost = useCostFormat({ byok: true });
  const { run, isPending } = useAction(studio.act);
  if (!card || card.type !== 'credit') return null;
  const cost = own ? ownCost : viewerCost;
  const words = creditWords(card);
  const funds = own ? getProviderDef(card.provider ?? 'openrouter')?.fundsUrl : null;
  const offer = card.reason === 'short' ? card.fits : card.rest;
  const offerLabel = card.reason === 'short' && card.fits ? `Draw what fits · ${plural(card.fits.pages, 'page')}` : 'Draw the rest';
  return (
    <CardShell title={words.title} icon={<Wallet className="h-4 w-4" aria-hidden />} aria-label={words.title} className="min-w-0">
      <div className="min-w-0 space-y-3" data-card="credit">
        <p className="text-[13.5px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">{words.body}</p>
        {words.detail && <p className={cn('text-[11.5px] [overflow-wrap:anywhere]', MUTED)}>{words.detail}</p>}
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Ways to continue">
          {funds && (
            <a href={funds} target="_blank" rel="noreferrer" className={LINK_BUTTON}>
              Top up
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">(opens {card.provider === 'gemini' ? 'Google AI Studio' : 'OpenRouter'} in a new tab)</span>
            </a>
          )}
          <GhostButton size="sm" onClick={() => studio.runClientAction({ type: 'open_settings', section: 'keys' })}>
            <KeyRound className="h-3.5 w-3.5" aria-hidden /> {words.keyLabel}
          </GhostButton>
          {offer && (
            <GhostButton size="sm" busy={isPending('offer')} keepFocusWhileBusy onClick={() => void run('offer', offer.action)}>
              {offerLabel} · <span className="tabular-nums">{cost.approx(offer.usd)}</span>
            </GhostButton>
          )}
        </div>
      </div>
    </CardShell>
  );
};

export default CreditCardView;
