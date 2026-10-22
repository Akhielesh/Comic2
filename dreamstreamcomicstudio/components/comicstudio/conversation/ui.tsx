// Small calm-studio building blocks shared by the conversation pane, cards and panels.
// Everything composes from components/chat/studioDesign.ts tokens (--ds-* vars, the
// terracotta accent) — never the legacy comic chrome.

import React from 'react';
import { Loader2 } from 'lucide-react';
import {
  ACCENT_BG,
  ACCENT_BG_HOVER,
  HAIRLINE,
  INK,
  MUTED,
  RADIUS_PANEL,
  SHADOW_SOFT,
  TRANSITION
} from '../../chat/studioDesign';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Conversation card shell: frosted surface, hairline, soft shadow. */
export const CardShell: React.FC<{
  title?: React.ReactNode;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}> = ({ title, icon, right, children, className, ...rest }) => (
  <section
    aria-label={rest['aria-label']}
    className={cx(`${RADIUS_PANEL} ${HAIRLINE} ${SHADOW_SOFT} bg-[var(--ds-surface)] p-4`, className)}
  >
    {(title || right) && (
      <header className="mb-3 flex items-center justify-between gap-3">
        <span className={`flex min-w-0 items-center gap-2 text-[14px] font-semibold tracking-tight ${INK}`}>
          {icon && <span className="shrink-0 text-[var(--ds-accent)]">{icon}</span>}
          <span className="truncate">{title}</span>
        </span>
        {right && <span className={`shrink-0 text-[12px] ${MUTED}`}>{right}</span>}
      </header>
    )}
    {children}
  </section>
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; size?: 'sm' | 'md' };

// Coarse pointers get real 44 px buttons (mobile.md §2.4); fine pointers keep today's sizes.
const sizeCls = (size: 'sm' | 'md' = 'md') => (size === 'sm' ? 'h-8 px-3 text-[12px] coarse:h-11 coarse:px-3.5' : 'h-9 px-4 text-[13px] coarse:h-11');

export const PrimaryButton: React.FC<ButtonProps> = ({ busy, size, className, children, disabled, ...rest }) => (
  <button
    type="button"
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={cx(
      `inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold text-white ${ACCENT_BG} ${ACCENT_BG_HOVER} ${TRANSITION} disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50`,
      sizeCls(size),
      className
    )}
  >
    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
    {children}
  </button>
);

export const GhostButton: React.FC<ButtonProps> = ({ busy, size, className, children, disabled, ...rest }) => (
  <button
    type="button"
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={cx(
      `inline-flex items-center justify-center gap-1.5 rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] font-medium ${INK} hover:bg-[var(--ds-hover)] ${TRANSITION} disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40`,
      sizeCls(size),
      className
    )}
  >
    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
    {children}
  </button>
);

/** Pill chip (suggestions, option answers). */
export const ChipButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }> = ({
  selected,
  className,
  children,
  ...rest
}) => (
  <button
    type="button"
    {...rest}
    aria-pressed={selected === undefined ? undefined : selected}
    className={cx(
      `inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-[13px] leading-snug ${TRANSITION} disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-[44px] coarse:text-[14px]`,
      selected
        ? // An answered card keeps the chosen chip at full strength; only the others fade.
          'border-[#D97757]/45 bg-[#D97757]/10 text-[var(--ds-ink)] disabled:opacity-100'
        : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:border-[#D97757]/35 hover:bg-[var(--ds-hover)]',
      className
    )}
  >
    {children}
  </button>
);

/** Segmented control (format kind, reading direction, panels per page). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('flex rounded-xl bg-[var(--ds-well-strong)] p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              `flex min-w-0 flex-1 items-center justify-center gap-1 rounded-[10px] px-2 py-1.5 text-[12px] font-medium ${TRANSITION} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:min-h-[44px]`,
              on ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Quiet section label inside panels and sheets. */
export const SectionLabel: React.FC<{ children: React.ReactNode; htmlFor?: string; className?: string }> = ({ children, htmlFor, className }) =>
  htmlFor ? (
    <label htmlFor={htmlFor} className={cx('mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]', className)}>
      {children}
    </label>
  ) : (
    <div className={cx('mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]', className)}>{children}</div>
  );

/** Tiny aspect-ratio glyph ("▭" drawn at the real ratio). */
export const AspectGlyph: React.FC<{ aspect: string; size?: number; className?: string }> = ({ aspect, size = 14, className }) => {
  const [w, h] = aspect.split(':').map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 2 / 3;
  const width = ratio >= 1 ? size : Math.max(3, Math.round(size * ratio));
  const height = ratio >= 1 ? Math.max(3, Math.round(size / ratio)) : size;
  return (
    <span aria-hidden className={cx('inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <span className="block rounded-[2px] border-[1.5px] border-current" style={{ width, height }} />
    </span>
  );
};

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;
