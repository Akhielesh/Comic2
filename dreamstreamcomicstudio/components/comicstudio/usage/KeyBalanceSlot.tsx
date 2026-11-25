// Comic Studio header slot: what the person's OWN OpenRouter key has left (docs/features/credit-safety.md MN-3).
//
// "$12.40 left · 5 min ago": the key's real balance (the smaller of its spending limit left and the account's credits,
// as OpenRouter reports them), with when it was read. A tap reads it again. It is read when the studio opens and the
// reading is missing or older than 15 minutes, and again after a drawing run settles — never on a timer.
//
// Shown only while this comic draws on the person's own key and they have an OpenRouter key; hidden while the balance
// is unknown (OpenRouter shares nothing for a key without a limit on an account its key may not read). Governed people
// keep the "usage left" slot beside it, which speaks in percentages. Owner-only by construction: the read uses the
// signed-in owner's bearer and their own key. Ink and muted only: no colour beside money.

import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { anyRenderBusy } from '../../../shared/comic/attention';
import { useAuth } from '../../../contexts/AuthContext';
import { keyBalanceView, useKeyBalance } from '../../../services/keyBalance';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, HAIRLINE, INK, MUTED, RADIUS_PILL, TRANSITION } from '../../chat/studioDesign';
import type { StudioController } from '../types';

/** Right after the usage meter (220) and before Read (300) — see features.ts BUILTIN_HEADER_ORDER. */
export const KEY_BALANCE_SLOT_ORDER = 221;

export const KeyBalanceSlot: React.FC<{ studio: Pick<StudioController, 'doc' | 'caps'>; compact: boolean }> = ({ studio, compact }) => {
  const { user } = useAuth();
  const ownKey = studio.caps?.byok === true;
  const balance = useKeyBalance(user?.id, { enabled: ownKey });
  const [announce, setAnnounce] = useState('');
  const tapped = useRef(false);

  // After a run settles (something was drawing, now nothing is), the key has spent: read it again.
  const busy = anyRenderBusy(studio.doc);
  const wasBusy = useRef(busy);
  const { refresh } = balance;
  useEffect(() => {
    if (wasBusy.current && !busy && ownKey) void refresh();
    wasBusy.current = busy;
  }, [busy, ownKey, refresh]);

  const view = keyBalanceView(balance.report);
  // A tap says what it found, once, for a screen reader.
  useEffect(() => {
    if (!tapped.current || balance.state === 'checking') return;
    tapped.current = false;
    setAnnounce(view ? `Balance read: ${view.amount} left.` : 'Couldn’t read the balance just now.');
  }, [balance.state, view?.amount]);

  if (!ownKey || !user || !balance.scope || !view) return null;
  const checking = balance.state === 'checking';
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => {
          tapped.current = true;
          void refresh();
        }}
        aria-label={`${view.spoken} Read it again.`}
        title={`${view.amount} left on your OpenRouter key · read ${view.age}. Tap to read it again.`}
        aria-busy={checking || undefined}
        data-key-balance=""
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 bg-[var(--ds-surface-soft)] text-[12px] font-medium tabular-nums hover:bg-[var(--ds-hover)]',
          HAIRLINE,
          RADIUS_PILL,
          INK,
          TRANSITION,
          FOCUS_RING,
          compact ? 'h-11 px-2.5' : 'h-8 px-2.5 coarse:h-11 coarse:px-3'
        )}
      >
        {checking ? (
          <RefreshCw className={cn('h-3.5 w-3.5 shrink-0 motion-safe:animate-spin', MUTED)} aria-hidden />
        ) : (
          <KeyRound className={cn('h-3.5 w-3.5 shrink-0', MUTED)} aria-hidden />
        )}
        <span>{compact ? view.amount : `${view.amount} left`}</span>
        {!compact && <span className={MUTED}>· {view.age}</span>}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </span>
  );
};

export default KeyBalanceSlot;
