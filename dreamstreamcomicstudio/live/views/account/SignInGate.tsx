// What Stream Studio shows instead of a screen the account can't open yet (live/accessGate.ts):
//   splash      — the account isn't known yet: a quiet splash, never the dashboard or a sign-in
//                 screen that would only flash;
//   sign-in     — signed out: sign in (or create an account) with your DreamStream account, the
//                 one Comic Studio and Chat Studio use (AuthSheet does the signing in);
//   needs-code  — signed in, but Stream Studio's private beta still needs the welcome code
//                 (AuthSheet's code step, which also carries the account's name);
//   needs-mfa   — the password was given, the two-step code is still owed (StepUp's sheet, which
//                 opens by itself; this screen stays behind it).
// Nothing of the studio is behind these screens: no dashboard, no events this browser remembers,
// no settings, no tour. Links people were sent never reach here — they open as before.
import React, { useEffect, useRef, useState } from 'react';
import { openAuth, signOutThisDevice, useAccount } from '../../account';
import type { Gate, RouteView } from '../../accessGate';
import { continueWithDreamStream, mainAppUrl } from '@/services/liveLink';
import { STREAM_HOST_ON, screenOfHash } from '@/shared/streamHost';
import { ON_STREAM_HOST } from '../../host';
import { Icon } from '../../ui/icons';
import { LiveLegalLinks } from '../../ui/legalLinks';
import { StreamStudioLogo, StreamStudioMark } from '../../ui/logo';
import { Avatar, Btn, type PushToast } from '../../ui/primitives';
import { askForCode } from './StepUp';
import './account.css';

export type GateScreen = Exclude<Gate, 'open'>;

/** "Sign in with your DreamStream account to open the baby monitor" — what the visitor was opening. */
const OPENING: Partial<Record<RouteView, string>> = {
  create: 'to start a meeting or go live',
  monitor: 'to open the baby monitor',
  nursery: 'to open the baby monitor',
  'monitor-watch': 'to open the baby monitor',
  'monitor-camera': 'to start the nursery camera',
  calls: 'to open your calls',
  studio: 'to open your studio',
  summary: 'to see this recap',
  'summary-lookup': 'to see this recap',
};

export function SignInGate({ gate, view, finishing, push }: {
  gate: GateScreen;
  /** The screen the visitor was opening (it opens by itself once they're in). */
  view: RouteView;
  /** A sign-in link is being finished (the splash says so). */
  finishing?: boolean;
  push: PushToast;
}) {
  if (gate === 'splash') return <GateSplash finishing={finishing} />;
  if (gate === 'needs-code') return <NeedsCode push={push} />;
  if (gate === 'needs-mfa') return <NeedsMfa push={push} />;
  return <SignIn view={view} />;
}

function GateSplash({ finishing }: { finishing?: boolean }) {
  return (
    <main className="gate-page" aria-busy="true">
      <div className="gate-splash" role="status">
        <span aria-hidden="true"><StreamStudioMark size={44} /></span>
        <span className="gate-splash-text">{finishing ? 'Finishing sign-in…' : 'Checking your account…'}</span>
      </div>
    </main>
  );
}

/** The card every gate screen shares. Focus lands on its heading (unless a sheet already has it). */
function GatePage({ title, children, linkNote = true }: { title: string; children: React.ReactNode; linkNote?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="dialog"]')) return;
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <main className="gate-page" aria-labelledby="gate-title">
      <div className="card card-pad gate-card">
        <div className="gate-brand"><StreamStudioLogo /></div>
        <h1 id="gate-title" ref={heading} tabIndex={-1} className="serif">{title}</h1>
        {children}
        {linkNote && (
          <p className="gate-links">
            <Icon name="link" size={15} />
            <span>
              Were you sent a link? Open that link instead — watching a stream or joining a meeting needs only a name, and a
              nursery share link a name and the passcode you were told.
            </span>
          </p>
        )}
      </div>
      <div className="gate-foot">
        <a href={mainAppUrl('/')}>DreamStream home</a>
        <LiveLegalLinks compact />
      </div>
    </main>
  );
}

function SignIn({ view }: { view: RouteView }) {
  const what = OPENING[view];
  // Stream Studio on its own address: one tap brings a DreamStream sign-in over (only the screen
  // travels, never a key — so not from a private studio or recap link, which would be lost).
  const handoff = ON_STREAM_HOST && STREAM_HOST_ON && !new URLSearchParams(location.search).get('e');
  return (
    <GatePage title="Sign in to Stream Studio">
      <p className="lead">
        Sign in with your DreamStream account{what ? ` ${what}` : ''} — the same account you use for Comic Studio and Chat Studio.
      </p>
      <div className="gate-actions">
        <Btn variant="solid" size="lg" icon="user" onClick={() => openAuth('signin')}>Sign in</Btn>
        {handoff && (
          <Btn variant="soft" size="lg" onClick={() => continueWithDreamStream(screenOfHash(location.hash) ?? '')}>
            Continue with DreamStream
          </Btn>
        )}
        <Btn variant="ghost" size="lg" onClick={() => openAuth('create')}>Create account</Btn>
      </div>
      <p className="gate-note">New accounts need a welcome code while Stream Studio is in private beta.</p>
    </GatePage>
  );
}

function useSignOut(push: PushToast): [boolean, () => void] {
  const [busy, setBusy] = useState(false);
  const signOut = () => {
    if (busy) return;
    setBusy(true);
    void signOutThisDevice()
      .then(() => push('Signed out on this device', { icon: 'check' }))
      .finally(() => setBusy(false));
  };
  return [busy, signOut];
}

function NeedsCode({ push }: { push: PushToast }) {
  const account = useAccount();
  const [busy, signOut] = useSignOut(push);
  // The account's name from the other studios (live_me's suggestion) — the code step uses it too.
  const name = account.name || account.suggestedName || '';
  return (
    <GatePage title="One more step">
      <div className="gate-who">
        <Avatar name={name || account.email || 'You'} size={36} />
        <div className="gate-who-text">
          <span className="faint">Signed in as</span>
          <b>{name || account.email || 'your DreamStream account'}</b>
          {name && account.email && <span>{account.email}</span>}
        </div>
      </div>
      <p className="lead">
        Stream Studio is in private beta: your DreamStream account needs the welcome code you were given, once. Then
        hosting, the baby monitor and calls are yours.
      </p>
      <div className="gate-actions">
        <Btn variant="solid" size="lg" icon="lock" onClick={() => openAuth('code')}>Enter your welcome code</Btn>
        <Btn variant="ghost" size="lg" icon="logout" disabled={busy} onClick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</Btn>
      </div>
      <p className="gate-note">
        No code? Ask the person who invited you.{name ? ` You’ll appear as ${name} — you can change it when you enter the code.` : ''}
      </p>
      <p className="gate-sr" role="status">{busy ? 'Signing out…' : ''}</p>
    </GatePage>
  );
}

function NeedsMfa({ push }: { push: PushToast }) {
  const account = useAccount();
  const [busy, signOut] = useSignOut(push);
  return (
    <GatePage title="Finish signing in" linkNote={false}>
      <p className="lead">
        {account.email ? <><b className="gate-email">{account.email}</b> has</> : 'Your account has'} two-step sign-in on. Type the
        6-digit code from your authenticator app to finish signing in to Stream Studio.
      </p>
      <div className="gate-actions">
        <Btn variant="solid" size="lg" icon="shield" onClick={() => void askForCode(undefined, 'signin')}>Enter your code</Btn>
        <Btn variant="ghost" size="lg" icon="logout" disabled={busy} onClick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</Btn>
      </div>
      <p className="gate-note">Lost your phone? Open “Enter your code”, then “Lost your phone?” to use a recovery code.</p>
      <p className="gate-sr" role="status">{busy ? 'Signing out…' : ''}</p>
    </GatePage>
  );
}
