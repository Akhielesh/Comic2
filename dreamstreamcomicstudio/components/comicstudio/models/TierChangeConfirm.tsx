// The light tier confirm (models.md §3.6 E, §3.1 rule 6): after the lock a tier is a RESOLUTION on the locked
// model, never a model change, but the book will hold mixed sizes — so QualityPanel asks once, in place:
//   "Draw new pages at {res}?" · "Same model ({Model}), so characters stay consistent. The {n} pages already
//   drawn stay at {oldRes} unless you redraw them." · Cancel / Use {Tier}
// Focus starts on Cancel (nothing changes unless the user says so); Esc cancels.

import React, { useEffect, useId, useRef } from 'react';
import type { Resolution } from '../../../shared/comic/doc';
import { HAIRLINE, HEADING, RADIUS_CONTROL } from '../../chat/studioDesign';
import { TIER_CANCEL, tierConfirmBody, tierConfirmTitle, tierUseButton } from './copy';
import { BTN_PRIMARY, BTN_SECONDARY, cx } from './ui';

export interface TierChangeConfirmProps {
  /** The tier's label ("Pro"). */
  tierLabel: string;
  /** The resolution new pages will draw at on the locked model. */
  res: Resolution;
  /** The locked model's nickname. */
  model: string;
  /** Pages already drawn, and the size they stay at. */
  drawnPages: number;
  oldRes: Resolution;
  onCancel(): void;
  onConfirm(): void;
}

export const TierChangeConfirm: React.FC<TierChangeConfirmProps> = ({ tierLabel, res, model, drawnPages, oldRes, onCancel, onConfirm }) => {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-tier-confirm
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className={cx('min-w-0 bg-[var(--ds-surface-soft)] p-3', RADIUS_CONTROL, HAIRLINE)}
    >
      <p id={titleId} className={cx(HEADING, 'text-[14px] [overflow-wrap:anywhere]')}>
        {tierConfirmTitle(res)}
      </p>
      <p id={bodyId} className="mt-1 text-[12.5px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
        {tierConfirmBody(model, drawnPages, oldRes)}
      </p>
      <div className="mt-3 flex min-w-0 flex-wrap justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onCancel} className={cx(BTN_SECONDARY, 'flex-1 sm:flex-none')}>
          {TIER_CANCEL}
        </button>
        <button type="button" onClick={onConfirm} className={cx(BTN_PRIMARY, 'flex-1 sm:flex-none')}>
          {tierUseButton(tierLabel)}
        </button>
      </div>
    </div>
  );
};

export default TierChangeConfirm;
