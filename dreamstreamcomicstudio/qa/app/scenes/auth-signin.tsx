// QA scene `auth-signin` (DS-3; the scene contract is in qa/app/index.tsx): the sign-in card most people meet —
// no invite, the password step with "Remember me", "Email me a sign-in link", "Forgot password?" and the
// "Enter Studio" submit, under the Sign in / Request access switch. The page brings its own <main>. Nothing is
// submitted (the form only acts on submit, and the scene never submits it), so nothing reaches the network.
// (The invited sign-up form is scene `auth`; the access request is scene `auth-access`.)

import React from 'react';
import { AuthPage } from '../../../components/AuthPage';
import type { QaAppScene } from '../index';

const noop = () => undefined;

const AuthSignInScene: React.FC = () => <AuthPage onLoginSuccess={noop} onOpenPrivacy={noop} onOpenTerms={noop} />;

const scene: QaAppScene = { id: 'auth-signin', title: 'Sign in (no invite): the password step', Scene: AuthSignInScene };
export default scene;
