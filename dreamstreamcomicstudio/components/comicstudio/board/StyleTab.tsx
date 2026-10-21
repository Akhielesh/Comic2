// Style: the style bible every render obeys. The current look (name, art-direction spec,
// palette, linework, things to avoid, and the locked style board — the visual anchor sent
// with every page), the drawn style options to choose from, a quick preset strip, and
// "explore directions" for cheap style boards of THIS story.

import React, { useState } from 'react';
import { Check, Lock, Palette, Plus, Sparkles, X } from 'lucide-react';
import type { ComicDoc, StyleBible, StyleOption } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import { STYLE_PRESETS, getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets';
import type { StudioController } from '../types';
import { SelectPop } from '../../studio/kit/streamMotion';
import { ImageFrame } from './ImageFrame';
import { byokFromDoc, estimateOne, hasImage, isBusy, jobModel, presetOps, sheetVisualStatus } from './boardModel';
import { Chip, ConfirmStrip, EmptyHint, GhostButton, InlineField, PrimaryButton, RenderOverlay, SectionTitle, Surface, cx, useClickGuard } from './ui';

export const STYLE_DIRECTIONS = 3;
const OPTION_ASPECT = '4 / 5';
const HEX = /^#[0-9a-f]{6}$/i;

const STATUS_TEXT: Record<StyleBible['status'], string> = { empty: 'Not chosen', drafted: 'Drafted', locked: 'Locked' };

const PaletteEditor: React.FC<{ palette: string[]; onChange: (next: string[]) => void }> = ({ palette, onChange }) => {
  const [adding, setAdding] = useState('#d97757');
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Palette">
      {palette.map((color, i) => (
        <span key={`${color}-${i}`} className="group relative">
          <span
            className="block h-8 w-8 rounded-lg border border-[var(--ds-hairline)] shadow-sm"
            style={{ background: HEX.test(color) ? color : 'var(--ds-well)' }}
            title={color}
            aria-label={color}
            role="img"
          />
          <button
            type="button"
            aria-label={`Remove ${color}`}
            onClick={() => onChange(palette.filter((_, j) => j !== i))}
            className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--ds-surface-strong)] text-[var(--ds-muted)] opacity-0 shadow transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        </span>
      ))}
      {palette.length < 8 && (
        <label className="relative grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-dashed border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]" title="Add a color">
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
        <Chip key={a}>
          <span className="text-[var(--ds-muted)]">no</span> {a}
          <button type="button" aria-label={`Allow ${a}`} onClick={() => onChange(avoid.filter((x) => x !== a))} className="-mr-1 grid h-4 w-4 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">
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
        aria-label="Add something to avoid"
        placeholder="Add a never…"
        className="h-7 min-w-[8rem] flex-1 rounded-full border border-dashed border-[var(--ds-hairline)] bg-transparent px-2.5 text-[12px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/50 focus:outline-none"
      />
    </div>
  );
};

const OptionCard: React.FC<{ studio: StudioController; doc: ComicDoc; option: StyleOption; chosen: boolean; byok: boolean }> = ({ studio, doc, option, chosen, byok }) => {
  const { busyKey, fire } = useClickGuard(3000);
  const status = sheetVisualStatus(option.render);
  const url = studio.urlFor(option.render.asset);
  const ready = option.render.status === 'ready' && hasImage(option.render);
  const retry = () => fire('retry', () => studio.act({ type: 'render_style_options', directions: [{ name: option.name, spec: option.spec }] }));
  const pick = () => {
    if (!ready || chosen) return;
    fire('pick', () => studio.act({ type: 'pick_style', optionId: option.id }));
  };
  const overlay = (
    <RenderOverlay
      status={status}
      since={option.render.updatedAt}
      model={jobModel(doc, 'style_option').nickname}
      error={option.render.error}
      onRetry={retry}
      retryLabel={`Retry · ≈ ${formatUsd(estimateOne(doc, 'style_option', byok).usd)}`}
      compact
    />
  );
  return (
    <div data-testid="style-option" data-status={status} className="flex flex-col gap-1.5">
      {ready && url ? (
        <SelectPop selected={chosen} onClick={pick} ariaLabel={chosen ? `${option.name} (chosen)` : `Choose ${option.name}`} className="w-full overflow-hidden">
          <ImageFrame url={url} aspect={OPTION_ASPECT} alt={`${option.name} style board`} render={option.render} tone="paper" />
        </SelectPop>
      ) : (
        <ImageFrame
          url={url}
          aspect={OPTION_ASPECT}
          alt={`${option.name} style board`}
          render={option.render}
          placeholder={<div className="grid h-full place-items-center px-3 text-center text-[11.5px] text-[var(--ds-muted)]">Not drawn yet</div>}
          overlay={overlay}
        />
      )}
      <div className="flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-[var(--ds-ink)]">{option.name}</p>
          <p className="line-clamp-3 text-[11.5px] leading-snug text-[var(--ds-muted)]">{option.spec}</p>
        </div>
        {ready && (
          <GhostButton size="xs" busy={busyKey === 'pick'} disabled={chosen} onClick={pick} aria-label={chosen ? `${option.name} is your style` : `Use ${option.name}`}>
            {chosen ? <Check className="h-3 w-3" aria-hidden /> : null}
            {chosen ? 'Chosen' : 'Use'}
          </GhostButton>
        )}
      </div>
    </div>
  );
};

export const StyleTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const style = doc.style;
  const byok = byokFromDoc(doc);
  const { busyKey, fire } = useClickGuard(4000);
  const [confirming, setConfirming] = useState<StylePreset | null>(null);
  const locked = style.status === 'locked';
  const exploring = style.options.some((o) => isBusy(o.render));
  const explorePrice = estimateOne(doc, 'style_option', byok, STYLE_DIRECTIONS).usd;
  const preset = getStylePreset(style.presetId);
  const boardUrl = studio.urlFor(style.board);
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

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <Surface className="p-3 sm:p-4" aria-label="Current style">
        <SectionTitle
          icon={<Palette className="h-3.5 w-3.5" />}
          right={
            <span
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
                locked ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'
              )}
            >
              {locked && <Lock className="h-3 w-3" aria-hidden />} {STATUS_TEXT[style.status]}
            </span>
          }
        >
          Your style
        </SectionTitle>
        {style.status === 'empty' && !style.spec ? (
          <EmptyHint icon={<Palette className="h-7 w-7" />} title="No style yet" className="py-6">
            Pick a preset below, describe a look in the chat, or explore {STYLE_DIRECTIONS} directions drawn from your story.
          </EmptyHint>
        ) : (
          <div className={cx('grid gap-4', style.board && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]')}>
            {style.board && (
              <div>
                <ImageFrame url={boardUrl} aspect={style.board.w && style.board.h ? style.board.w / style.board.h : OPTION_ASPECT} alt="Locked style board" tone="paper" />
                <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--ds-muted)]">
                  {locked ? 'Locked — every sheet and page is matched to this board.' : 'Style board (not locked yet).'}
                </p>
              </div>
            )}
            <div className="min-w-0 space-y-2">
              <InlineField label="Style name" value={style.name || ''} placeholder="Name this look" onCommit={(name) => set({ name })} inputClassName="text-[16px] font-semibold" />
              {preset && !style.board && (
                <div className="mx-2 h-10 rounded-xl border border-[var(--ds-hairline)]" style={{ background: preset.swatch }} aria-hidden />
              )}
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

      <section aria-labelledby="style-options-title">
        <SectionTitle
          id="style-options-title"
          right={
            // The primary call only while no look is locked; afterwards exploring is optional.
            style.status === 'locked' ? (
              <GhostButton
                size="xs"
                busy={busyKey === 'explore'}
                disabled={exploring}
                onClick={() => fire('explore', () => studio.act({ type: 'render_style_options' }))}
              >
                <Sparkles className="h-3 w-3 text-[var(--ds-accent)]" aria-hidden />
                {exploring ? 'Drawing options…' : `Explore ${STYLE_DIRECTIONS} directions`}{' '}
                {!exploring && <span className="text-[var(--ds-muted)]">≈ {formatUsd(explorePrice)}</span>}
              </GhostButton>
            ) : (
              <PrimaryButton
                size="xs"
                busy={busyKey === 'explore'}
                disabled={exploring}
                onClick={() => fire('explore', () => studio.act({ type: 'render_style_options' }))}
              >
                <Sparkles className="h-3 w-3" aria-hidden />
                {exploring ? 'Drawing options…' : `Explore ${STYLE_DIRECTIONS} directions`}{' '}
                {!exploring && <span className="font-normal opacity-85">≈ {formatUsd(explorePrice)}</span>}
              </PrimaryButton>
            )
          }
        >
          Style options
        </SectionTitle>
        {style.options.length ? (
          <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,180px),1fr))]">
            {style.options.map((o) => (
              <OptionCard key={o.id} studio={studio} doc={doc} option={o} chosen={chosenOption(o)} byok={byok} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-[var(--ds-hairline)] px-4 py-5 text-center text-[12.5px] leading-relaxed text-[var(--ds-muted)]">
            Style boards are small test illustrations of a key moment from your story in different looks. Tap one to lock it in.
          </p>
        )}
      </section>

      <section aria-labelledby="style-presets-title">
        <SectionTitle id="style-presets-title">Quick presets</SectionTitle>
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
        <ul className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
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
                    'block w-32 rounded-xl border p-1.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45',
                    on ? 'border-[var(--ds-accent)] bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:-translate-y-px hover:bg-[var(--ds-hover)]'
                  )}
                >
                  <span className="relative block h-14 rounded-lg" style={{ background: p.swatch }} aria-hidden>
                    {on && (
                      <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[var(--ds-accent)] text-white">
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
    </div>
  );
};
