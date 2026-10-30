// The lock line (models.md §3.6 A): one quiet line in the QualityPanel footer and in the Cost card's "Next pages
// draw on" row that says which model draws this comic and whether it is locked, with the way to change it.
//   Locked:   "Drawn with {Model} · locked for this comic" + "Change…" (the lock icon reads "Model locked so every
//             page matches").
//   Unlocked: "Will draw with {Model} · locks when the first image is drawn" + "Choose model…".
// The link only OPENS the picker (open_model_picker); changing still needs the confirm.

import React, { useId } from 'react';
import { Lock, Unlock } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { CHANGE_LINK, CHOOSE_LINK, LOCK_ICON_LABEL, lockedLine, unlockedLine } from './copy';
import { requestOpenModelPicker } from './openPicker';
import { currentModelId, isLocked, modelNickname } from './pickerRows';
import { BTN_LINK, cx } from './ui';

export interface LockLineProps {
  doc: ComicDoc;
  /** Default: ask the mounted picker host to open (requestOpenModelPicker). */
  onChange?: () => void;
  /** Called after the request (e.g. close the sheet the line sits in). */
  onRequested?: () => void;
  className?: string;
}

export const LockLine: React.FC<LockLineProps> = ({ doc, onChange, onRequested, className }) => {
  const textId = useId();
  const locked = isLocked(doc);
  const model = modelNickname(currentModelId(doc));
  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5', className)} data-lock-line={locked ? 'locked' : 'unlocked'}>
      {locked ? (
        <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" role="img" aria-label={LOCK_ICON_LABEL} />
      ) : (
        <Unlock className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
      )}
      <span id={textId} className="min-w-0 text-[12px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
        {locked ? lockedLine(model) : unlockedLine(model)}
      </span>
      <button
        type="button"
        aria-describedby={textId}
        onClick={() => {
          if (onChange) onChange();
          else requestOpenModelPicker();
          onRequested?.();
        }}
        className={BTN_LINK}
      >
        {locked ? CHANGE_LINK : CHOOSE_LINK}
      </button>
    </div>
  );
};

export default LockLine;
