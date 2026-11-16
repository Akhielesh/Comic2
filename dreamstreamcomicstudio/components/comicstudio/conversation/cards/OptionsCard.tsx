// "options" card: the director's one question, answered with a tap. Single choice sends
// the choice's reply right away; multi-select collects picks until Done; allowCustom adds
// a free-text answer. Once answered (server-marked or just tapped) the card locks.
//
// When choices carry a `visual` (contract §4.7 OptionVisual), they render as picture tiles —
// a panel-layout glyph, a page stack, a style preview, a cast avatar or a balloon swatch — so
// "4 panels or 6?" and "which look?" are answered by seeing, not reading. Visuals are drawn
// procedurally or from the platform library (free; no AI call).
//
// Live agent (agent-editor plan §3 A3.3): "Which line?" and "Where?" questions show the comic itself — a `balloon`
// visual is a crop of the page around that balloon (or the line's words in a bubble while the page is not drawn), and a
// `spot` visual is a page thumbnail with one of the nine cells of the page or of a panel highlighted.

import React, { useContext, useRef, useState } from 'react';
import { ComposerDraftAccountContext, useComposerDraft } from '../../../../services/composerDrafts';
import { Check, CornerDownLeft } from 'lucide-react';
import { POS9, findCharacter, type Box, type Card, type ComicDoc, type OptionChoice, type OptionVisual, type Pos9 } from '../../../../shared/comic/doc';
import { LETTERING_PRESETS, type LetteringPresetId } from '../../../../shared/comic/lettering/style';
import { aspectRatioOf } from '../../../../shared/comic/models';
import { panelBoxesFor } from '../../../../shared/comic/pageGeometry';
import { stylePreviewId } from '../../../../shared/comic/library';
import { getStylePreset } from '../../../../shared/comic/stylePresets';
import { LibraryImage } from '../../library/LibraryImage';
import { BubblePreview } from '../../library/procedural/BubblePreview';
import { LayoutGlyph } from '../../library/procedural/LayoutGlyph';
import { PresetThumb } from '../../library/procedural/PresetThumb';
import type { ComicStudioController } from '../../useStudio';
import { sendOutcomeOf } from '../../messageQueue';
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

type UrlFor = ComicStudioController['urlFor'];

/** The page's drawn image URL (a small variant), or undefined while it is not drawn or not signed yet. */
const pageImage = (doc: ComicDoc | null, pageId: string, urlFor: UrlFor): { page: ComicDoc['pages'][number]; src?: string } | undefined => {
  const page = doc?.pages.find((p) => p.id === pageId);
  if (!page) return undefined;
  const asset = page.render.status !== 'none' ? page.render.asset : undefined;
  return { page, src: asset ? urlFor(asset, { width: 480 }) : undefined };
};

const quoteOf = (text: string, max = 44): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`}”`;
};

/**
 * A `balloon` visual: a crop of the drawn page centred on that balloon, with the balloon outlined, so "Which line?" is
 * answered by seeing where it is. While the page is not drawn (or the balloon not placed yet) it is the line's words in
 * a bubble. Null when the line is gone (the tile's label still answers).
 */
export const BalloonVisual: React.FC<{ pageId: string; lineId: string; doc: ComicDoc | null; urlFor: UrlFor }> = ({ pageId, lineId, doc, urlFor }) => {
  const at = pageImage(doc, pageId, urlFor);
  const line = at?.page.panels.flatMap((p) => p.lines).find((l) => l.id === lineId);
  if (!at || !line || !doc) return null;
  const balloon = at.page.balloons.find((b) => b.lineId === lineId);
  if (at.src && balloon) {
    const aspect = aspectRatioOf(doc.format.pageAspect);
    // A window about twice the balloon's width, centred on the balloon (its height ≈ 0.6 × its width on the page).
    const cw = Math.min(1, Math.max(0.3, balloon.w * 2.2));
    const cx = Math.min(1, Math.max(0, balloon.x + balloon.w / 2));
    const cy = Math.min(1, Math.max(0, balloon.y + 0.3 * balloon.w * aspect));
    return (
      <span className="relative block h-full w-full overflow-hidden bg-[var(--ds-well)]" data-visual="balloon">
        <img
          src={at.src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
          style={{ width: `${(100 / cw).toFixed(2)}%`, transform: `translate(-${(cx * 100).toFixed(2)}%, -${(cy * 100).toFixed(2)}%)` }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 aspect-[5/3] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 border-[var(--ds-accent)]"
          style={{ width: `${Math.min(96, (balloon.w / cw) * 100).toFixed(1)}%` }}
        />
      </span>
    );
  }
  return (
    <span className="grid h-full w-full place-items-center px-2" data-visual="balloon">
      <span className="line-clamp-2 max-w-full rounded-[1.1rem] border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2.5 py-1 text-center text-[11px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
        {quoteOf(line.text)}
      </span>
    </span>
  );
};

/** One of the nine cells of `frame` (a page-fraction box), row by row from the top left. */
export const cellOf = (frame: Box, cell: Pos9): Box => {
  const i = Math.max(0, POS9.indexOf(cell));
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { x: frame.x + (col * frame.w) / 3, y: frame.y + (row * frame.h) / 3, w: frame.w / 3, h: frame.h / 3 };
};

const WHOLE_PAGE: Box = { x: 0, y: 0, w: 1, h: 1 };

/**
 * A `spot` visual: the page (drawn, or its panel outlines) with one cell highlighted — of the whole page (frame
 * 'page') or of panel `panelN` (frame 'panel', its frame outlined). Null when the page is gone.
 */
export const SpotVisual: React.FC<{ visual: Extract<OptionVisual, { kind: 'spot' }>; doc: ComicDoc | null; urlFor: UrlFor }> = ({ visual, doc, urlFor }) => {
  const at = doc ? pageImage(doc, visual.pageId, urlFor) : undefined;
  if (!at || !doc) return null;
  const aspect = aspectRatioOf(doc.format.pageAspect);
  const W = 100 * aspect;
  const H = 100;
  const boxes = panelBoxesFor(doc, at.page);
  const panel = visual.frame === 'panel' && typeof visual.panelN === 'number' ? boxes[visual.panelN - 1] : undefined;
  const frame = panel ?? WHOLE_PAGE;
  const cell = cellOf(frame, POS9.includes(visual.cell) ? visual.cell : 'center');
  const r = (b: Box) => ({ x: b.x * W, y: b.y * H, width: b.w * W, height: b.h * H });
  return (
    <svg viewBox={`0 0 ${W.toFixed(2)} ${H}`} className="block h-full max-w-full" aria-hidden focusable="false" data-visual="spot">
      <rect x={0} y={0} width={W} height={H} style={{ fill: 'var(--ds-surface)', stroke: 'var(--ds-hairline)' }} strokeWidth={1} />
      {at.src ? (
        <image href={at.src} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid slice" />
      ) : (
        boxes.map((b, i) => <rect key={i} {...r(b)} rx={1.5} style={{ fill: 'none', stroke: 'var(--ds-muted)' }} strokeWidth={0.8} />)
      )}
      {panel && <rect {...r(panel)} rx={1.5} style={{ fill: 'none', stroke: 'var(--ds-ink)' }} strokeWidth={1.6} data-frame="panel" />}
      <rect {...r(cell)} rx={1.5} style={{ fill: 'var(--ds-accent)', fillOpacity: 0.4, stroke: 'var(--ds-accent)' }} strokeWidth={1.6} data-cell={visual.cell} />
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
    case 'balloon':
      return typeof visual.pageId === 'string' && typeof visual.lineId === 'string' ? <BalloonVisual pageId={visual.pageId} lineId={visual.lineId} doc={doc} urlFor={urlFor} /> : null;
    case 'spot':
      return typeof visual.pageId === 'string' && typeof visual.cell === 'string' ? <SpotVisual visual={visual} doc={doc} urlFor={urlFor} /> : null;
    default:
      return null;
  }
};

export const OptionsCard: React.FC<{ card: OptionsCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const accountId = useContext(ComposerDraftAccountContext);
  const scope = accountId && studio.doc?.id && card.id ? { accountId, surface: 'director-answer', conversationId: JSON.stringify([studio.doc.id, card.id]) } : undefined;
  const customDraft = useComposerDraft(scope);
  const picksDraft = useComposerDraft(scope ? { ...scope, surface: 'director-answer-picks' } : undefined);
  const { text: custom, setText: setCustom } = customDraft;
  let picked: string[] = [];
  try { const saved: unknown = JSON.parse(picksDraft.text || '[]'); if (Array.isArray(saved)) picked = saved.filter((id): id is string => typeof id === 'string'); } catch { /* An invalid saved selection is empty. */ }
  const [localAnswer, setLocalAnswer] = useState<string[] | null>(null);
  const pending = useRef(false);
  const choices = Array.isArray(card.choices) ? card.choices.filter((c) => c && typeof c.label === 'string') : [];
  const visual = choices.some((c) => isVisual(c.visual));

  const serverAnswered = (card.answered || []).filter(Boolean);
  const answered = serverAnswered.length ? serverAnswered : localAnswer || [];
  const isAnswered = answered.length > 0;
  const wasChosen = (c: OptionChoice) => answered.includes(c.id) || answered.includes(c.label);
  // With the live queue on (agent-editor plan §3 A1) an answer can go whenever the server's turn lock is free — also
  // while renders still stream — and never while it is held (a director turn, a plan_pages run): send() would refuse it.
  // Without the queue, today's rule: not while a message is in flight.
  const turnBusy = studio.turnLocked ?? studio.messageBusy;
  const disabled = isAnswered || turnBusy || !studio.doc;

  const answer = (ids: string[], text: string) => {
    const reply = text.trim();
    if (!reply || disabled || pending.current) return;
    pending.current = true;
    const customSnapshot = customDraft.capture();
    const picksSnapshot = picksDraft.capture();
    setLocalAnswer(ids.length ? ids : [reply]);
    // Hold drafts until the real controller acknowledges this card's answer. The captured
    // revisions protect another mounted copy or typing resumed before a late receipt.
    const finish = (accepted: boolean) => {
      pending.current = false;
      if (accepted) {
        if (!ids.length) customDraft.clearIfCurrent(customSnapshot);
        picksDraft.clearIfCurrent(picksSnapshot);
      } else setLocalAnswer(null);
    };
    const cardReply = typeof card.id === 'string' && card.id ? { card: ids.length ? { id: card.id, choiceIds: ids } : { id: card.id, custom: reply } } : undefined;
    let sent: ReturnType<ComicStudioController['send']>;
    try { sent = studio.send(reply, studio.confirmsMessages ? { ...cardReply, onAccepted: finish } : cardReply); }
    catch { finish(false); return; }
    void Promise.resolve(sent)
      .then(sendOutcomeOf, () => 'refused' as const)
      .then((outcome) => {
        if (outcome === 'refused') finish(false);
        else if (!studio.confirmsMessages) finish(true);
      });
  };

  const toggle = (c: OptionChoice) => picksDraft.setText(JSON.stringify(picked.includes(c.id) ? picked.filter((id) => id !== c.id) : [...picked, c.id]));
  const onPick = (c: OptionChoice) => (card.multi ? toggle(c) : answer([c.id], replyFor(c)));

  return (
    <CardShell aria-label={card.question || 'Question'} className="min-w-0 max-w-full">
      {card.question && <p className="mb-3 text-[14px] font-medium leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{card.question}</p>}
      {visual ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-2" role="group" aria-label="Choices">
          {choices.map((c) => {
            const chosen = card.multi ? picked.includes(c.id) || wasChosen(c) : wasChosen(c);
            const art = isVisual(c.visual) ? <OptionVisualArt visual={c.visual} doc={studio.doc} urlFor={studio.urlFor} /> : null;
            // Pictures of the comic itself (a style preview, a balloon crop, a page spot) fill the tile edge to edge.
            const fill = isVisual(c.visual) && (c.visual.kind === 'preset' || c.visual.kind === 'balloon' || c.visual.kind === 'spot');
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
