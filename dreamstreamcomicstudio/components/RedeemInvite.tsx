import React, { useEffect, useState } from 'react';
import { Ticket, Check, Loader2 } from 'lucide-react';
import { redeemInvite, getInviteStatus } from '../services/invites';

// Compact tester-access redeemer. Lives in the API Configuration tab because
// redeeming an invite unlocks the BYOK testing flow. Self-contained; quietly
// hides nothing — if the user is already a tester it shows a confirmation.
export const RedeemInvite: React.FC = () => {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [isTester, setIsTester] = useState(false);

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
    <div className="border-2 border-black rounded-xl bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <Ticket className="w-4 h-4" />
        <h3 className="font-display text-lg">Tester access</h3>
        {isTester && (
          <span className="ml-auto flex items-center gap-1 text-xs font-bold text-green-700 bg-green-100 border-2 border-green-300 rounded-full px-2 py-0.5">
            <Check className="w-3 h-3" /> Tester
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Have an invite code? Redeem it to join the tester program, then add your own API keys below to try the platform.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleRedeem(); }}
          placeholder="DS-XXXX-XXXX"
          className="flex-1 font-mono border-2 border-black rounded-md px-3 py-2 text-sm bg-slate-50 focus:bg-white focus:outline-none uppercase"
        />
        <button
          onClick={() => void handleRedeem()}
          disabled={!code.trim() || status === 'submitting'}
          className="flex items-center gap-1 text-sm font-bold border-2 border-black rounded-md px-3 py-2 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40"
        >
          {status === 'submitting' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Redeem
        </button>
      </div>
      {message && <div className="mt-2 text-xs font-bold text-slate-700">{message}</div>}
    </div>
  );
};
