// "Finish signing in?" — shown when a sign-in link reaches Stream Studio that this browser
// didn't ask for (consumeAuthReturn returned `{ confirm: true }`). Anyone can make a sign-in
// link for their own account; without this step, opening one would silently sign the visitor
// in to someone else's account. A link from another device still works: one tap.
//
// It says who is signed in now and what continuing does to their data here: a switch to
// another account removes this device's Stream Studio data for the current one (alerts,
// nursery setup — live/accountPurge.ts). The link's account fills in when it can be known
// (older #access_token links), without holding the question up.
import { useEffect, useState } from 'react';
import type { AuthReturnConfirm } from '../account';
import { Icon } from '../ui/icons';
import { Btn } from '../ui/primitives';

const TARGET = { minHeight: 44 } as const;
const strong = (text: string) => <b style={{ overflowWrap: 'anywhere' }}>{text}</b>;

export function LinkConfirmSheet({
  link,
  currentEmail,
  otherAccountOnDevice = false,
  onContinue,
  onDecline,
}: {
  link: AuthReturnConfirm;
  /** Who is signed in to Stream Studio on this browser right now, if anyone. */
  currentEmail?: string;
  /**
   * Nobody is signed in here, but another account's Stream Studio data is still on this device
   * (ds-live-owner is set — its session ended with its tab): continuing removes it here.
   */
  otherAccountOnDevice?: boolean;
  onContinue: () => Promise<void> | void;
  onDecline: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.resolve(link.email)
      .then((found) => {
        if (live) setEmail(found || null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link]);

  // Escape is "Not now" (never while signing in).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onDecline();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onDecline]);

  const proceed = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  };

  const switches = !!currentEmail && (!email || email.toLowerCase() !== currentEmail.toLowerCase());
  const otherData = !currentEmail && otherAccountOnDevice;

  return (
    <div className="sheet-scrim link-confirm-scrim" role="dialog" aria-modal="true" aria-labelledby="link-confirm-title" aria-describedby="link-confirm-sub">
      <div className="sheet auth-sheet fade-in">
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name="user" size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="link-confirm-title" className="sheet-title serif">Finish signing in?</h2>
            <div id="link-confirm-sub" className="sheet-sub">
              <p style={{ margin: 0 }}>
                This link signs this browser in to Stream Studio{email ? <> as {strong(email)}</> : null}. Continue only if you asked for it.
              </p>
              {switches && currentEmail && (
                <p style={{ margin: '8px 0 0' }}>
                  You’re signed in as {strong(currentEmail)}.{' '}
                  {email ? <>Continuing switches this browser to {strong(email)}</> : <>If this link is for a different account, continuing switches this browser to it</>}
                  , and {currentEmail}’s Stream Studio data on this device (alerts, nursery setup) is removed.
                </p>
              )}
              {otherData && (
                <p style={{ margin: '8px 0 0' }}>
                  Another account’s Stream Studio data is on this browser. Continuing removes it here (that account gets its events
                  back from its cloud copy when it signs in).
                </p>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <Btn variant="solid" size="lg" className="auth-submit" style={TARGET} disabled={busy} autoFocus onClick={() => void proceed()}>
            {busy ? 'One moment…' : 'Continue'}
          </Btn>
          <Btn variant="ghost" size="lg" className="auth-submit" style={TARGET} disabled={busy} onClick={onDecline}>
            Not now
          </Btn>
        </div>
      </div>
    </div>
  );
}
