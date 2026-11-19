// Signed-in public Comic Studio chrome, with reversible navigation and account actions.
import React, { useState } from 'react';
import { ComicsHeader } from '../../../components/comicshost/ComicsHeader';
import { useComicTheme } from '../../../components/comicstudio/useComicTheme';
import { Button } from '../../../components/ds/Button';
import { AccountProvider, type AccountContextValue } from '../../../components/account/AccountContext';
import { useAccountSettingsListener } from '../../../components/account/accountNav';
import type { QaAppScene } from '../index';

/** The account menu's person, as App fills it (invented). */
const ACCOUNT: AccountContextValue = { person: { id: 'qa-person', name: 'Rowan Vale', initial: 'R', username: 'rowan_draws', avatarUrl: null }, staff: false, onSignedOut: () => undefined };

function ComicsNavigationScene() {
  const [view, setView] = useState<'Library' | 'Home' | 'My comics' | 'Account settings'>('Library');
  const { theme } = useComicTheme();
  // The account menu's rows open Settings here (in the app, the same request goes to App).
  useAccountSettingsListener(() => setView('Account settings'));
  return (
    <AccountProvider value={ACCOUNT}>
    <div data-comic-theme={theme} className="flex min-h-screen flex-col bg-[var(--ds-canvas)] text-[var(--ds-ink)]">
      <ComicsHeader
        signedIn
        page={view === 'Home' ? 'home' : 'other'}
        current={view === 'Library' ? 'gallery' : 'other'}
        onGoHome={() => setView('Home')}
        onBrowseGallery={() => setView('Library')}
        onOpenComics={() => setView('My comics')}
        onSignIn={() => undefined}
        onRequestAccess={() => undefined}
      />
      <main className="comics-shell-width flex-1 py-8">
        <h1 className="text-[length:var(--ds-text-3xl)] font-semibold">{view}</h1>
        <p className="mt-3 text-[var(--ds-muted)]">Comic Studio navigation stays available before and after sign-in.</p>
        <Button className="comics-primary-action mt-6" onClick={() => setView(view === 'Library' ? 'My comics' : 'Library')}>
          {view === 'Library' ? 'Create a comic' : 'Back to Library'}
        </Button>
      </main>
    </div>
    </AccountProvider>
  );
}

export default { id: 'comics-navigation', title: 'Comic Studio navigation and account access', Scene: ComicsNavigationScene } satisfies QaAppScene;
