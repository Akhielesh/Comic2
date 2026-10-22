// "options" card: the director's one question, answered with a tap. Single choice sends
// the choice's reply right away; multi-select collects picks until Done; allowCustom adds
// a free-text answer. Once answered (server-marked or just tapped) the card locks.

import React, { useState } from 'react';
import { Check, CornerDownLeft } from 'lucide-react';
import type { Card, OptionChoice } from '../../../../shared/comic/doc';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, ChipButton, PrimaryButton, cx } from '../ui';

type OptionsCardData = Extract<Card, { type: 'options' }>;

const replyFor = (c: OptionChoice) => (c.reply || c.label).trim();

/** "a", "a and b", "a, b and c" */
export const joinChoices = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export const OptionsCard: React.FC<{ card: OptionsCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const [picked, setPicked] = useState<string[]>([]);
  const [localAnswer, setLocalAnswer] = useState<string[] | null>(null);
  const [custom, setCustom] = useState('');
  const choices = Array.isArray(card.choices) ? card.choices : [];

  const serverAnswered = (card.answered || []).filter(Boolean);
  const answered = serverAnswered.length ? serverAnswered : localAnswer || [];
  const isAnswered = answered.length > 0;
  const wasChosen = (c: OptionChoice) => answered.includes(c.id) || answered.includes(c.label);
  const disabled = isAnswered || studio.messageBusy || !studio.doc;

  const answer = (ids: string[], text: string) => {
    if (!text.trim() || disabled) return;
    setLocalAnswer(ids.length ? ids : [text]);
    void studio.send(text.trim());
  };

  const toggle = (c: OptionChoice) => setPicked((prev) => (prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]));

  return (
    <CardShell aria-label={card.question || 'Question'}>
      {card.question && <p className="mb-3 text-[14px] font-medium leading-snug text-[var(--ds-ink)]">{card.question}</p>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Choices">
        {choices.map((c) => {
          const chosen = card.multi ? picked.includes(c.id) || wasChosen(c) : wasChosen(c);
          return (
            <ChipButton
              key={c.id}
              selected={chosen}
              disabled={disabled}
              title={c.description}
              onClick={() => (card.multi ? toggle(c) : answer([c.id], replyFor(c)))}
              className={cx(isAnswered && !chosen && 'opacity-45')}
            >
              {chosen && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />}
              <span className="min-w-0">
                <span className="block">{c.label}</span>
                {c.description && <span className="block text-[11px] text-[var(--ds-muted)]">{c.description}</span>}
              </span>
            </ChipButton>
          );
        })}
      </div>

      {card.multi && !isAnswered && (
        <div className="mt-3">
          <PrimaryButton
            size="sm"
            disabled={!picked.length || disabled}
            onClick={() => {
              const chosen = choices.filter((c) => picked.includes(c.id));
              answer(
                chosen.map((c) => c.id),
                joinChoices(chosen.map(replyFor))
              );
            }}
          >
            Done{picked.length ? ` (${picked.length})` : ''}
          </PrimaryButton>
        </div>
      )}

      {card.allowCustom && !isAnswered && (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            answer([], custom);
            setCustom('');
          }}
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={disabled}
            placeholder="Or type your own answer…"
            aria-label="Your own answer"
            className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[13px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] focus:border-[#D97757]/45 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!custom.trim() || disabled}
            aria-label="Send answer"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--ds-accent)] text-white transition-all duration-200 hover:bg-[var(--ds-accent-hover)] disabled:bg-[var(--ds-well-strong)] disabled:text-[var(--ds-muted)]"
          >
            <CornerDownLeft className="h-4 w-4" />
          </button>
        </form>
      )}

      {isAnswered && !choices.some(wasChosen) && answered[0] && (
        <p className="mt-2.5 text-[12px] text-[var(--ds-muted)]">
          You answered: <span className="text-[var(--ds-ink)]">“{answered[0]}”</span>
        </p>
      )}
    </CardShell>
  );
};
