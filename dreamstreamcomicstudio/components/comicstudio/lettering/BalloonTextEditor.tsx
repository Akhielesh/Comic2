// Inline balloon text editor (lettering.md §7.5): a <textarea> laid over the balloon at the plan's own
// font and size, auto-growing. Enter or ⌘/Ctrl+Enter or blur commits a `line` op; Esc cancels;
// Shift+Enter inserts a manual line break. Editing text never touches the art (free, instant).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { fontFamilyStack } from '../../../shared/comic/lettering/fonts';
import { parseFont } from './measure';
import { paintOf } from './svgMarkup';

export interface BalloonTextEditorProps {
  plan: LetterPlan;
  /** Page height in plan units (1000 / aspect). */
  H: number;
  /** Rendered page width in CSS px (plan units → px). */
  pageWidthPx: number;
  /** The line's text as typed (not case-transformed). */
  text: string;
  onCommit(text: string): void;
  onCancel(): void;
  /** Max characters (server cap). */
  maxLength?: number;
}

const CASE: Record<string, React.CSSProperties['textTransform']> = { upper: 'uppercase', lower: 'lowercase', title: 'capitalize', as_typed: 'none' };

export const BalloonTextEditor: React.FC<BalloonTextEditorProps> = ({ plan, H, pageWidthPx, text, onCommit, onCancel, maxLength = 600 }) => {
  const [value, setValue] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const scale = pageWidthPx > 0 ? pageWidthPx / 1000 : 1;
  const parsed = parseFont(plan.font);
  // iOS zooms the whole page when a field under 16 px gets focus: never below 16 px on touch screens.
  const coarse = useState(() => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  })[0];
  const fontPx = Math.max(coarse ? 16 : 12, plan.fontSize * scale);
  const color = paintOf(plan.style.textColor)?.color ?? '#111111';
  const fill = paintOf(plan.style.fill);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Auto-grow with the text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, fontPx * 1.6)}px`;
  }, [value, fontPx]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = value.replace(/\r\n?/g, '\n').slice(0, maxLength);
    if (next.trim() && next !== text) onCommit(next);
    else onCancel();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  // Stay inside the page box (it clips): at least 140 px wide, shifted left near the right edge,
  // and the hint goes above the field near the bottom.
  const widthFrac = Math.min(1, Math.max(plan.w / 1000, 0.16, pageWidthPx > 0 ? 140 / pageWidthPx : 0.16));
  const leftFrac = Math.max(0, Math.min(plan.x / 1000, 1 - widthFrac));
  const topFrac = Math.max(0, Math.min(plan.y / H, 0.9));
  const hintAbove = topFrac > 0.75;
  const hint = (
    <p className={`${hintAbove ? 'mb-1' : 'mt-1'} rounded-md bg-black/70 px-1.5 py-0.5 text-center text-[10.5px] font-medium text-white`}>
      Enter to save · Shift+Enter new line · Esc to cancel
    </p>
  );
  return (
    <div
      className="absolute z-[8]"
      style={{
        left: `${leftFrac * 100}%`,
        ...(hintAbove ? { bottom: `${Math.max(0, (1 - (plan.y + plan.h) / H) * 100)}%` } : { top: `${topFrac * 100}%` }),
        width: `${widthFrac * 100}%`
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {hintAbove && hint}
      <label className="sr-only" htmlFor={`bte-${plan.lineId}`}>
        Balloon text
      </label>
      <textarea
        id={`bte-${plan.lineId}`}
        ref={ref}
        data-testid="balloon-text-editor"
        value={value}
        maxLength={maxLength}
        lang={plan.lang}
        dir={plan.dir}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          // Typing through an IME (Japanese, Chinese, Korean, Hindi/Telugu transliteration…): Enter
          // and Esc confirm or cancel the composition — they must never commit or close the editor.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
        }}
        className="block w-full resize-none overflow-hidden rounded-xl border border-[#D97757]/60 px-2 py-1.5 leading-snug shadow-[0_8px_30px_rgba(0,0,0,0.25)] outline-none focus:ring-2 focus:ring-[#D97757]/45"
        style={{
          fontFamily: fontFamilyStack(plan.fontId),
          fontWeight: parsed?.weight ?? 700,
          fontStyle: parsed?.italic ? 'italic' : undefined,
          fontSize: fontPx,
          textAlign: plan.style.align,
          textTransform: CASE[plan.style.textCase] ?? 'none',
          color,
          background: fill && fill.opacity >= 0.6 ? fill.color : '#ffffff'
        }}
      />
      {!hintAbove && hint}
    </div>
  );
};

export default BalloonTextEditor;
