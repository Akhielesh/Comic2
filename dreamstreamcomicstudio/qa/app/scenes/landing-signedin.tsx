// Signed-in Comic Studio landing. Navigation callbacks stay local to the QA harness.

import React from 'react';
import { ComicsLanding } from '../../../components/comicshost/ComicsLanding';
import { AccountProvider, type AccountContextValue } from '../../../components/account/AccountContext';
import { useAccountSettingsListener } from '../../../components/account/accountNav';
import type { QaAppScene } from '../index';

const noop = () => undefined;
/** The account menu's person, as App fills it (invented). */
const ACCOUNT: AccountContextValue = { person: { id: 'qa-person', name: 'Rowan Vale', initial: 'R', username: 'rowan_draws', avatarUrl: null }, staff: false, onSignedOut: noop };

const LandingSignedInScene: React.FC = () => {
  // The account menu's rows are answered here, so nothing navigates away from the scene.
  useAccountSettingsListener(noop);
  return (
    <AccountProvider value={ACCOUNT}>
      <ComicsLanding
        signedIn
        onSignIn={noop}
        onRequestAccess={noop}
        onOpenComics={noop}
        onBrowseGallery={noop}
        onOpenPrivacy={noop}
        onOpenTerms={noop}
      />
    </AccountProvider>
  );
};

const scene: QaAppScene = { id: 'landing-signedin', title: 'Comics landing (signed in)', Scene: LandingSignedInScene };
export default scene;
