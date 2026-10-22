// Style panel (composer chip "🎨 Style"): the curated preset grid, "explore 3 directions
// for my story" (cheap style boards, gated like any spend) and "describe your own".
// Picking a preset drafts the style bible instantly (a `style` patch, no LLM).
// Preset tiles show the platform library's real preview art when it is published, with the
// procedural thumbnail as the instant, offline fallback (assets.md; free either way).

import React, { useState } from 'react';
import { Check, Lock, PenLine, Sparkles } from 'lucide-react';
import type { ComicDoc, StyleBible } from '../../../../shared/comic/doc';
import type { DocOp, StudioAction } from '../../../../shared/comic/ops';
import { estimateJobs, formatUsd } from '../../../../shared/comic/models';
import { STYLE_PRESETS, type StylePreset } from '../../../../shared/comic/stylePresets';
import { stylePreviewId } from '../../../../shared/comic/library';
import { LibraryImage } from '../../library/LibraryImage';
import { PresetThumb } from '../../library/procedural/PresetThumb';
import { GhostButton, PrimaryButton, SectionLabel, cx } from '../ui';

/** Ops that make a preset the (drafted) style. A locked board from another look is dropped. */
export const presetOps = (doc: ComicDoc, preset: StylePreset): DocOp[] => {
  const patch: Partial<Omit<StyleBible, 'options'>> & { board?: null } = {
    status: 'drafted',
    presetId: preset.id,
    name: preset.name,
    spec: preset.spec,
    palette: preset.palette,
    linework: preset.linework,
    avoid: preset.avoid
  };
  // null clears it on the server (undefined would not survive JSON).
  if (doc.style.board) patch.board = null;
  const ops: DocOp[] = [{ op: 'style', patch: patch as Partial<Omit<StyleBible, 'options'>> }];
  const colorMode = preset.colorMode || 'color';
  if (doc.format.colorMode !== colorMode) ops.push({ op: 'format', patch: { colorMode } });
  return ops;
};

export const STYLE_DIRECTION_COUNT = 3;

export interface StylePanelProps {
  doc: ComicDoc;
  patch: (ops: DocOp[]) => Promise<void> | void;
  act: (action: StudioAction) => Promise<void> | void;
  /** Prefill the composer so the user can describe a look in their own words. */
  onDescribeOwn: () => void;
  /** Close the panel (after an action that moves the conversation on). */
  onDone: () => void;
  byok?: boolean;
}

export const StylePanel: React.FC<StylePanelProps> = ({ doc, patch, act, onDescribeOwn, onDone, byok = false }) => {
  const [confirming, setConfirming] = useState<StylePreset | null>(null);
  const style = doc.style;
  const locked = style.status === 'locked';
  const exploring = style.options.some((o) => o.render.status === 'queued' || o.render.status === 'rendering');
  const estimate = estimateJobs([{ kind: 'style_option', count: STYLE_DIRECTION_COUNT, label: 'style options' }], doc.settings.quality, { byok });
  const custom = style.status !== 'empty' && !style.presetId && (style.name || style.spec);

  const choose = (preset: StylePreset) => {
    if (preset.id === style.presetId && !locked) return;
    if (locked && preset.id !== style.presetId) {
      setConfirming(preset);
      return;
    }
    void patch(presetOps(doc, preset));
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <PrimaryButton
          className="sm:flex-1"
          disabled={exploring}
          onClick={() => {
            void act({ type: 'render_style_options' });
            onDone();
          }}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {exploring ? 'Drawing style options…' : `Explore ${STYLE_DIRECTION_COUNT} directions for my story`}
          {!exploring && <span className="font-normal opacity-80">· ≈ {formatUsd(estimate.usd)}</span>}
        </PrimaryButton>
        <GhostButton
          onClick={() => {
            onDescribeOwn();
            onDone();
          }}
        >
          <PenLine className="h-3.5 w-3.5" aria-hidden />
          Describe your own…
        </GhostButton>
      </div>

      {confirming && (
        <div role="alertdialog" aria-label="Replace locked style" className="rounded-xl border border-[#D97757]/35 bg-[#D97757]/10 p-3 text-[12px] text-[var(--ds-ink)]">
          <p>
            Replace your locked style with <strong>{confirming.name}</strong>? Pages already drawn will be marked out of date (nothing is redrawn
            until you ask).
          </p>
          <div className="mt-2 flex gap-2">
            <PrimaryButton
              size="sm"
              data-autofocus
              onClick={() => {
                void patch(presetOps(doc, confirming));
                setConfirming(null);
              }}
            >
              Replace style
            </PrimaryButton>
            <GhostButton size="sm" onClick={() => setConfirming(null)}>
              Keep current
            </GhostButton>
          </div>
        </div>
      )}

      {custom && (
        <div className="flex items-start gap-2 rounded-xl border border-[#D97757]/40 bg-[#D97757]/10 px-3 py-2.5">
          {locked ? <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden /> : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />}
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--ds-ink)]">
              {locked ? 'Locked' : 'Current'}: {style.name || 'Custom style'}
            </div>
            {style.spec && <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ds-muted)]">{style.spec}</p>}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Presets</SectionLabel>
        <div role="radiogroup" aria-label="Style presets" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {STYLE_PRESETS.map((preset) => {
            const on = style.presetId === preset.id && style.status !== 'empty';
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(preset)}
                className={cx(
                  'group relative overflow-hidden rounded-xl border text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50',
                  on ? 'border-[#D97757]/60 ring-2 ring-[#D97757]/30' : 'border-[var(--ds-hairline)] hover:-translate-y-px hover:border-[#D97757]/35'
                )}
              >
                <span data-preset-art="" className="relative block aspect-[16/9] w-full overflow-hidden bg-[var(--ds-well)]" aria-hidden>
                  <LibraryImage
                    id={stylePreviewId(preset.id)}
                    alt=""
                    sizes="(min-width: 640px) 160px, 45vw"
                    className="absolute inset-0 h-full w-full object-cover"
                    fallback={
                      <span className="absolute inset-0 block [&>*]:h-full [&>*]:w-full">
                        <PresetThumb preset={preset} />
                      </span>
                    }
                  />
                </span>
                <span className="block bg-[var(--ds-surface-strong)] px-2.5 py-2">
                  <span className="flex items-center gap-1 text-[12px] font-semibold text-[var(--ds-ink)]">
                    <span className="truncate">{preset.name}</span>
                    {on && (locked ? <Lock className="h-3 w-3 shrink-0 text-[var(--ds-accent)]" aria-label="locked" /> : <Check className="h-3 w-3 shrink-0 text-[var(--ds-accent)]" aria-hidden />)}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-snug text-[var(--ds-muted)]">{preset.tagline}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
