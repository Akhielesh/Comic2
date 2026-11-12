// A settled card (PROGRAM3 SETTLE-UI; settle.md §5.3; lead decision D3, CHANGED): what an old chat card turns into
// once the conversation has moved past it. The owner: users "should not be able to view/edit those options once the
// chat has moved forward". So the row has NO controls and NO "Show details": one line of words from
// shared/comic/settle.ts summaryOf ("You picked Noir ink", "Not answered — you moved on", "Approved · ≈2% of your
// usage · 6 images"), and for a renders or picture card one plain navigation link to where the pictures live (the
// board, a page, the cast, the style or Assets). It mounts no image, makes no fetch and starts no spend.
//
// The row: 28 px (44 px on coarse pointers), no CardShell frame, sitting at the card's place in the column; a 14 px
// leading mark — a ✓ in TONE_TEXT.success for picked, approved or published, a dot for skipped, declined or closed,
// the card's own icon otherwise; --ds-ink words, --ds-muted for the quiet ones; a notice's words clamp to 2 lines.
// aria-live="off", so collapsing old cards when the creator sends is not announced by the conversation log; the
// summary takes focus (tabIndex −1, no scroll, a focus-visible ring for keyboard users) when the card held focus as it
// settled, so a screen reader hears "You picked Noir ink" instead of losing focus to the page.

import React, { useLayoutEffect, useRef } from 'react';
import {
  Check,
  ClipboardCheck,
  CloudOff,
  Coins,
  GitCompareArrows,
  Globe,
  History,
  ImagePlus,
  Images,
  Info,
  Languages,
  Layers,
  LayoutList,
  Link2,
  MessageCircleQuestion,
  Palette,
  Users,
  type LucideIcon
} from 'lucide-react';
import type { Card, ClientAction, ComicDoc } from '../../../../shared/comic/doc';
import { summaryOf, type CardSettle, type SettleCost, type SettledLink, type SettledSummary } from '../../../../shared/comic/settle';
import type { CardRegistration } from '../../extensions';
import type { ComicStudioController } from '../../useStudio';
import { cn } from '../../../../lib/utils';
import { FOCUS_RING, MUTED, TONE_TEXT } from '../../../chat/studioDesign';
import { useCostFormat } from '../cost';

/** Each card's own mark when its line is neither done nor quiet. */
const CARD_ICON: Partial<Record<Card['type'], LucideIcon>> = {
  options: MessageCircleQuestion,
  conflict: GitCompareArrows,
  gate: Coins,
  plan: LayoutList,
  breakdown: LayoutList,
  style_choice: Palette,
  style_presets: Palette,
  cast: Users,
  recap: ClipboardCheck,
  renders: Images,
  versions: Layers,
  refs: ImagePlus,
  translation: Languages,
  publish: Globe,
  share: Link2,
  model_outage: CloudOff,
  history: History,
  notice: Info
};

/**
 * The line a settled card reads: shared/comic/settle.ts summaryOf, with a feature card's own words when its
 * registration gives them (CardRegistration.settledSummary; null keeps summaryOf's). null while the card is open or
 * live. Words only: prices go through `cost`, so governed users never see `$` or `¢`.
 */
export const settledSummaryFor = (
  card: Card,
  doc: ComicDoc | null | undefined,
  settle: CardSettle,
  cost: SettleCost | null,
  own?: CardRegistration['settledSummary']
): SettledSummary | null => {
  if (!doc) return settle?.state === 'settled' ? { text: 'Earlier card', tone: 'quiet' } : null;
  const line = summaryOf(card, doc, settle, cost);
  if (!line || line.folded || !own) return line;
  let text: string | null = null;
  try {
    text = own(card, doc, settle, cost);
  } catch {
    text = null;
  }
  return typeof text === 'string' && text.trim() ? { ...line, text: text.trim() } : line;
};

/** A fragment for the link (the click is handled in place, so the hash never changes; it only names the place). */
const hrefOf = (client: ClientAction): string =>
  client.type === 'open_page' ? `#page-${encodeURIComponent(client.pageId)}` : client.type === 'open_tab' ? `#${client.tab}` : '#';

export interface SettledCardProps {
  card: Card;
  summary: SettledSummary;
  /** Opens the link's place (the controller's runClientAction): navigation only, it changes nothing. */
  onLink?: (client: ClientAction) => void;
  /** The card held focus as it settled: the summary takes it (tabIndex −1, preventScroll). */
  takeFocus?: boolean;
}

/** One settled row (D3): the mark, the words, and at most one plain link. Never a button, input or toggle. */
export const SettledCard: React.FC<SettledCardProps> = ({ card, summary, onLink, takeFocus }) => {
  const textRef = useRef<HTMLSpanElement>(null);
  // Focus that was inside the live card fell to the page when its control unmounted: hand it to the words.
  useLayoutEffect(() => {
    if (!takeFocus || typeof document === 'undefined') return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    textRef.current?.focus({ preventScroll: true });
    // Once per settle: a later re-render never steals focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (summary.folded || !summary.text) return null;
  const quiet = summary.tone === 'quiet';
  const Icon = CARD_ICON[card.type] ?? Info;
  const link: SettledLink | undefined = summary.link && onLink ? summary.link : undefined;
  return (
    <div
      data-settled={card.type}
      data-settle-tone={summary.tone}
      aria-live="off"
      className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 coarse:min-h-11"
    >
      <span aria-hidden className="grid size-3.5 shrink-0 place-items-center self-center" data-settle-mark={summary.tone}>
        {summary.tone === 'done' ? (
          <Check className={cn('size-3.5', TONE_TEXT.success)} strokeWidth={2.5} />
        ) : quiet ? (
          <span className="size-1.5 rounded-full bg-[var(--ds-muted)]" />
        ) : (
          <Icon className={cn('size-3.5', MUTED)} />
        )}
      </span>
      <span
        ref={textRef}
        tabIndex={-1}
        className={cn(
          // Focus handed here after a keyboard pick shows (FOCUS_RING is :focus-visible only, so a tap never rings it).
          'min-w-0 flex-[1_1_12rem] text-[13px] leading-snug [overflow-wrap:anywhere] focus:outline-none focus-visible:rounded-sm',
          FOCUS_RING,
          quiet ? 'text-[var(--ds-muted)]' : 'text-[var(--ds-ink)]',
          // A notice keeps to 2 lines (settle.md §5.2), so an old error stays a compact log line; the words stay whole
          // for screen readers.
          card.type === 'notice' && 'line-clamp-2'
        )}
      >
        {summary.text}
      </span>
      {link && (
        <a
          href={hrefOf(link.client)}
          onClick={(e) => {
            e.preventDefault();
            onLink?.(link.client);
          }}
          className={cn(
            'inline-flex shrink-0 items-center rounded-sm text-[12.5px] font-medium text-[var(--ds-muted)] underline decoration-[color:var(--ds-hairline)] underline-offset-2 transition-colors duration-[var(--ds-motion-fast)] hover:text-[var(--ds-ink)] hover:decoration-current motion-reduce:transition-none coarse:min-h-11 coarse:px-1',
            FOCUS_RING
          )}
        >
          {link.label}
        </a>
      )}
    </div>
  );
};

type SettledStudio = Pick<ComicStudioController, 'doc' | 'runClientAction' | 'byok' | 'caps'>;

/** A settled card from the live controller: the viewer's cost words, its summary, its link to the studio. */
export const SettledCardView: React.FC<{
  card: Card;
  settle: CardSettle;
  studio: SettledStudio;
  own?: CardRegistration['settledSummary'];
  takeFocus?: boolean;
}> = ({ card, settle, studio, own, takeFocus }) => {
  const cost = useCostFormat(studio);
  const summary = settledSummaryFor(card, studio.doc, settle, cost, own);
  if (!summary || summary.folded) return null;
  return <SettledCard card={card} summary={summary} onLink={studio.runClientAction} takeFocus={takeFocus} />;
};
