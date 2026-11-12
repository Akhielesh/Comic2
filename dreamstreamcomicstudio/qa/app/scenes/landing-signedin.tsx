// QA scene `landing-signedin` (the scene contract is in qa/app/index.tsx): the comics host's front page as a
// signed-in visitor sees it — "Open your comics" on the ink primary (no spark), "Browse the Library", My comics in
// the header and the footer. The page brings its own <main>. Every handler is a no-op: nothing here navigates,
// reaches the network or spends.

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
