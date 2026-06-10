// Shared UI primitives for DreamStream Live — the design-system vocabulary:
// buttons, pills, toggles, segmented controls, sliders, avatars, tabs, meters,
// charts, sheets, fields and toasts. Plain CSS classes from styles/app.css.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/* ----------------------------------------------------------------- avatars */
const AVATAR_GRADS: [string, string][] = [
  ['#60a5fa', '#a78bfa'], ['#34d399', '#22d3ee'], ['#f472b6', '#fb7185'],
  ['#fbbf24', '#f97316'], ['#c084fc', '#818cf8'], ['#2dd4bf', '#22d3ee'],
  ['#f87171', '#fb923c'], ['#a3e635', '#22c55e'],
];

export function gradFor(name: string): string {
  let x = 0;
  for (let i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) >>> 0;
  const [a, b] = AVATAR_GRADS[x % AVATAR_GRADS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || name.slice(0, 2).toUpperCase();
}

export function Avatar({ name, size = 30, className, ring }: { name: string; size?: number; className?: string; ring?: boolean }) {
  return (
    <span
      className={cx('avatar', ring && 'avatar-ring', className)}
      style={{ width: size, height: size, background: gradFor(name), fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/* ----------------------------------------------------------------- buttons */
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'solid' | 'ghost' | 'soft' | 'subtle' | 'live' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  iconRight?: string;
};

export function Btn({ variant = 'ghost', size = 'md', icon, iconRight, children, className, ...rest }: BtnProps) {
  return (
    <button className={cx('btn', `btn-${variant}`, `btn-${size}`, className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children != null && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 15 : 17} />}
    </button>
  );
}

type IconBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  name: string;
  active?: boolean;
  tone?: string;
  size?: number;
  label: string;
};

export function IconBtn({ name, active, tone, size = 18, className, label, ...rest }: IconBtnProps) {
  return (
    <button className={cx('iconbtn', active && 'is-active', tone && `t-${tone}`, className)} title={label} aria-label={label} {...rest}>
      <Icon name={name} size={size} />
    </button>
  );
}

/* ------------------------------------------------------------------- pill */
export function Pill({ tone = 'neutral', dot, pulse, icon, children, className, style }: {
  tone?: 'neutral' | 'accent' | 'live' | 'ok' | 'warn' | 'info' | 'solid';
  dot?: boolean;
  pulse?: boolean;
  icon?: string;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className={cx('pill', `pill-${tone}`, className)} style={style}>
      {dot && <span className={cx('pill-dot', pulse && 'pulse')} />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- toggle */
export function Toggle({ on, onChange, size = 'md', label }: { on: boolean; onChange?: (v: boolean) => void; size?: 'sm' | 'md'; label?: string }) {
  return (
    <button
      className={cx('toggle', on && 'on', size === 'sm' && 'toggle-sm')}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange && onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/* -------------------------------------------------------------- segmented */
export interface SegOption {
  value: string;
  label: string;
  icon?: string;
}

export function Segmented({ options, value, onChange, full, label }: {
  options: (SegOption | string)[];
  value: string;
  onChange: (v: string) => void;
  full?: boolean;
  label?: string;
}) {
  return (
    <div className={cx('segmented', full && 'full')} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <button key={opt.value} className={cx('seg', opt.value === value && 'active')} onClick={() => onChange(opt.value)} role="radio" aria-checked={opt.value === value}>
            {opt.icon && <Icon name={opt.icon} size={15} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- slider */
export function Slider({ value, min = 0, max = 100, step = 1, onChange, unit, label, valueLabel }: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string;
  label?: string;
  valueLabel?: string;
}) {
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <div className="slider-wrap">
      {label && (
        <div className="slider-head">
          <span>{label}</span>
          <span className="mono slider-val">{valueLabel != null ? valueLabel : `${value}${unit || ''}`}</span>
        </div>
      )}
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--pct': pct + '%' } as React.CSSProperties}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- tabs */
export interface TabDef {
  id: string;
  label: string;
  icon?: string;
  badge?: number;
}

export function Tabs({ tabs, value, onChange, className }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div className={cx('tabs', className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} className={cx('tab', value === t.id && 'active')} onClick={() => onChange(t.id)} role="tab" aria-selected={value === t.id}>
          {t.icon && <Icon name={t.icon} size={15} />}
          {t.label}
          {t.badge != null && t.badge > 0 && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ meter */
export function Meter({ value, max = 100, tone = 'green', height = 6 }: { value: number; max?: number; tone?: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter" style={{ height }} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <i className={`meter-${tone}`} style={{ width: pct + '%' }} />
    </div>
  );
}

/* --------------------------------------------------------------- AreaChart */
// Simple smooth area chart from an array of numbers (Catmull-Rom → bezier).
export function AreaChart({ data, w = 600, h = 160, color = 'var(--accent)', fill = true, stroke = 2, id }: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
  fill?: boolean;
  stroke?: number;
  id?: string;
}) {
  if (data.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: h }} />;
  const max = Math.max(...data) * 1.1 || 1;
  const n = data.length;
  const px = (i: number) => (i / (n - 1)) * w;
  const py = (v: number) => h - (v / max) * h;
  let d = `M ${px(0)} ${py(data[0])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = [px(Math.max(0, i - 1)), py(data[Math.max(0, i - 1)])];
    const p1 = [px(i), py(data[i])];
    const p2 = [px(i + 1), py(data[i + 1])];
    const p3 = [px(Math.min(n - 1, i + 2)), py(data[Math.min(n - 1, i + 2)])];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }
  const area = `${d} L ${w} ${h} L 0 ${h} Z`;
  const gid = `g_${id || 'chart'}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h }} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* --------------------------------------------------------------- Sparkline */
export function Sparkline({ data, color = 'var(--accent)', w = 90, h = 26 }: { data: number[]; color?: string; w?: number; h?: number }) {
  if (data.length < 2) return <svg style={{ width: w, height: h }} />;
  const max = Math.max(...data) || 1;
  const min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 4) - 2}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: w, height: h }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ field */
export function Field({ label, hint, children, className }: { label?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx('field', className)}>
      {label && (
        <span className="field-label">
          {label}
          {hint && <span className="field-hint">{hint}</span>}
        </span>
      )}
      {children}
    </label>
  );
}

/* ---------------------------------------------------------------- LinkBox */
export function LinkBox({ url, onCopy }: { url: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="linkbox">
      <Icon name="link" size={14} className="faint" />
      <span className="lb-url mono">{url}</span>
      <Btn
        variant="soft"
        size="sm"
        icon={copied ? 'check' : 'copy'}
        onClick={() => {
          navigator.clipboard?.writeText(url).catch(() => undefined);
          setCopied(true);
          onCopy && onCopy();
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Btn>
    </div>
  );
}

/* -------------------------------------------------------------------- toasts */
export interface ToastOpts {
  icon?: string;
  duration?: number;
}

export function useToasts(): [(msg: string, opts?: ToastOpts) => void, React.ReactNode] {
  const [toasts, setToasts] = useState<{ id: string; msg: string; icon?: string }[]>([]);
  const push = (msg: string, opts: ToastOpts = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, icon: opts.icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.duration || 2600);
  };
  const node = (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.icon && <Icon name={t.icon} size={16} />}
          {t.msg}
        </div>
      ))}
    </div>
  );
  return [push, node];
}

export type PushToast = (msg: string, opts?: ToastOpts) => void;

/* -------------------------------------------------------------- media query */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/* -------------------------------------------------- floating emoji layer */
export interface FloatingEmoji {
  key: number;
  e: string;
  right: number;
}

export function useFloatingEmoji(): [FloatingEmoji[], (e: string) => void] {
  const [floats, setFloats] = useState<FloatingEmoji[]>([]);
  const keyRef = useRef(0);
  const spawn = (e: string) => {
    const f: FloatingEmoji = { key: ++keyRef.current, e, right: Math.random() * 46 };
    setFloats((fs) => [...fs.slice(-13), f]);
    setTimeout(() => setFloats((fs) => fs.filter((x) => x.key !== f.key)), 2400);
  };
  return [floats, spawn];
}

export function FloatLayer({ floats, style }: { floats: FloatingEmoji[]; style?: React.CSSProperties }) {
  return (
    <div className="reactions" style={style} aria-hidden>
      {floats.map((f) => (
        <span className="react-float" style={{ right: f.right }} key={f.key}>
          {f.e}
        </span>
      ))}
    </div>
  );
}
