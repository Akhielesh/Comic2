import React from 'react';
import { AlertTriangle, ArrowUpCircle, Coins, Clock3, X } from 'lucide-react';

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

  return (
    <div className="fixed inset-0 z-[1200] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white border-4 border-black rounded-2xl shadow-comic p-6 relative">
        <button
          type="button"
          className="absolute top-3 right-3 p-1 border-2 border-black rounded bg-white"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 border-2 border-black flex items-center justify-center text-red-700">
            <AlertTriangle size={18} />
          </div>
          <div>
            <h3 className="font-display text-2xl">Token Limit Reached</h3>
            <p className="text-sm text-slate-600 font-comic">
              This action needs more Comic Tokens (CT) than your current allowance.
            </p>
          </div>
        </div>

        <div className="bg-slate-50 border-2 border-black rounded-xl p-3 text-sm space-y-1">
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
            className="border-2 border-black rounded-lg px-3 py-2 font-bold text-sm flex items-center justify-center gap-2 bg-brand-yellow disabled:opacity-40"
          >
            <ArrowUpCircle size={16} /> Upgrade
          </button>
          <button
            type="button"
            onClick={onAddCredits}
            disabled={details.options?.canAddCredits === false}
            className="border-2 border-black rounded-lg px-3 py-2 font-bold text-sm flex items-center justify-center gap-2 bg-white disabled:opacity-40"
          >
            <Coins size={16} /> Add Credits
          </button>
          <button
            type="button"
            onClick={onWait}
            disabled={details.options?.canWaitForReset === false}
            className="border-2 border-black rounded-lg px-3 py-2 font-bold text-sm flex items-center justify-center gap-2 bg-white disabled:opacity-40"
          >
            <Clock3 size={16} /> Wait Reset
          </button>
        </div>
      </div>
    </div>
  );
};

export default LimitExceededModal;
