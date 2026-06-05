// StatusPulse — a colour-coded run-status dot with a soft pulsing ring + optional label.
// Used for the build/run lifecycle (idle → starting → live → error). Ring animation is
// suppressed under reduced motion (the dot + label still convey state without motion).

import React from 'react';
import { motion } from 'framer-motion';
import { usePrefersReducedMotion } from './motion';

export type RunStatus = 'idle' | 'starting' | 'live' | 'error';

interface StatusStyle {
  dot: string;
  ring: string;
  text: string;
  label: string;
  /** Whether the ring should pulse (steady-state "live"/"starting" do; idle/error don't). */
  animate: boolean;
}

const STATUS_STYLES: Record<RunStatus, StatusStyle> = {
  idle: { dot: 'bg-slate-400', ring: 'bg-slate-400', text: 'text-slate-400', label: 'Idle', animate: false },
  starting: { dot: 'bg-amber-400', ring: 'bg-amber-400', text: 'text-amber-300', label: 'Starting', animate: true },
  live: { dot: 'bg-emerald-400', ring: 'bg-emerald-400', text: 'text-emerald-300', label: 'Live', animate: true },
  error: { dot: 'bg-rose-500', ring: 'bg-rose-500', text: 'text-rose-300', label: 'Error', animate: false },
};

export interface StatusPulseProps {
  status: RunStatus;
  /** Override the default label text. */
  label?: string;
  /** Hide the text label, showing only the dot. */
  hideLabel?: boolean;
  className?: string;
}

export const StatusPulse: React.FC<StatusPulseProps> = ({ status, label, hideLabel, className }) => {
  const reduce = usePrefersReducedMotion();
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.idle;
  const text = label ?? s.label;
  const pulsing = s.animate && !reduce;

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`} role="status" aria-label={text}>
      <span className="relative inline-flex h-2.5 w-2.5">
        {pulsing && (
          <motion.span
            className={`absolute inset-0 rounded-full ${s.ring}`}
            initial={{ opacity: 0.6, scale: 1 }}
            animate={{ opacity: 0, scale: 2.4 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
      </span>
      {!hideLabel && <span className={`text-xs font-semibold ${s.text}`}>{text}</span>}
    </span>
  );
};
