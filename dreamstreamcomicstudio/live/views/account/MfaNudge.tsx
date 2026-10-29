// "Protect your nursery with two-step sign-in" — shown to a parent without it, on the baby
// monitor's list and hub (so right after creating a nursery, which lands on its hub). Never on
// the camera or watch screens: nothing may cover the monitor. "Not now" holds it back 30 days.
import { useEffect, useState } from 'react';
import { useAccount } from '../../account';
import { listNurseries } from '../../monitor/client';
import { Icon } from '../../ui/icons';
import { Btn } from '../../ui/primitives';
import './account.css';

export const NUDGE_KEY = 'ds-mfa-nudge-dismissed';
export const NUDGE_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function snoozed(now: number): boolean {
  try {
    const at = Number(localStorage.getItem(NUDGE_KEY));
    return Number.isFinite(at) && at > 0 && now - at < NUDGE_SNOOZE_MS;
  } catch {
    return false;
  }
}

/**
 * Is this account a parent of any nursery? A yes is remembered for the page; a no is asked again
 * next time (a nursery created since then counts at once).
 */
let parentMemo: { uid: string; parent: Promise<boolean>; yes: boolean } | null = null;
function isParentSomewhere(uid: string): Promise<boolean> {
  if (parentMemo?.uid !== uid || !parentMemo.yes) {
    const memo = {
      uid,
      yes: false,
      parent: listNurseries()
        .then((r) => !!r.ok && (r.nurseries ?? []).some((n) => n.my_role === 'parent'))
        .catch(() => false),
    };
    void memo.parent.then((yes) => (memo.yes = yes));
    parentMemo = memo;
  }
  return parentMemo.parent;
}

/** For tests: forget what was asked. */
export function resetMfaNudge(): void {
  parentMemo = null;
}

export function MfaNudge({ onSetUp }: { onSetUp: () => void }) {
  const account = useAccount();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let live = true;
    setShow(false);
    if (account.status !== 'member' || account.mfa !== false || !account.userId || snoozed(Date.now())) return;
    void isParentSomewhere(account.userId).then((parent) => {
      if (live && parent) setShow(true);
    });
    return () => {
      live = false;
    };
  }, [account.status, account.mfa, account.userId]);

  if (!show) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(NUDGE_KEY, String(Date.now()));
    } catch { /* storage unavailable: it just comes back next time */ }
    setShow(false);
  };
  return (
    <aside className="mfa-nudge fade-in" role="complementary" aria-labelledby="mfa-nudge-title">
      <span className="sec-item-icon"><Icon name="shield" size={16} /></span>
      <div className="mfa-nudge-text">
        <b id="mfa-nudge-title">Protect your nursery</b>
        Turn on two-step sign-in, so a stolen password alone can’t open your camera or add someone to your nursery.
        <div className="mfa-nudge-actions">
          <Btn
            variant="solid"
            size="sm"
            icon="shield"
            onClick={() => {
              setShow(false);
              onSetUp();
            }}
          >
            Set it up
          </Btn>
          <Btn variant="ghost" size="sm" onClick={dismiss}>Not now</Btn>
        </div>
      </div>
    </aside>
  );
}
