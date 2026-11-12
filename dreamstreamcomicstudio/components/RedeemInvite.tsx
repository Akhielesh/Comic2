import React, { useEffect, useId, useState } from 'react';
import { Check, Ticket } from 'lucide-react';
import { redeemInvite, getInviteStatus } from '../services/invites';
import { Button } from './ds/Button';
import { Input } from './ds/Input';
import { FIELD_LABEL } from './ds/Field';
import { RADIUS_PANEL, SHADOW_SOFT, STATUS_CHIP, STATUS_CHIP_TONE } from './chat/studioDesign';

// Compact tester-access redeemer. Lives in the API Configuration tab because
// redeeming an invite unlocks the BYOK testing flow. Self-contained; quietly
// hides nothing — if the user is already a tester it shows a confirmation.
export const RedeemInvite: React.FC = () => {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [isTester, setIsTester] = useState(false);
  const inputId = `redeem-invite-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    let active = true;
    getInviteStatus().then((s) => { if (active) setIsTester(Boolean(s?.isTester)); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const handleRedeem = async () => {
    if (!code.trim() || status === 'submitting') return;
    setStatus('submitting');
    setMessage(null);
    const res = await redeemInvite(code.trim());
    setMessage(res.message);
    if (res.ok) { setIsTester(true); setCode(''); }
    setStatus('idle');
  };

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className={`${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 text-[var(--ds-ink)] ${SHADOW_SOFT}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Ticket aria-hidden className="size-4 text-[var(--ds-muted)]" />
        <h3 id={`${inputId}-title`} className="text-base font-semibold tracking-tight">
          Tester access
        </h3>
        {isTester && (
          <span className={`ml-auto ${STATUS_CHIP} ${STATUS_CHIP_TONE.healthy}`}>
            <Check aria-hidden className="size-3" /> Tester
          </span>
        )}
      </div>
      <p className="mb-3 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
        Have an invite code? Redeem it to join the tester program, then add your own API keys below to try the platform.
      </p>
      <label htmlFor={inputId} className={`sr-only ${FIELD_LABEL}`}>
        Invite code
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleRedeem(); }}
          placeholder="DS-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          className="min-w-[10rem] flex-1 font-mono uppercase"
        />
        <Button
          variant="outline"
          onClick={() => void handleRedeem()}
          disabled={!code.trim()}
          loading={status === 'submitting'}
        >
          Redeem
        </Button>
      </div>
      {message && (
        <p role="status" className="mt-2 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-ink)]">
          {message}
        </p>
      )}
    </section>
  );
};
