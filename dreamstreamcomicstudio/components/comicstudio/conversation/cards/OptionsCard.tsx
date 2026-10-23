// "options" card: the director's one question, answered with a tap. Single choice sends
// the choice's reply right away; multi-select collects picks until Done; allowCustom adds
// a free-text answer. Once answered (server-marked or just tapped) the card locks.
//
// When choices carry a `visual` (contract §4.7 OptionVisual), they render as picture tiles —
// a panel-layout glyph, a page stack, a style preview, a cast avatar or a balloon swatch — so
// "4 panels or 6?" and "which look?" are answered by seeing, not reading. Visuals are drawn
// procedurally or from the platform library (free; no AI call).

import React, { useState } from 'react';
import { Check, CornerDownLeft } from 'lucide-react';
import { findCharacter, type Card, type ComicDoc, type OptionChoice, type OptionVisual } from '../../../../shared/comic/doc';
import { LETTERING_PRESETS, type LetteringPresetId } from '../../../../shared/comic/lettering/style';
import { stylePreviewId } from '../../../../shared/comic/library';
import { getStylePreset } from '../../../../shared/comic/stylePresets';
import { LibraryImage } from '../../library/LibraryImage';
import { BubblePreview } from '../../library/procedural/BubblePreview';
import { LayoutGlyph } from '../../library/procedural/LayoutGlyph';
import { PresetThumb } from '../../library/procedural/PresetThumb';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, ChipButton, PrimaryButton, cx } from '../ui';
import { CastAvatar, KindIcon } from './castVisual';

type OptionsCardData = Extract<Card, { type: 'options' }>;

const replyFor = (c: OptionChoice) => (c.reply || c.label).trim();

/** "a", "a and b", "a, b and c" */
export const joinChoices = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const isVisual = (v: unknown): v is OptionVisual =>
  !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string';

/** A small stack of pages with the count on top ("pages" visual). */
export const PagesGlyph: React.FC<{ count: number; size?: number }> = ({ count, size = 44 }) => {
  const n = Math.max(1, Math.min(99, Math.floor(count) || 1));
  const layers = Math.min(3, n);
  const w = 26;
  const h = 32;
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden focusable="false" className="text-[var(--ds-muted)]">
      {Array.from({ length: layers }, (_, i) => {
        const off = (layers - 1 - i) * 3.5;
        return (
          <rect
            key={i}
            x={9 + off}
            y={4 + (layers - 1) * 3.5 - off}
            width={w}
            height={h}
            rx={2.5}
            style={{ fill: 'var(--ds-surface)' }}
            stroke="currentColor"
            strokeWidth={1.4}
            opacity={i === layers - 1 ? 1 : 0.55}
          />
        );
      })}
      <text x={22} y={4 + (layers - 1) * 3.5 + h / 2 + 4} textAnchor="middle" fontSize={12} fontWeight={700} style={{ fill: 'var(--ds-ink)' }} fontFamily="system-ui, sans-serif">
        {n}
      </text>
    </svg>
  );
};

/** The picture for one option visual (null when it can't be drawn; the tile still works). */
export const OptionVisualArt: React.FC<{ visual: OptionVisual; doc: ComicDoc | null; urlFor: ComicStudioController['urlFor'] }> = ({ visual, doc, urlFor }) => {
  switch (visual.kind) {
    case 'layout':
      return (
        <LayoutGlyph
          layout={typeof visual.layout === 'string' ? visual.layout : undefined}
          panels={Math.max(1, Math.min(12, Number(visual.panels) || 1))}
          aspect={doc?.format.pageAspect || '2:3'}
          size={36}
        />
      );
    case 'pages':
      return <PagesGlyph count={Number(visual.count) || 1} />;
    case 'preset': {
      const preset = getStylePreset(visual.presetId);
      if (!preset) return null;
      return (
        <span className="block h-full w-full overflow-hidden rounded-lg">
          <LibraryImage
            id={stylePreviewId(preset.id)}
            alt=""
            sizes="120px"
            className="h-full w-full object-cover"
            fallback={<PresetThumb preset={preset} />}
          />
        </span>
      );
    }
    case 'cast': {
      const c = doc ? findCharacter(doc, visual.characterId) : undefined;
      if (!c) return <KindIcon className="h-5 w-5 text-[var(--ds-muted)]" />;
      return <CastAvatar character={c} urlFor={urlFor} size={44} />;
    }
    case 'lettering': {
      // Own keys only: an id like "__proto__" from a card payload must not reach the prototype.
      const id = String(visual.presetId);
      const preset = Object.prototype.hasOwnProperty.call(LETTERING_PRESETS, id) ? LETTERING_PRESETS[id as LetteringPresetId] : undefined;
      if (!preset?.base) return null;
      return <BubblePreview style={preset.base} kind="speech" size={52} />;
    }
    default:
      return null;
  }
};

export const OptionsCard: React.FC<{ card: OptionsCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const [picked, setPicked] = useState<string[]>([]);
  const [localAnswer, setLocalAnswer] = useState<string[] | null>(null);
  const [custom, setCustom] = useState('');
  const choices = Array.isArray(card.choices) ? card.choices.filter((c) => c && typeof c.label === 'string') : [];
  const visual = choices.some((c) => isVisual(c.visual));

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
  const onPick = (c: OptionChoice) => (card.multi ? toggle(c) : answer([c.id], replyFor(c)));

  return (
    <CardShell aria-label={card.question || 'Question'} className="min-w-0 max-w-full">
      {card.question && <p className="mb-3 text-[14px] font-medium leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{card.question}</p>}
      {visual ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-2" role="group" aria-label="Choices">
          {choices.map((c) => {
            const chosen = card.multi ? picked.includes(c.id) || wasChosen(c) : wasChosen(c);
            const art = isVisual(c.visual) ? <OptionVisualArt visual={c.visual} doc={studio.doc} urlFor={studio.urlFor} /> : null;
            const fill = isVisual(c.visual) && c.visual.kind === 'preset';
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={chosen}
                disabled={disabled}
                title={c.description}
                onClick={() => onPick(c)}
                className={cx(
                  'group relative flex min-w-0 flex-col overflow-hidden rounded-xl border text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:cursor-not-allowed',
                  chosen
                    ? 'border-[#D97757]/55 bg-[#D97757]/10'
                    : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] enabled:hover:border-[#D97757]/35 enabled:hover:bg-[var(--ds-hover)]',
                  isAnswered && !chosen && 'opacity-45',
                  !isAnswered && disabled && 'opacity-60'
                )}
              >
                <span className={cx('grid h-16 w-full place-items-center bg-[var(--ds-well)]', fill ? 'p-0' : 'p-1.5')} aria-hidden>
                  {art}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
                  <span className="line-clamp-2 text-[12.5px] font-medium leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{c.label}</span>
                  {c.description && <span className="line-clamp-2 text-[11px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{c.description}</span>}
                </span>
                {chosen && (
                  <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--ds-accent)] text-white shadow" aria-hidden>
                    <Check className="h-3 w-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choices">
          {choices.map((c) => {
            const chosen = card.multi ? picked.includes(c.id) || wasChosen(c) : wasChosen(c);
            return (
              <ChipButton
                key={c.id}
                selected={chosen}
                disabled={disabled}
                title={c.description}
                onClick={() => onPick(c)}
                className={cx(isAnswered && !chosen && 'opacity-45')}
              >
                {chosen && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />}
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block">{c.label}</span>
                  {c.description && <span className="block text-[11px] text-[var(--ds-muted)]">{c.description}</span>}
                </span>
              </ChipButton>
            );
          })}
        </div>
      )}

      {card.multi && !isAnswered && (
        <div className="mt-3">
          <PrimaryButton
            size="sm"
            className="tap-target"
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
            className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[13px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] focus:border-[#D97757]/45 disabled:opacity-50 coarse:text-[16px]"
          />
          <button
            type="submit"
            disabled={!custom.trim() || disabled}
            aria-label="Send answer"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--ds-accent)] text-white transition-all duration-200 hover:bg-[var(--ds-accent-hover)] disabled:bg-[var(--ds-well-strong)] disabled:text-[var(--ds-muted)]"
          >
            <CornerDownLeft className="h-4 w-4" />
          </button>
        </form>
      )}

      {isAnswered && !choices.some(wasChosen) && answered[0] && (
        <p className="mt-2.5 text-[12px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          You answered: <span className="text-[var(--ds-ink)]">“{answered[0]}”</span>
        </p>
      )}
    </CardShell>
  );
};
