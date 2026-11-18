import React, { useId } from 'react';
import { AlertTriangle, ArrowUpCircle, Coins, Clock3, X } from 'lucide-react';
import { buttonClasses } from '../ds/Button';
import { DIALOG_TITLE, HAIRLINE, MUTED, OVERLAY, RADIUS_CONTROL, RADIUS_PANEL, SCRIM, Z } from '../chat/studioDesign';

// Every choice here spends or waits on tokens: the buttons stay ink (the primary) and outline, with no colour beside
// the token figures.
const CHOICE = 'w-full';

type LimitOptions = {
  canUpgrade?: boolean;
  canAddCredits?: boolean;
  canWaitForReset?: boolean;
  recommendedAction?: 'upgrade' | 'add_credits' | 'wait_for_reset';
};

type LimitDetails = {
  reason?: string;
  requiredCt?: number;
  availableCt?: number;
  resetAt?: string;
  options?: LimitOptions;
};

interface LimitExceededModalProps {
  details: LimitDetails;
  onClose: () => void;
  onUpgrade: () => void;
  onAddCredits: () => void;
  onWait: () => void;
}

const fmtCt = (value?: number) => (typeof value === 'number' ? value.toLocaleString() : 'n/a');

export const LimitExceededModal: React.FC<LimitExceededModalProps> = ({
  details,
  onClose,
  onUpgrade,
  onAddCredits,
  onWait
}) => {
  const resetText = details.resetAt
    ? new Date(details.resetAt).toLocaleString()
    : 'next cycle';

  const titleId = useId();
  return (
    <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center overflow-y-auto p-4`}>
      <div role="dialog" aria-labelledby={titleId} className={`${OVERLAY} relative w-full max-w-lg p-6`}>
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'absolute right-3 top-3 text-[var(--ds-muted)]' })}
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="mb-4 flex items-start gap-3 pr-10">
          <div className={`flex size-10 shrink-0 items-center justify-center bg-[var(--ds-well-strong)] text-[var(--ds-ink)] ${RADIUS_CONTROL}`}>
            <AlertTriangle size={18} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 id={titleId} className={DIALOG_TITLE}>Token Limit Reached</h3>
            <p className={`mt-1 text-sm ${MUTED}`}>
              This action needs more Comic Tokens (CT) than your current allowance.
            </p>
          </div>
        </div>

        <div className={`space-y-1 bg-[var(--ds-well)] p-3 text-sm tabular-nums [overflow-wrap:anywhere] ${RADIUS_PANEL} ${HAIRLINE}`}>
          <div><strong>Reason:</strong> {details.reason || 'BILLING_LIMIT_EXCEEDED'}</div>
          <div><strong>Required CT:</strong> {fmtCt(details.requiredCt)}</div>
          <div><strong>Available CT:</strong> {fmtCt(details.availableCt)}</div>
          <div><strong>Reset Time:</strong> {resetText}</div>
        </div>

        <div className="mt-4 grid sm:grid-cols-3 gap-2">
          <button
            type="button"
            onClick={onUpgrade}
            disabled={details.options?.canUpgrade === false}
            className={buttonClasses({ className: CHOICE })}
          >
            <ArrowUpCircle size={16} /> Upgrade
          </button>
          <button
            type="button"
            onClick={onAddCredits}
            disabled={details.options?.canAddCredits === false}
            className={buttonClasses({ variant: 'outline', className: CHOICE })}
          >
            <Coins size={16} /> Add Credits
          </button>
          <button
            type="button"
            onClick={onWait}
            disabled={details.options?.canWaitForReset === false}
            className={buttonClasses({ variant: 'outline', className: CHOICE })}
          >
            <Clock3 size={16} /> Wait Reset
          </button>
        </div>
      </div>
    </div>
  );
};

export default LimitExceededModal;
