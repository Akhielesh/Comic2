// Colour control for lettering (lettering.md §7.4 ColorField): swatches from the preset + the comic's
// palette, "Transparent", a custom colour (native picker + hex), an opacity slider (writes '#rrggbbaa')
// and an eyedropper to sample the art where the browser supports it (window.EyeDropper; hidden
// otherwise). Free: picking a colour never costs anything.

import React, { useEffect, useId, useState } from 'react';
import { Pipette } from 'lucide-react';
import { normalizeColor, type Color } from '../../../shared/comic/lettering/style';
import { paintOf } from './svgMarkup';
import { cx } from '../board/ui';

export interface ColorFieldProps {
  label: string;
  value: Color;
  /** `scrub` = slider movement (coalesce into one undo entry). */
  onChange(value: Color, opts?: { scrub?: boolean }): void;
  swatches?: readonly string[];
  /** Show the opacity slider (fill / border / text). */
  allowAlpha?: boolean;
  /** Offer "Transparent" ('none'). */
  allowNone?: boolean;
  /** Offer "Auto" (the SFX palette colour). */
  allowAuto?: boolean;
  /** Easy view: swatches + transparent only (custom colour behind "More"). */
  simple?: boolean;
  className?: string;
}

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

/** '#rrggbb' + alpha 0..1 → '#rrggbb[aa]' (alpha 1 drops the suffix). */
export const withAlpha = (hex: string, alpha: number): Color => {
  const base = paintOf(hex)?.color ?? '#111111';
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return a >= 255 ? base : `${base}${a.toString(16).padStart(2, '0')}`;
};

// Touch: real 44 px swatches (a 28 px swatch's 44 px ::after overlapped its neighbours' and stole taps).
const SWATCH_CLS =
  'relative h-7 w-7 shrink-0 rounded-full border border-[var(--ds-hairline)] shadow-sm transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/60 motion-reduce:transition-none motion-reduce:hover:scale-100 coarse:h-11 coarse:w-11 coarse:hover:scale-100';

/** Checkerboard behind translucent swatches (so 50 % white is visibly see-through). */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0,0 4px,4px -4px,-4px 0'
};

export const ColorField: React.FC<ColorFieldProps> = ({ label, value, onChange, swatches = [], allowAlpha, allowNone, allowAuto, simple, className }) => {
  const id = useId();
  const paint = paintOf(value);
  const hex = paint?.color ?? '#ffffff';
  const alpha = paint?.opacity ?? 1;
  const [draft, setDraft] = useState(hex);
  const [more, setMore] = useState(!simple);
  useEffect(() => setDraft(hex), [hex]);
  const eyeDropper = typeof window !== 'undefined' ? (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper : undefined;
  const uniq = [...new Set(swatches.map((s) => normalizeColor(s)).filter((s): s is string => !!s && s !== 'none' && s !== 'auto'))].slice(0, 10);

  const pickHex = (h: string) => onChange(withAlpha(h, alpha));
  const commitDraft = () => {
    const n = normalizeColor(draft);
    if (n && n !== 'none' && n !== 'auto') pickHex(n);
    else setDraft(hex);
  };

  return (
    <fieldset className={cx('min-w-0 space-y-1.5', className)}>
      <legend className="mb-1 text-[11.5px] font-medium text-[var(--ds-muted)]">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${label} swatches`}>
        {allowAuto && (
          <button
            type="button"
            aria-pressed={value === 'auto'}
            title="Automatic colour"
            onClick={() => onChange('auto')}
            className={cx(SWATCH_CLS, 'grid place-items-center bg-[conic-gradient(#e63946,#ffb703,#06d6a0,#3a86ff,#8338ec,#e63946)] text-[9px] font-bold text-white', value === 'auto' && 'ring-2 ring-[#D97757]')}
          >
            <span className="sr-only">Automatic</span>A
          </button>
        )}
        {uniq.map((s) => {
          const selected = paint?.color === paintOf(s)?.color && value !== 'none';
          return (
            <button
              key={s}
              type="button"
              aria-pressed={selected}
              aria-label={`${label}: ${s}`}
              title={s}
              onClick={() => onChange(withAlpha(s, alpha))}
              className={cx(SWATCH_CLS, selected && 'ring-2 ring-[#D97757]')}
              style={{ background: s }}
            />
          );
        })}
        {allowNone && (
          <button
            type="button"
            aria-pressed={value === 'none'}
            title="Transparent"
            onClick={() => onChange('none')}
            className={cx(SWATCH_CLS, value === 'none' && 'ring-2 ring-[#D97757]')}
            style={CHECKER}
          >
            <span className="sr-only">Transparent</span>
            <span aria-hidden className="absolute left-1/2 top-1/2 h-[2px] w-[120%] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-red-500/80" />
          </button>
        )}
        {simple && !more && (
          <button
            type="button"
            onClick={() => setMore(true)}
            className="rounded-full px-2 py-1 text-[11.5px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:min-w-11 coarse:px-3 coarse:text-[13px]"
          >
            More…
          </button>
        )}
      </div>
      {more && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={`${id}-picker`}>
            {label}: custom colour
          </label>
          <input
            id={`${id}-picker`}
            type="color"
            value={hex}
            onChange={(e) => pickHex(e.target.value)}
            className="h-7 w-9 shrink-0 cursor-pointer rounded-md border border-[var(--ds-hairline)] bg-transparent p-0.5 coarse:h-11 coarse:w-11"
          />
          <label className="sr-only" htmlFor={`${id}-hex`}>
            {label}: hex value
          </label>
          <input
            id={`${id}-hex`}
            value={value === 'none' ? '' : draft}
            placeholder={value === 'none' ? 'none' : '#rrggbb'}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitDraft();
            }}
            spellCheck={false}
            className="h-7 w-[5.5rem] min-w-0 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 font-mono text-[12px] text-[var(--ds-ink)] coarse:h-11 coarse:w-[7rem] coarse:text-[16px] focus:border-[#D97757]/50 focus:outline-none"
          />
          {eyeDropper && (
            <button
              type="button"
              title="Pick a colour from the page"
              aria-label={`${label}: pick from the page`}
              onClick={async () => {
                try {
                  const r = await new eyeDropper().open();
                  if (r?.sRGBHex) pickHex(r.sRGBHex);
                } catch {
                  /* the user dismissed the eyedropper */
                }
              }}
              className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:w-11"
            >
              <Pipette className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
      {allowAlpha && value !== 'none' && value !== 'auto' && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-alpha`} className="w-14 shrink-0 text-[11px] text-[var(--ds-muted)]">
            Opacity
          </label>
          <input
            id={`${id}-alpha`}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(alpha * 100)}
            onChange={(e) => onChange(withAlpha(hex, Number(e.target.value) / 100), { scrub: true })}
            className="min-w-0 flex-1 accent-[#D97757]"
          />
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--ds-muted)]">{Math.round(alpha * 100)}%</span>
        </div>
      )}
    </fieldset>
  );
};

export default ColorField;
