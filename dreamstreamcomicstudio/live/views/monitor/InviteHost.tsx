// Mounted once by the app shell: `openInvite(nid, tab?)` from anywhere opens
// the Invite sheet. The sheet itself (and its QR encoder) loads on demand, so
// stream viewers never download it. Focus goes back to whatever opened it.
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { registerInviteOpener, type InviteTab } from '../../monitor/invite';
import type { PushToast } from '../../ui/primitives';

const InviteSheet = lazy(() => import('./InviteSheet').then((m) => ({ default: m.InviteSheet })));

export function InviteHost({ push }: { push: PushToast }) {
  const [open, setOpen] = useState<{ nid: string; tab?: InviteTab; from: HTMLElement | null; n: number } | null>(null);

  useEffect(() => {
    registerInviteOpener((nid, tab, from) =>
      // Opening again while open (another tab, say) keeps the original return point.
      setOpen((o) => (o && o.nid === nid ? { ...o, tab, n: o.n + 1 } : { nid, tab, from, n: 0 })),
    );
    return () => registerInviteOpener(null);
  }, []);

  if (!open) return null;
  const close = () => {
    const from = open.from;
    setOpen(null);
    window.setTimeout(() => {
      if (from?.isConnected) from.focus();
    }, 0);
  };
  return (
    <Suspense fallback={null}>
      <InviteSheet key={open.nid} nid={open.nid} initialTab={open.tab} tabRequest={open.n} onClose={close} push={push} />
    </Suspense>
  );
}
