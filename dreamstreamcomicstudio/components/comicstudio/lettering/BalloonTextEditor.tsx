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
  /**
   * Clearing the text keeps the line EMPTY (committed as '': no balloon is drawn, the line stays in the
   * script) instead of silently restoring the old text (LE-11). Off where a line can't be empty (a
   * translation): the hint then says so and Enter / blur keep the current text.
   */
  allowEmpty?: boolean;
  /** Offered while the text is empty: remove the line and its balloon (one undoable change). */
  onDelete?(): void;
}

/** The longest balloon line the server stores (jobs.ts `line` sanitizer clips at 600). */
export const LINE_TEXT_MAX = 600;

const CASE: Record<string, React.CSSProperties['textTransform']> = { upper: 'uppercase', lower: 'lowercase', title: 'capitalize', as_typed: 'none' };

export const BalloonTextEditor: React.FC<BalloonTextEditorProps> = ({ plan, H, pageWidthPx, text, onCommit, onCancel, maxLength = LINE_TEXT_MAX, allowEmpty = false, onDelete }) => {
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
    else if (!next.trim() && allowEmpty && text.trim()) onCommit('');
    else onCancel();
  };
  const remove = () => {
    if (done.current) return;
    done.current = true;
    onDelete?.();
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
  const blank = !value.trim();
  // Never silent: an emptied balloon says what Enter will do, and offers the delete right there.
  const hint = (
    <div
      role={blank ? 'status' : undefined}
      data-testid="balloon-text-hint"
      className={`${hintAbove ? 'mb-1' : 'mt-1'} flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-md bg-black/75 px-1.5 py-0.5 text-center text-[10.5px] font-medium text-white`}
    >
      {!blank ? (
        <span>Enter to save · Shift+Enter new line · Esc to cancel</span>
      ) : allowEmpty ? (
        <span>Empty: Enter keeps the line with no balloon · Esc brings the text back</span>
      ) : (
        <span>The text can’t be empty here — Esc keeps the current text</span>
      )}
      {blank && onDelete && (
        <button
          type="button"
          data-testid="balloon-text-delete"
          // Keep the focus in the field (a blur would commit first); the click removes the line.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={remove}
          className="rounded px-1.5 py-0.5 font-semibold text-white underline underline-offset-2 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white coarse:min-h-11 coarse:px-2.5"
        >
          Delete balloon
        </button>
      )}
    </div>
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
        className="block w-full resize-none overflow-hidden rounded-xl border border-[var(--ds-accent)] px-2 py-1.5 leading-snug shadow-[0_8px_30px_rgba(0,0,0,0.25)] outline-none focus:ring-2 focus:ring-[var(--ds-ring)]"
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
