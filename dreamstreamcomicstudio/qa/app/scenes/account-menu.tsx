// QA scene `account-menu` (navtheme NT-1; the scene contract is in qa/app/index.tsx): the account menu at the right
// end of a header, as every Comic Studio header mounts it, with its real panel. Variants by query:
//   (default)       signed in: the initial, the panel with Appearance (Paper offered), the Settings rows, Help, Sign out;
//   &state=staff    with the Admin console row;
//   &state=busy     settings stays in the current tab during studio work;
//   &state=signedout  the Appearance button alone;
//   &sheet=1        the panel as the bottom sheet at every width (the ⋯ row inside a comic asks for it);
//   &open=1         the panel opened on load.
// A row's request is answered here (the page shows which tab it asked for), so nothing navigates; Sign out signs the
// scene out. Invented person; nothing reaches the network or spends.

import React, { useEffect, useMemo, useState } from 'react';
import { AccountMenu } from '../../../components/account/AccountMenu';
import { AccountProvider, type AccountContextValue } from '../../../components/account/AccountContext';
import { useAccountSettingsListener } from '../../../components/account/accountNav';
import { useComicTheme } from '../../../components/comicstudio/useComicTheme';
import { ComicStudioBrand } from '../../../components/comicshost/ComicStudioBrand';
import { HEADING, MUTED, TEXT_3XL } from '../../../components/chat/studioDesign';
import { cn } from '../../../lib/utils';
import type { QaAppScene } from '../index';

const param = (key: string): string | null => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(key));

function AccountMenuScene() {
  const state = param('state') ?? 'signedin';
  const [signedIn, setSignedIn] = useState(state !== 'signedout');
  const [last, setLast] = useState<string>('Nothing opened yet.');
  const { theme } = useComicTheme();

  useEffect(() => {
    if (param('open') !== '1') return;
    document.querySelector<HTMLButtonElement>('[data-slot="account-trigger"]')?.click();
  }, []);

  useAccountSettingsListener((tab, opts) => setLast(`Settings opened at "${tab}"${opts.resume ? `, Back resumes ${opts.resume}` : ''}.`));

  const value = useMemo<AccountContextValue>(
    () => ({
      person: signedIn ? { id: 'qa-person', name: 'Rowan Vale', initial: 'R', username: 'rowan_draws', avatarUrl: null } : null,
      staff: state === 'staff',
      onSignedOut: () => {
        setSignedIn(false);
        setLast('Signed out.');
      }
    }),
    [signedIn, state]
  );

  return (
    <AccountProvider value={value}>
      <div data-comic-theme={theme} className="flex min-h-[100dvh] flex-col bg-[var(--ds-canvas)] text-[var(--ds-ink)]">
        <header className="flex h-14 items-center gap-2 border-b border-[var(--ds-hairline-soft)] px-2 medium:px-3">
          <ComicStudioBrand onHome={() => undefined} />
          <span className="flex-1" />
          <AccountMenu paper resume="new-comic" presentation={param('sheet') === '1' ? 'sheet' : 'anchored'} />
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
          <h1 className={cn(TEXT_3XL, HEADING)}>Account menu</h1>
          <p className={cn('mt-2 text-[length:var(--ds-text-base)]', MUTED)} data-qa-account-last>
            {last}
          </p>
        </main>
      </div>
    </AccountProvider>
  );
}

const scene: QaAppScene = { id: 'account-menu', title: 'Account menu: signed out, signed in, staff, busy; anchored and sheet', Scene: AccountMenuScene };
export default scene;
