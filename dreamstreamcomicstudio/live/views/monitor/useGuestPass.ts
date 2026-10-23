// The guest pass this device holds for a nursery — unless the signed-in
// account is a member of it: then the account wins (it carries their real
// role and never runs out), and the stale pass is cleared.
import { useEffect, useState } from 'react';
import { useAccount } from '../../account';
import { listNurseries } from '../../monitor/client';
import { clearGuest, loadGuest, type GuestPass } from '../../monitor/guest';

export function useGuestPass(nid: string): [GuestPass | null, (g: GuestPass | null) => void] {
  const account = useAccount();
  const [guest, setGuest] = useState(() => loadGuest(nid));
  useEffect(() => {
    if (!guest || account.status !== 'member') return;
    let alive = true;
    void listNurseries().then((r) => {
      if (!alive || !r.ok || !r.nurseries?.some((n) => n.id === nid)) return;
      clearGuest(nid);
      setGuest(null);
    });
    return () => {
      alive = false;
    };
  }, [guest, account.status, nid]);
  return [guest, setGuest];
}
