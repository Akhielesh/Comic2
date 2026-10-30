// Style: the style bible every render obeys. The current look (name, art-direction spec,
// palette, linework, things to avoid, and the locked style board — the visual anchor sent
// with every page), the drawn style options to choose from, a quick preset strip, and
// "explore directions" for cheap style boards of THIS story.
//
// Wave 2 (P2-BOARD):
//   • "Your style references (n/8)": the shared <RefStrip> for style photos (the bug: style refs were
//     uploaded but never visible anywhere on the board) — add, open the drawer, drop or paste;
//   • the lettering preset gallery (the comic's balloon and caption look; free, instant, undoable);
//   • preset tiles show the platform library preview (style.<id>) over the free procedural thumb;
//   • option boards: the content-check veil, ≤ 480w variants, calm failures, version stacks;
//   • prices print through formatCostForUser (governed users never see dollars); no hover-only UI.

import React, { useState } from 'react';
import { Check, Lock, Palette, Plus, Sparkles, Type, X } from 'lucide-react';
import type { ComicDoc, StyleBible, StyleOption } from '../../../shared/comic/doc';
import { STYLE_PRESETS, getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets';
import { stylePreviewId } from '../../../shared/comic/library';
import { capFor } from '../../../shared/comic/refs';
import { effectiveRating, safetyStatusOf, type ContentRating } from '../../../shared/comic/safety';
import type { LetteringPresetId } from '../../../shared/comic/lettering/style';
import type { StudioController } from '../types';
import { RADIUS_PILL, TONE_CHIP } from '../../chat/studioDesign';
import { SelectPop } from '../../studio/kit/streamMotion';
import { LibraryImage } from '../library/LibraryImage';
import { PresetThumb } from '../library/procedural/PresetThumb';
import { PresetGallery } from '../lettering/PresetGallery';
import { presetOps as letteringPresetOps } from '../lettering/styleOps';
import { useFormFactor } from '../mobile/useFormFactor';
import { RefStrip } from '../refs/RefStrip';
import { EmptyIllustration, ImageFrame, VIEW_MAX_W, VersionsButton, frameSources } from './ImageFrame';
import { byokFromDoc, estimateOne, hasImage, isBusy, jobModel, presetOps, sheetVisualStatus } from './boardModel';
import { useCostFormat, type CostFormat } from './costFormat';
import { Chip, ConfirmStrip, EmptyHint, GhostButton, InlineField, PrimaryButton, RenderOverlay, SectionTitle, Surface, cx, useClickGuard } from './ui';

export const STYLE_DIRECTIONS = 3;
const OPTION_ASPECT = '4 / 5';
const HEX = /^#[0-9a-f]{6}$/i;

const STATUS_TEXT: Record<StyleBible['status'], string> = { empty: 'Not chosen', drafted: 'Drafted', locked: 'Locked' };

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';

const PaletteEditor: React.FC<{ palette: string[]; onChange: (next: string[]) => void }> = ({ palette, onChange }) => {
  const [adding, setAdding] = useState('#d97757');
  // Touch (ui-findings 2026-10-29, board/style on the Fold): the 20 px corner dot was a 44 px ::after
  // zone that ran over the next swatch. On a coarse pointer each colour is a 44 px chip with a visible
  // 44 px remove button; fine pointers keep the compact swatches with the hover-revealed dot.
  const touch = useFormFactor().coarse;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Palette">
      {palette.map((color, i) => {
        const swatch = (
          <span
            className="block h-8 w-8 shrink-0 rounded-lg border border-[var(--ds-hairline)] shadow-sm"
            style={{ background: HEX.test(color) ? color : 'var(--ds-well)' }}
            title={color}
            aria-label={color}
            role="img"
          />
        );
        const drop = () => onChange(palette.filter((_, j) => j !== i));
        return touch ? (
          <span key={`${color}-${i}`} className={cx('inline-flex h-11 items-center gap-0.5 border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] pl-1.5', RADIUS_PILL)}>
            {swatch}
            <button type="button" aria-label={`Remove ${color}`} onClick={drop} className={cx('grid h-11 w-11 shrink-0 place-items-center text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]', RADIUS_PILL, FOCUS)}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </span>
        ) : (
          <span key={`${color}-${i}`} className="group relative">
            {swatch}
            {/* Revealed on hover/focus with a fine pointer; the wrapper holds the position so the 44 px
                tap zone (.tap-target) can't reset it. */}
            <span className="absolute -right-1.5 -top-1.5">
              <button type="button" aria-label={`Remove ${color}`} onClick={drop} className={cx('hover-reveal tap-target grid h-5 w-5 place-items-center rounded-full bg-[var(--ds-surface-strong)] text-[var(--ds-muted)] shadow', FOCUS)}>
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          </span>
        );
      })}
      {palette.length < 8 && (
        <label
          className="relative grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-dashed border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] focus-within:ring-2 focus-within:ring-[var(--ds-ring)] coarse:h-11 coarse:w-11"
          title="Add a color"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          <input
            type="color"
            value={adding}
            aria-label="Add a palette color"
            onChange={(e) => setAdding(e.target.value)}
            onBlur={(e) => {
              const v = e.target.value.toLowerCase();
              if (HEX.test(v) && !palette.map((p) => p.toLowerCase()).includes(v)) onChange([...palette, v]);
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      )}
    </div>
  );
};

const AvoidEditor: React.FC<{ avoid: string[]; onChange: (next: string[]) => void }> = ({ avoid, onChange }) => {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !avoid.some((a) => a.toLowerCase() === v.toLowerCase())) onChange([...avoid, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Avoid">
      {avoid.map((a) => (
        // Touch: the chip is 44 px tall and its remove button a real 44 px square (a ::after zone on a
        // 16 px button reached the "Add a never…" field on the next row and stole its taps).
        <Chip key={a} className="min-w-0 coarse:py-0">
          <span className="text-[var(--ds-muted)]">no</span> <span className="min-w-0 truncate">{a}</span>
          <button
            type="button"
            aria-label={`Allow ${a}`}
            onClick={() => onChange(avoid.filter((x) => x !== a))}
            className="tap-target -mr-1 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] coarse:-mr-2.5 coarse:h-11 coarse:w-11"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </Chip>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        maxLength={120}
        aria-label="Add something to avoid"
        placeholder="Add a never…"
        className="h-7 min-w-[8rem] flex-1 rounded-full border border-dashed border-[var(--ds-hairline)] bg-transparent px-2.5 text-[12px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/50 focus:outline-none coarse:h-11 coarse:text-base"
      />
    </div>
  );
};

const OptionCard: React.FC<{ studio: StudioController; doc: ComicDoc; option: StyleOption; chosen: boolean; byok: boolean; cost: CostFormat; rating: ContentRating }> = ({
  studio,
  doc,
  option,
  chosen,
  byok,
  cost,
  rating
}) => {
  const { busyKey, fire } = useClickGuard(3000);
  const status = sheetVisualStatus(option.render);
  const src = frameSources(studio.urlFor, option.render.asset, { sizes: '(max-width: 640px) 45vw, 200px' });
  const ready = option.render.status === 'ready' && hasImage(option.render);
  const retry = () => fire('retry', () => studio.act({ type: 'render_style_options', directions: [{ name: option.name, spec: option.spec }] }));
  const pick = () => {
    if (!ready || chosen) return;
    fire('pick', () => studio.act({ type: 'pick_style', optionId: option.id }));
  };
  const safety = { rating, onCheckAgain: () => void studio.act({ type: 'safety_recheck', target: { kind: 'style_option', id: option.id } }) };
  // A veiled board (over the comic's rating) carries its own buttons (Show, Check again): it is never
  // wrapped in the pick button (no button inside a button); "Use" below still picks it.
  const veil = safetyStatusOf(option.render.asset?.safety, rating);
  const veiled = veil === 'over_rating' || veil === 'blocked';
  const overlay = (
    <RenderOverlay
      status={status}
      since={option.render.updatedAt}
      render={option.render}
      label={`${option.name} style board`}
      model={jobModel(doc, 'style_option').nickname}
      error={option.render.error}
      onRetry={retry}
      retryLabel={`Retry · ${cost.quote(estimateOne(doc, 'style_option', byok).usd)}`}
      compact
    />
  );
  return (
    <div data-testid="style-option" data-status={status} className="flex min-w-0 flex-col gap-1.5">
      {ready && src.url && !veiled ? (
        <SelectPop selected={chosen} onClick={pick} ariaLabel={chosen ? `${option.name} (chosen)` : `Choose ${option.name}`} className="w-full overflow-hidden">
          <ImageFrame url={src.url} srcSet={src.srcSet} sizes={src.sizes} heavy={src.heavy} aspect={OPTION_ASPECT} alt={`${option.name} style board`} render={option.render} tone="paper" safety={safety} />
        </SelectPop>
      ) : (
        <ImageFrame
          url={src.url}
          srcSet={src.srcSet}
          sizes={src.sizes}
          heavy={src.heavy}
          aspect={OPTION_ASPECT}
          alt={`${option.name} style board`}
          render={option.render}
          tone={ready ? 'paper' : undefined}
          safety={safety}
          placeholder={<div className="grid h-full place-items-center px-3 text-center text-[11.5px] text-[var(--ds-muted)]">Not drawn yet</div>}
          overlay={overlay}
        />
      )}
      <div className="flex min-w-0 items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-[var(--ds-ink)]" title={option.name}>
            {option.name}
          </p>
          <p className="line-clamp-3 text-[11.5px] leading-snug text-[var(--ds-muted)]">{option.spec}</p>
        </div>
        {ready && (
          <GhostButton size="xs" busy={busyKey === 'pick'} disabled={chosen} onClick={pick} aria-label={chosen ? `${option.name} is your style` : `Use ${option.name}`} className="shrink-0">
            {chosen ? <Check className="h-3 w-3" aria-hidden /> : null}
            {chosen ? 'Chosen' : 'Use'}
          </GhostButton>
        )}
      </div>
      <VersionsButton studio={studio} target={{ kind: 'style_option', id: option.id }} label={`${option.name} style board`} className="self-start" />
    </div>
  );
};

/** A preset's look: the platform library preview when published, the free procedural thumb under it. */
const PresetArt: React.FC<{ preset: StylePreset; className?: string }> = ({ preset, className }) => (
  <span className={cx('relative block overflow-hidden rounded-lg', className)} style={{ background: preset.swatch }} aria-hidden>
    <LibraryImage
      id={stylePreviewId(preset.id)}
      alt=""
      sizes="128px"
      className="absolute inset-0 h-full w-full object-cover"
      fallback={
        <span className="absolute inset-0 block [&>*]:h-full [&>*]:w-full">
          <PresetThumb preset={preset} />
        </span>
      }
    />
  </span>
);

export const StyleTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const style = doc.style;
  const byok = byokFromDoc(doc);
  const cost = useCostFormat(studio.caps);
  const rating = effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const { busyKey, fire } = useClickGuard(4000);
  const [confirming, setConfirming] = useState<StylePreset | null>(null);
  const locked = style.status === 'locked';
  const exploring = style.options.some((o) => isBusy(o.render));
  const explorePrice = estimateOne(doc, 'style_option', byok, STYLE_DIRECTIONS).usd;
  const preset = getStylePreset(style.presetId);
  const board = frameSources(studio.urlFor, style.board, { maxW: VIEW_MAX_W, sizes: '(max-width: 768px) 90vw, 420px' });
  const styleRefs = style.refs?.length ?? 0;
  const set = (patch: Partial<Omit<StyleBible, 'options'>>) => void studio.patch([{ op: 'style', patch }]);
  const choosePreset = (p: StylePreset) => {
    if (p.id === style.presetId && style.status !== 'empty') return;
    if (locked) {
      setConfirming(p);
      return;
    }
    void studio.patch(presetOps(doc, p));
  };
  const chosenOption = (o: StyleOption) => !!style.board?.path && style.board.path === o.render.asset?.path;
  const letterPreset = (doc.letterStyle?.presetId ?? 'classic') as LetteringPresetId;

  const exploreButton = (primary: boolean) => {
    const props = {
      size: 'xs' as const,
      busy: busyKey === 'explore',
      disabled: exploring,
      onClick: () => fire('explore', () => studio.act({ type: 'render_style_options' })),
      'aria-describedby': exploring ? undefined : 'style-explore-price'
    };
    const content = (
      <>
        <Sparkles className={cx('h-3 w-3', !primary && 'text-[var(--ds-accent)]')} aria-hidden />
        {exploring ? 'Drawing options…' : `Explore ${STYLE_DIRECTIONS} directions`}
      </>
    );
    return primary ? <PrimaryButton {...props}>{content}</PrimaryButton> : <GhostButton {...props}>{content}</GhostButton>;
  };

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <Surface className="p-3 sm:p-4" aria-label="Current style">
        <SectionTitle
          icon={<Palette className="h-3.5 w-3.5" />}
          right={
            <span
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
                locked ? TONE_CHIP.success : 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'
              )}
            >
              {locked && <Lock className="h-3 w-3" aria-hidden />} {STATUS_TEXT[style.status]}
            </span>
          }
        >
          Your style
        </SectionTitle>
        {style.status === 'empty' && !style.spec ? (
          <EmptyHint icon={<EmptyIllustration variant="style" />} title="No style yet" className="py-6">
            Pick a preset below, describe a look in the chat, or explore {STYLE_DIRECTIONS} directions drawn from your story.
          </EmptyHint>
        ) : (
          <div className={cx('grid gap-4', style.board && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]')}>
            {style.board && (
              <div className="min-w-0">
                <ImageFrame
                  url={board.url}
                  srcSet={board.srcSet}
                  sizes={board.sizes}
                  heavy={board.heavy}
                  asset={style.board}
                  aspect={style.board.w && style.board.h ? style.board.w / style.board.h : OPTION_ASPECT}
                  alt="Locked style board"
                  tone="paper"
                  safety={{ rating, onChangeRating: () => studio.setTab('story') }}
                />
                <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--ds-muted)]">
                  {locked ? 'Locked — every sheet and page is matched to this board.' : 'Style board (not locked yet).'}
                </p>
              </div>
            )}
            <div className="min-w-0 space-y-2">
              <InlineField label="Style name" value={style.name || ''} placeholder="Name this look" multiline rows={1} submitOnEnter maxLength={80} onCommit={(name) => set({ name })} inputClassName="text-[16px] font-semibold" />
              {preset && !style.board && <PresetArt preset={preset} className="mx-2 h-20" />}
              <InlineField
                label="Art direction"
                showLabel
                multiline
                rows={4}
                value={style.spec || ''}
                placeholder="Medium, linework, color, shading, influences — concrete and drawable."
                onCommit={(spec) => set({ spec, ...(style.status === 'empty' ? { status: 'drafted' as const } : {}) })}
              />
              <InlineField label="Linework" showLabel value={style.linework || ''} placeholder="e.g. tapered brush inks" onCommit={(linework) => set({ linework })} />
              <div className="px-2">
                <p className="mb-1 text-[11px] font-medium text-[var(--ds-muted)]">Palette</p>
                <PaletteEditor palette={style.palette || []} onChange={(palette) => set({ palette })} />
              </div>
              <div className="px-2">
                <p className="mb-1 text-[11px] font-medium text-[var(--ds-muted)]">Never</p>
                <AvoidEditor avoid={style.avoid || []} onChange={(avoid) => set({ avoid })} />
              </div>
              {locked && <p className="px-2 text-[11px] text-[var(--ds-muted)]">Edits to a locked style mark drawn pages out of date; nothing is redrawn until you ask.</p>}
            </div>
          </div>
        )}
      </Surface>

      <section aria-labelledby="style-refs-title">
        <SectionTitle id="style-refs-title">
          Your style references ({styleRefs}/{capFor({ kind: 'style' })})
        </SectionTitle>
        <RefStrip studio={studio} owner={{ kind: 'style' }} />
        <p className="mt-1 px-1 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          Photos or drawings whose look you like — linework, color, texture, mood. We borrow the look, never the content.
        </p>
      </section>

      <section aria-labelledby="style-options-title">
        <SectionTitle
          id="style-options-title"
          // The primary call only while no look is locked; afterwards exploring is optional.
          right={exploreButton(!locked)}
        >
          Style options
        </SectionTitle>
        {!exploring && (
          <p id="style-explore-price" className="-mt-1 mb-2 text-right text-[11px] tabular-nums text-[var(--ds-muted)]">
            {cost.quote(explorePrice)} for {STYLE_DIRECTIONS} small boards
          </p>
        )}
        {style.options.length ? (
          <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,160px),1fr))]">
            {style.options.map((o) => (
              <OptionCard key={o.id} studio={studio} doc={doc} option={o} chosen={chosenOption(o)} byok={byok} cost={cost} rating={rating} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-[var(--ds-hairline)] px-4 py-5 text-center text-[12.5px] leading-relaxed text-[var(--ds-muted)]">
            Style boards are small test illustrations of a key moment from your story in different looks. Tap one to lock it in.
          </p>
        )}
      </section>

      <section aria-labelledby="style-presets-title">
        <SectionTitle id="style-presets-title" right={<span className="text-[11px] font-medium normal-case tracking-normal text-[var(--ds-muted)]">Free</span>}>
          Quick presets
        </SectionTitle>
        {confirming && (
          <div className="mb-3">
            <ConfirmStrip
              tone="accent"
              message={`Replace your locked style with ${confirming.name}? Drawn pages will be marked out of date (nothing is redrawn until you ask).`}
              confirmLabel="Replace style"
              cancelLabel="Keep current"
              onConfirm={() => {
                void studio.patch(presetOps(doc, confirming));
                setConfirming(null);
              }}
              onCancel={() => setConfirming(null)}
            />
          </div>
        )}
        <ul className="-mx-1 flex gap-3 overflow-x-auto overscroll-x-contain px-1 pb-2 [scrollbar-width:thin]">
          {STYLE_PRESETS.map((p) => {
            const on = style.presetId === p.id && style.status !== 'empty';
            return (
              <li key={p.id} className="shrink-0">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => choosePreset(p)}
                  title={p.tagline}
                  className={cx(
                    'block w-32 rounded-xl border p-1.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 motion-reduce:transition-none',
                    on ? 'border-[var(--ds-accent)] bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:-translate-y-px hover:bg-[var(--ds-hover)] motion-reduce:hover:translate-y-0'
                  )}
                >
                  <span className="relative block">
                    <PresetArt preset={p} className="h-16" />
                    {on && (
                      <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[var(--ds-accent)] text-white" aria-hidden>
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </span>
                  <span className="mt-1.5 block truncate text-[12px] font-semibold text-[var(--ds-ink)]">{p.name}</span>
                  <span className="line-clamp-2 block text-[10.5px] leading-snug text-[var(--ds-muted)]">{p.tagline}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="style-lettering-title">
        <SectionTitle id="style-lettering-title" icon={<Type className="h-3.5 w-3.5" />} right={<span className="text-[11px] font-medium normal-case tracking-normal text-[var(--ds-muted)]">Free · instant</span>}>
          Lettering style
        </SectionTitle>
        <p className="mb-2 px-1 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          How balloons, captions and sound effects look on every page. Changing it re-letters the comic for free — nothing is redrawn.
        </p>
        <PresetGallery
          value={letterPreset}
          lang={doc.format.language}
          onChange={(id) => void studio.patch(letteringPresetOps(id), { label: 'Change lettering style' })}
        />
      </section>
    </div>
  );
};
