// "conflict" card (agent-editor plan §3 A3.1, owner decision D3): the creator and the director changed the same thing
// while the director was working. The creator's edit already won; the card shows both versions side by side and asks
// once: [Keep mine] [Use the director's] [Show me]. Free; "Use the director's" is undoable (resolve_conflict commits
// it with origin 'director'). Never silent: an item that can't be applied from here says so, items past the card's
// cap are counted ("…and 3 more I left alone"), and a switched-off guard or a busy director say why the buttons are
// gone or waiting.

import React from 'react';
import { Check, Eye, GitCompareArrows } from 'lucide-react';
import { conflictGuardOn } from '../../../../shared/comic/capabilities';
import type { ConflictCard as ConflictCardData, ConflictItem } from '../../../../shared/comic/doc';
import { cn } from '../../../../lib/utils';
import { FOCUS_RING, MUTED, OVERLINE, RADIUS_CONTROL, STATUS_CHIP, STATUS_CHIP_TONE, TONE_CHIP } from '../../../chat/studioDesign';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, PrimaryButton } from '../ui';
import { useAction } from './useAction';

type Studio = Pick<ComicStudioController, 'act' | 'caps' | 'openPage' | 'setSelection'> & { messageBusy?: boolean };

/** The card's heading: "We both changed page 2 · panel 1 · line 2." / "…3 things on page 2." / "…3 things." */
export const conflictHeading = (items: readonly ConflictItem[]): string => {
  if (items.length === 1) return `We both changed ${items[0].where.label}.`;
  const pages = new Set(items.map((it) => /^page \d+/.exec(it.where.label)?.[0] ?? it.where.label));
  return pages.size === 1 ? `We both changed ${items.length} things on ${[...pages][0]}.` : `We both changed ${items.length} things while I was working.`;
};

/** "…and 3 more I left alone" (collisions past the card's cap, counted, never dropped). */
export const moreText = (more?: number): string | null => (typeof more === 'number' && more > 0 ? `…and ${more} more I left alone` : null);

export const TOO_BIG_NOTE = "That change is too big to apply from here; Show me opens it.";
export const OFF_NOTE = "Answering conflict questions is switched off right now. Your version stays as it is.";
export const BUSY_NOTE = 'You can answer once the director finishes this step.';

const Version: React.FC<{ who: string; text: string; tone?: 'mine' | 'theirs' }> = ({ who, text, tone }) => (
  <div className={cn(RADIUS_CONTROL, 'min-w-0 border border-[var(--ds-hairline)] px-3 py-2', tone === 'mine' ? 'bg-[var(--ds-surface-soft)]' : 'bg-[var(--ds-well)]')}>
    <span className={cn(OVERLINE, 'block')}>{who}</span>
    <p className="mt-0.5 text-[13px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{text || '—'}</p>
  </div>
);

const ResolvedChip: React.FC<{ how: 'mine' | 'theirs' }> = ({ how }) => (
  <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.healthy)}>
    <Check className="h-3 w-3 shrink-0" aria-hidden />
    {how === 'mine' ? 'Kept yours' : "Used the director's"}
  </span>
);

export const ConflictCard: React.FC<{ card: ConflictCardData; studio: Studio }> = ({ card, studio }) => {
  const { run, isPending } = useAction(studio.act);
  const items = Array.isArray(card.items) ? card.items.filter((it) => it && typeof it.id === 'string' && it.where && typeof it.where.label === 'string') : [];
  if (!items.length) return null;
  const on = conflictGuardOn(studio.caps);
  const busy = !!studio.messageBusy;
  const open = items.filter((it) => !it.resolved);
  const canAnswer = on && !busy;

  const answer = (key: string, itemIds: string[], choice: 'mine' | 'theirs') =>
    void run(key, { type: 'resolve_conflict', cardId: card.id, itemIds, choice });
  const showMe = (it: ConflictItem) => {
    if (!it.where.pageId) return;
    studio.openPage(it.where.pageId);
    if (it.where.lineId) studio.setSelection({ pageId: it.where.pageId, lineIds: [it.where.lineId], surface: 'page_editor' });
  };
  const more = moreText(card.more);
  const applicable = open.filter((it) => !it.tooBig);

  return (
    <CardShell title={conflictHeading(items)} icon={<GitCompareArrows className="h-4 w-4" aria-hidden />} aria-label="Conflict" className="min-w-0 max-w-full">
      <p className={cn('-mt-1 mb-3 text-[12.5px] leading-snug', MUTED)}>
        {open.length ? 'Your edit stays. I held mine back — pick which version to keep.' : 'Answered. Your choice is on the page.'}
      </p>
      <ul className="space-y-3" aria-label="Changes we both made">
        {items.map((it) => (
          <li key={it.id} className="min-w-0 space-y-2" aria-label={it.where.label}>
            {items.length > 1 && <p className={cn(OVERLINE, '[overflow-wrap:anywhere]')}>{it.where.label}</p>}
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              <Version who="Yours" text={it.mine} tone="mine" />
              <Version who="The director's" text={it.theirs} tone="theirs" />
            </div>
            {it.resolved ? (
              <ResolvedChip how={it.resolved} />
            ) : (
              <div className="flex min-w-0 flex-wrap gap-2">
                {on && (
                  <PrimaryButton size="sm" className={FOCUS_RING} disabled={!canAnswer} busy={isPending(`mine:${it.id}`)} onClick={() => answer(`mine:${it.id}`, [it.id], 'mine')}>
                    Keep mine
                  </PrimaryButton>
                )}
                {on && !it.tooBig && (
                  <GhostButton size="sm" className={FOCUS_RING} disabled={!canAnswer} busy={isPending(`theirs:${it.id}`)} onClick={() => answer(`theirs:${it.id}`, [it.id], 'theirs')}>
                    Use the director&rsquo;s
                  </GhostButton>
                )}
                {it.where.pageId && (
                  <GhostButton size="sm" className={FOCUS_RING} onClick={() => showMe(it)} aria-label={`Show me ${it.where.label}`}>
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                    Show me
                  </GhostButton>
                )}
              </div>
            )}
            {!it.resolved && it.tooBig && on && (
              <p role="note" className={cn(RADIUS_CONTROL, 'border px-2.5 py-1.5 text-[12px] leading-snug [overflow-wrap:anywhere]', TONE_CHIP.info)}>
                {TOO_BIG_NOTE}
              </p>
            )}
          </li>
        ))}
      </ul>
      {open.length > 1 && on && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-2 border-t border-[var(--ds-hairline)] pt-3">
          <PrimaryButton size="sm" className={FOCUS_RING} disabled={!canAnswer} busy={isPending('mine:all')} onClick={() => answer('mine:all', open.map((it) => it.id), 'mine')}>
            Keep all mine
          </PrimaryButton>
          {applicable.length > 0 && (
            <GhostButton size="sm" className={FOCUS_RING} disabled={!canAnswer} busy={isPending('theirs:all')} onClick={() => answer('theirs:all', applicable.map((it) => it.id), 'theirs')}>
              Use all the director&rsquo;s
            </GhostButton>
          )}
        </div>
      )}
      {more && <p className={cn('mt-3 text-[12px]', MUTED)}>{more}</p>}
      {open.length > 0 && !on && (
        <p role="note" className={cn('mt-3 text-[12px] leading-snug', MUTED)}>
          {OFF_NOTE}
        </p>
      )}
      {open.length > 0 && on && busy && (
        <p role="status" className={cn('mt-3 text-[12px] leading-snug', MUTED)}>
          {BUSY_NOTE}
        </p>
      )}
    </CardShell>
  );
};
