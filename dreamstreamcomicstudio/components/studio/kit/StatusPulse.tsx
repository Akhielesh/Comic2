// StatusPulse — a colour-coded run-status dot with a soft pulsing ring + optional label.
// Used for the build/run lifecycle (idle → starting → live → error). Ring animation is
// suppressed under reduced motion (the dot + label still convey state without motion).

import React from 'react';
import { motion } from 'framer-motion';
import { usePrefersReducedMotion } from './motion';
import { STATUS_DOT, STATUS_INK } from '../../chat/studioDesign';

export type RunStatus = 'idle' | 'starting' | 'live' | 'error';

interface StatusStyle {
  dot: string;
  ring: string;
  /** Label ink (the status tokens read correctly in light and dark). */
  text: string;
  label: string;
  /** Whether the ring should pulse (steady-state "live"/"starting" do; idle/error don't). */
  animate: boolean;
}

// One status vocabulary (studioDesign STATUS_*): idle is "waiting", starting is "active" (ink, so
// it stays distinct from idle without the label or motion), live is "healthy", error is "error".
// Always beside the label (or its aria-label). The ink comes from the app tokens, so place it on an
// app-token surface; a host with its own fixed dark panel sets its own text shade via className.
const STATUS_STYLES: Record<RunStatus, StatusStyle> = {
  idle: { dot: STATUS_DOT.waiting, ring: STATUS_DOT.waiting, text: STATUS_INK.waiting, label: 'Idle', animate: false },
  starting: { dot: STATUS_DOT.active, ring: STATUS_DOT.active, text: STATUS_INK.active, label: 'Starting', animate: true },
  live: { dot: STATUS_DOT.healthy, ring: STATUS_DOT.healthy, text: STATUS_INK.healthy, label: 'Live', animate: true },
  error: { dot: STATUS_DOT.error, ring: STATUS_DOT.error, text: STATUS_INK.error, label: 'Error', animate: false },
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
