// QA scene `landing` (the scene contract is in qa/app/index.tsx): the comics host’s front page as a
// signed-out visitor first sees it — the Atlas public composition in paper and ink, the studio replica and the
// procedural comic pages, and the one spark call to action ("Start creating"). The page brings its own <main>. Every
// handler is a no-op: nothing here navigates, reaches the network or spends.

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
