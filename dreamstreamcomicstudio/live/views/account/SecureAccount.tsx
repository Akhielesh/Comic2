// "Not you? Secure my account" — where the link in a new-sign-in email lands
// (`<Stream Studio>#/secure/<token>`, email-worker/src/securityAlert.ts). ADR 0006 D6.2 / D6.4:
// "Not you?" ends every session, signs out devices added since that sign-in and starts a password
// reset. The token rides in the #fragment, so it never reaches a server log or a Referer; LiveApp
// takes it out of the address bar before this page renders.
//
// Nothing happens until the person taps "Secure my account": mail scanners and link previews open
// links too, and a page that acted on load would sign people out because a scanner looked at it.
import { useState } from 'react';
import { SECURE_TOKEN, failed, openAuth, secureAccount, type SecureAccountFailure, type SecureAccountResult } from '../../account';
import type { Nav } from '../../nav';
import { Icon } from '../../ui/icons';
import { StreamStudioLogo } from '../../ui/logo';
import { Btn } from '../../ui/primitives';
import './account.css';

type Stage = { kind: 'ask' } | { kind: 'working' } | { kind: 'done'; r: SecureAccountResult } | { kind: 'failed'; f: SecureAccountFailure };

export function SecureAccount({ token, nav }: { token: string; nav: Nav }) {
  const valid = SECURE_TOKEN.test(token);
  const [stage, setStage] = useState<Stage>({ kind: 'ask' });

  const go = async () => {
    setStage({ kind: 'working' });
    const r = await secureAccount(token);
    setStage(failed(r) ? { kind: 'failed', f: r } : { kind: 'done', r });
  };

  return (
    <main className="secure-page">
      <div className="card card-pad secure-card">
        <div style={{ marginBottom: 14 }}><StreamStudioLogo /></div>
        {!valid ? (
          <>
            <h1 className="serif">This link isn’t complete</h1>
            <p className="lead">Open the “Not you? Secure my account” button straight from the email again — copying part of the link loses the code it carries.</p>
            <div className="secure-actions">
              <Btn variant="solid" icon="shield" onClick={() => nav.settings()}>Security settings</Btn>
            </div>
          </>
        ) : stage.kind === 'ask' || stage.kind === 'working' ? (
          <>
            <h1 className="serif">Secure your account?</h1>
            <p className="lead">We emailed you about a new sign-in to your DreamStream account. If it wasn’t you, securing your account will:</p>
            <ul className="secure-list">
              <li>Sign out every device and browser signed in to your account — including this one, and a phone running as a nursery camera (sign in on it again afterwards).</li>
              <li>Sign out any phone or watch added since that sign-in.</li>
              <li>Email you a link to choose a new password.</li>
            </ul>
            <p className="lead">If it was you, there’s nothing to do — you can close this page.</p>
            <div className="secure-actions">
              <Btn variant="solid" size="lg" icon="shield" disabled={stage.kind === 'working'} onClick={() => void go()}>
                {stage.kind === 'working' ? 'Securing your account…' : 'Secure my account'}
              </Btn>
              <Btn variant="ghost" size="lg" disabled={stage.kind === 'working'} onClick={() => nav.dashboard()}>It was me</Btn>
            </div>
          </>
        ) : stage.kind === 'done' ? (
          <Done r={stage.r} nav={nav} />
        ) : (
          <>
            <h1 className="serif">{stage.f.code === 'used' ? 'Already secured' : stage.f.code === 'expired' ? 'This link has expired' : 'That didn’t work'}</h1>
            <div className={stage.f.code === 'used' ? 'banner info' : 'banner err'} role="alert" style={{ marginBottom: 14 }}>
              <Icon name={stage.f.code === 'used' ? 'info' : 'alert'} size={15} />
              <span>{stage.f.message}</span>
            </div>
            <div className="secure-actions">
              {stage.f.code === 'unreachable' || stage.f.code === 'unavailable' || stage.f.code.startsWith('http_') ? (
                <Btn variant="solid" icon="refresh" onClick={() => void go()}>Try again</Btn>
              ) : (
                <Btn variant="solid" icon="lock" onClick={() => openAuth('reset')}>Forgot password</Btn>
              )}
              <Btn variant="ghost" onClick={() => nav.settings()}>Security settings</Btn>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Done({ r, nav }: { r: SecureAccountResult; nav: Nav }) {
  const sessions =
    !r.signedOutEverywhere
      ? 'We couldn’t sign every device out just now. Sign in and use “Sign out everywhere” in Settings → Security.'
      : r.sessionsEnded != null
        ? `Every device was signed out (${r.sessionsEnded} ${r.sessionsEnded === 1 ? 'session' : 'sessions'}).`
        : 'Every device was signed out.';
  const sockets = r.kicked
    ? 'Monitors and calls that were open were disconnected.'
    : 'A monitor or call already open on another device may stay connected until it reconnects — if you see one you don’t recognise, remove that person from the nursery.';
  const reset =
    r.resetEmail === 'sent'
      ? `We emailed a link to choose a new password${r.emailHint ? ` to ${r.emailHint}` : ''}.`
      : r.resetEmail === 'throttled'
        ? `We sent a password link${r.emailHint ? ` to ${r.emailHint}` : ''} a moment ago — use that one (check spam too).`
        : 'We couldn’t send the password email. Use “Forgot password” to choose a new password.';
  return (
    <div className="secure-result">
      <h1 className="serif">Your account is secured</h1>
      <ul className="secure-list">
        <li>{sessions}{r.thisDevice ? ' This browser is signed out too.' : ''}</li>
        {r.devicesRevoked > 0 && <li>{r.devicesRevoked === 1 ? 'One phone or watch' : `${r.devicesRevoked} phones or watches`} added since that sign-in {r.devicesRevoked === 1 ? 'was' : 'were'} signed out.</li>}
        <li>{sockets}</li>
        <li>{reset}</li>
      </ul>
      <p className="lead" style={{ marginBottom: 4 }}>
        Next: choose a new password, then check each nursery’s People list and remove anyone you don’t recognise. Turning on
        two-step sign-in (Settings → Security) stops a password alone from getting in again.
      </p>
      <div className="secure-actions">
        {r.resetEmail === 'sent' || r.resetEmail === 'throttled' ? (
          <Btn variant="solid" icon="user" onClick={() => openAuth('signin')}>Sign in</Btn>
        ) : (
          <Btn variant="solid" icon="lock" onClick={() => openAuth('reset')}>Forgot password</Btn>
        )}
        <Btn variant="ghost" onClick={() => nav.dashboard()}>Go to Stream Studio</Btn>
      </div>
    </div>
  );
}
