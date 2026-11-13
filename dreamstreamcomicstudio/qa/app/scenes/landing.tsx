// Signed-out Comic Studio landing, with the bundled sample reader and local-only navigation callbacks.

import React from 'react';
import { ComicsLanding } from '../../../components/comicshost/ComicsLanding';
import type { QaAppScene } from '../index';

const noop = () => undefined;

const LandingScene: React.FC = () => (
  <ComicsLanding
    signedIn={false}
    onSignIn={noop}
    onRequestAccess={noop}
    onOpenComics={noop}
    onBrowseGallery={noop}
    onOpenPrivacy={noop}
    onOpenTerms={noop}
  />
);

const scene: QaAppScene = { id: 'landing', title: 'Comics landing (signed out)', Scene: LandingScene };
export default scene;
