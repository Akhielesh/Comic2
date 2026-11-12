/**
 * StatusBanner — a calm line or callout that says what is happening and what still works (Atlas
 * WorkspacePrimitives StatusBanner; redesign plan §8 "one voice"). It replaces the three OfflineBanners and the raw
 * red export errors: the surface, the edge and the icon come from the one status vocabulary (STATUS_SURFACE /
 * STATUS_INK), always beside words, never colour alone.
 *
 *   tone    healthy · active · waiting · attention · error, or `offline` (the attention surface, one tone for
 *           offline everywhere: "You're offline. {what still works}. {what waits}.")
 *   size    `line` is the 36 px strip under the header (the offline line); `banner` is a callout in the content
 *
 * An `error` banner is an alert (it interrupts); every other tone is a polite status. The action is a quiet
 * outline button; no banner here carries a price or the spark.
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, WifiOff, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { RADIUS_CONTROL, STATUS_INK, STATUS_SURFACE, type StatusState } from './recipes';

export type StatusBannerTone = StatusState | 'offline';

export interface StatusBannerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: StatusBannerTone;
  /** The situation, in sentence case. Offline banners default to "You're offline." */
  title?: React.ReactNode;
  /** One sentence about what happens next (what still works, what waits for the connection). */
  children?: React.ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  size?: 'line' | 'banner';
  /** Replaces the tone's icon (decoration). */
  icon?: React.ReactNode;
}

const ICONS: Record<StatusBannerTone, React.ComponentType<{ className?: string }>> = {
  healthy: CheckCircle2,
  active: Loader2,
  waiting: Info,
  attention: AlertTriangle,
  error: XCircle,
  offline: WifiOff
};

/** The 36 px offline line and the roomier callout. */
export const STATUS_BANNER_SIZE = {
  line: 'min-h-9 px-3 py-1.5 text-[13px] leading-5',
  banner: `${RADIUS_CONTROL} border px-3.5 py-3 text-[length:var(--ds-text-base)] leading-5`
} as const;

export function StatusBanner({ tone = 'waiting', title, children, action, size = 'banner', icon, className, ...rest }: StatusBannerProps) {
  const state: StatusState = tone === 'offline' ? 'attention' : tone;
  const Icon = ICONS[tone];
  const heading = title ?? (tone === 'offline' ? "You're offline." : null);
  return (
    <div
      {...rest}
      role={tone === 'error' ? 'alert' : 'status'}
      data-slot="status-banner"
      data-tone={tone}
      className={cn('flex min-w-0 items-start gap-2.5', STATUS_BANNER_SIZE[size], STATUS_SURFACE[state], size === 'line' && 'border-b', className)}
    >
      <span aria-hidden="true" className={cn('mt-0.5 inline-flex shrink-0 [&_svg]:size-4', STATUS_INK[state])}>
        {icon ?? <Icon className={tone === 'active' ? 'motion-safe:animate-spin' : undefined} />}
      </span>
      <div className={cn('min-w-0 flex-1', size === 'line' && 'flex flex-wrap items-baseline gap-x-1.5')}>
        {heading ? <p className="m-0 font-medium text-[var(--ds-ink)]">{heading}</p> : null}
        {children ? <div className="m-0 text-[var(--ds-muted)] [overflow-wrap:anywhere]">{children}</div> : null}
      </div>
      {action ? (
        <Button size="sm" variant="outline" onClick={action.onClick} disabled={action.disabled} className="shrink-0">
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
