// QA scene `auth` (DS-3; the scene contract is in qa/app/index.tsx): the sign-in card as an invited tester meets
// it — the invite notice, the sign-in / sign-up switch and the whole sign-up form (every field, both
// consents, the submit) on the Atlas tokens. The page brings its own <main>. The invite code is synthetic;
// nothing is submitted (the form only acts on submit, and the scene never submits it), so nothing reaches
// the network.

import React from 'react';
import { AuthPage } from '../../../components/AuthPage';
import type { QaAppScene } from '../index';

const noop = () => undefined;

const AuthScene: React.FC = () => <AuthPage onLoginSuccess={noop} onOpenPrivacy={noop} onOpenTerms={noop} pendingInviteCode="DS-QA00-SCNE" />;

const scene: QaAppScene = { id: 'auth', title: 'Sign in and invited sign-up', Scene: AuthScene };
export default scene;
