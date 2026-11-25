// The `credit` conversation card (docs/features/credit-safety.md): money is why a paid step did not run.
//
//   stopped  a run reached a key with no credit part-way: what was drawn, that the rest was not started and cost
//            nothing, and what to do — Top up (the provider's own page), Switch key (Settings → API keys), and
//            Draw the rest once that is done (priced fresh for exactly what did not start).
//   short    a paid step would not fit what is left: what it needs, what is left, Top up / Switch key, and
//            Draw what fits (the leading pages whose quote fits) where that makes sense.
//
// Who pays decides the words. Own key: real dollars (the person's own provider balance). DreamStream's allowance:
// percentages and plain words only — what is left and what the step needs are stored as shares of the usage, and the
// price of the spend it offers again goes through the viewer's cost format. There is no self-serve top-up for the
// allowance, so "Ask for a top-up" writes to support. Ink on paper throughout: no colour on or beside a price or a
// control that spends.

import React from 'react';
import { ExternalLink, KeyRound, Mail, Wallet } from 'lucide-react';
import { creditProviderName, creditShareWords, type CreditCard as CreditCardData, type CreditKey } from '../../../shared/comic/credit';
import { formatUsd } from '../../../shared/comic/models';
import { getProviderDef } from '../../../shared/providers';
import { readingAge } from '../../../services/keyBalance';
import { SUPPORT_EMAIL } from '../../legal/contacts';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, HAIRLINE, INK, MUTED, RADIUS_CONTROL, TRANSITION } from '../../chat/studioDesign';
import type { CardProps } from '../extensions';
import { useCostFormat } from '../conversation/cost';
import { useAction } from '../conversation/cards/useAction';
import { CardShell, GhostButton } from '../conversation/ui';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every own key the card is about, in order (one, or both when the run moved to the other key and that one ran out too). */
const keysOf = (card: CreditCardData): CreditKey[] =>
  card.keys?.length ? card.keys : [{ provider: card.provider ?? 'openrouter', ...(card.noQuota ? { noQuota: true } : {}) }];

/** "Your OpenRouter key ran out of credit" · "Your OpenRouter and Gemini keys ran out of credit" · mixed reasons. */
const stoppedTitle = (keys: CreditKey[]): string => {
  const names = keys.map((k) => creditProviderName(k.provider));
  if (keys.length === 1) return keys[0].noQuota ? `Your ${names[0]} key has no image quota` : `Your ${names[0]} key ran out of credit`;
  if (keys.every((k) => k.noQuota)) return `Your ${names.join(' and ')} keys have no image quota`;
  if (keys.every((k) => !k.noQuota)) return `Your ${names.join(' and ')} keys ran out of credit`;
  return 'Neither of your keys can draw right now';
};

/** The mailto behind a governed person's "Ask for a top-up" (support reads it; no account detail is prefilled). */
export const TOP_UP_REQUEST_HREF = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Comic Studio: more usage, please')}`;

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
  const provider = creditProviderName(card.provider);
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
    const keys = keysOf(card);
    if (keys.length > 1) {
      // Both of the person's keys were refused: say what each one needs.
      const why = keys
        .map((k) => `your ${creditProviderName(k.provider)} key ${k.noQuota ? 'has no image quota (its Google project has no billing)' : 'ran out of credit'}`)
        .join(' and ');
      const fixes = keys.map((k) => (k.noQuota ? 'turn on billing for that Google project' : `top up ${creditProviderName(k.provider)}`)).join(' or ');
      return {
        title: stoppedTitle(keys),
        body: `I stopped before the rest of this run: ${why}. ${counts} ${fixes.charAt(0).toUpperCase()}${fixes.slice(1)}, or switch key in Settings, then draw the rest.`
          .replace(/\s+/g, ' ')
          .trim(),
        keyLabel
      };
    }
    const todo = card.noQuota
      ? `Turn on billing for that key’s Google project, or switch key in Settings, then draw the rest.`
      : `Top up ${provider} (or raise the key’s spending limit), or switch key in Settings, then draw the rest.`;
    return {
      title: stoppedTitle(keys),
      body: `I stopped before the rest of this run. ${counts} ${todo}`.replace(/\s+/g, ' ').trim(),
      keyLabel
    };
  }
  // "It needs ≈ $0.21 for pages 1–3": reads right for one picture or many ("the cover", "an edit of page 2").
  const forWhat = card.what ? ` for ${card.what}` : '';
  // The figure left already sets aside what this comic is drawing right now.
  const after = card.held ? ' after what’s drawing now' : '';
  if (own) {
    const need = typeof card.needUsd === 'number' ? `≈ ${formatUsd(card.needUsd)}` : 'more than is left';
    const left = typeof card.leftUsd === 'number' ? formatUsd(card.leftUsd) : 'too little';
    return {
      title: 'Not enough credit',
      body: `It needs ${need}${forWhat}, and your ${provider} key has ${left} left${after}. Nothing was started or charged.`,
      ...(typeof card.checkedAt === 'number' ? { detail: `${provider} reported the balance ${readingAge(card.checkedAt, now)}.` } : {}),
      keyLabel
    };
  }
  const need = typeof card.needPct === 'number' ? `about ${creditShareWords(card.needPct)} of your usage` : 'more of your usage than is left';
  const leftPct = card.leftPct ?? 0;
  const left = leftPct > 0 ? `${creditShareWords(leftPct)} is left${after}` : `none is left${after}`;
  return {
    title: 'Not enough credit',
    body: `It needs ${need}${forWhat}, and ${left}. Nothing was started. Ask for a top-up, or use your own key.`,
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
  // Own key: one Top up per key that ran out of credit (a key with no image quota needs billing turned on, which its
  // provider page also is); named when there are two. The allowance has no self-serve top-up: ask support.
  const keys = own ? keysOf(card) : [];
  const fundLinks = keys
    .map((k) => ({ provider: k.provider, href: getProviderDef(k.provider)?.fundsUrl ?? null }))
    .filter((k): k is { provider: CreditKey['provider']; href: string } => !!k.href);
  const offer = card.reason === 'short' ? card.fits : card.rest;
  const offerLabel = card.reason === 'short' && card.fits ? `Draw what fits · ${plural(card.fits.pages, 'page')}` : 'Draw the rest';
  return (
    <CardShell title={words.title} icon={<Wallet className="h-4 w-4" aria-hidden />} aria-label={words.title} className="min-w-0">
      <div className="min-w-0 space-y-3" data-card="credit">
        <p className="text-[13.5px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">{words.body}</p>
        {words.detail && <p className={cn('text-[11.5px] [overflow-wrap:anywhere]', MUTED)}>{words.detail}</p>}
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Ways to continue">
          {fundLinks.map((link) => (
            <a key={link.provider} href={link.href} target="_blank" rel="noreferrer" className={LINK_BUTTON}>
              {fundLinks.length > 1 ? `Top up ${creditProviderName(link.provider)}` : 'Top up'}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">(opens {link.provider === 'gemini' ? 'Google AI Studio' : 'OpenRouter'} in a new tab)</span>
            </a>
          ))}
          {!own && card.reason === 'short' && (
            <a href={TOP_UP_REQUEST_HREF} className={LINK_BUTTON}>
              <Mail className="h-3.5 w-3.5" aria-hidden />
              Ask for a top-up
              <span className="sr-only">(writes to {SUPPORT_EMAIL})</span>
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
