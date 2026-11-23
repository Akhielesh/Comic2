import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getMemberReferral } from '../services/memberReferrals';
import { Button, FIELD_LABEL, Input } from './ds';
import { INK, MUTED } from './chat/studioDesign';

export function InviteFriends() {
  const { user } = useAuth();
  return user ? <MemberReferralCard key={user.id} ownerId={user.id} /> : null;
}

function MemberReferralCard({ ownerId }: { ownerId: string }) {
  const [referral, setReferral] = useState<Awaited<ReturnType<typeof getMemberReferral>> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [feedback, setFeedback] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    getMemberReferral(ownerId, controller.signal).then(result => {
      if (!controller.signal.aborted) { setReferral(result); setStatus('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setStatus('failed'); });
    return () => controller.abort();
  }, [ownerId, attempt]);

  const copy = async () => {
    if (!referral) return;
    try {
      await navigator.clipboard.writeText(referral.url);
      setFeedback('Link copied.');
    } catch {
      field.current?.focus();
      field.current?.select();
      setFeedback('Your link is selected. Use your device’s Copy command.');
    }
  };
  const share = async () => {
    if (!referral || !navigator.share) return;
    try { await navigator.share({ title: 'Join Comic Studio', url: referral.url }); }
    catch (err) { if ((err as Error)?.name !== 'AbortError') void copy(); }
  };
  return (
    <div className="space-y-3 p-4">
      <p className={`text-sm ${MUTED}`}>Share your link with someone who’d like to make a comic. Each new account counts once, after verification.</p>
      {status === 'loading' && <p className={`text-sm ${MUTED}`}>Loading your link…</p>}
      {status === 'failed' && <div className="flex flex-wrap items-center gap-2">
        <p className={`text-sm ${MUTED}`}>Your link is temporarily unavailable.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(n => n + 1)}>Try again</Button>
      </div>}
      {referral && <>
        <label htmlFor={id} className={FIELD_LABEL}>Your referral link</label>
        <Input id={id} ref={field} readOnly value={referral.url} onFocus={e => e.currentTarget.select()} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => void copy()}>{feedback === 'Link copied.' ? <Check size={14} /> : <Copy size={14} />}Copy link</Button>
          {typeof navigator.share === 'function' && <Button type="button" size="sm" variant="outline" onClick={() => void share()}><Share2 size={14} />Share link</Button>}
          {feedback && <p role="status" className={`text-xs ${MUTED}`}>{feedback}</p>}
        </div>
        <p className={`border-t border-[var(--ds-hairline)] pt-3 text-sm ${INK}`}><strong className="tabular-nums">{referral.verifiedSignups.toLocaleString()}</strong> verified {referral.verifiedSignups === 1 ? 'signup' : 'signups'} · <span className={MUTED}>Rewards coming soon</span></p>
      </>}
    </div>
  );
}
