// Signed-in Comic Studio landing. Navigation callbacks stay local to the QA harness.

import React from 'react';
import { ComicsLanding } from '../../../components/comicshost/ComicsLanding';
import type { QaAppScene } from '../index';

const noop = () => undefined;

const LandingSignedInScene: React.FC = () => (
  <ComicsLanding
    signedIn
    onSignIn={noop}
    onRequestAccess={noop}
    onOpenComics={noop}
    onBrowseGallery={noop}
    onOpenPrivacy={noop}
    onOpenTerms={noop}
  />
);

const scene: QaAppScene = { id: 'landing-signedin', title: 'Comics landing (signed in)', Scene: LandingSignedInScene };
export default scene;
