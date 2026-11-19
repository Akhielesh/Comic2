// QA scene `auth-access` (DS-3; the scene contract is in qa/app/index.tsx): the sign-in card on "Register interest"
// while sign-up is closed — the private-beta chip, the note and the register-interest form, with the way back
// to Sign in. The page brings its own <main>. Nothing is submitted (the form only acts on submit, and the scene
// never submits it), so nothing reaches the network.

import React from 'react';
import { AuthPage } from '../../../components/AuthPage';
import type { QaAppScene } from '../index';

const noop = () => undefined;

const AuthAccessScene: React.FC = () => <AuthPage onLoginSuccess={noop} onOpenPrivacy={noop} onOpenTerms={noop} initialMode="request-access" />;

const scene: QaAppScene = { id: 'auth-access', title: 'Register interest (sign-up closed)', Scene: AuthAccessScene };
export default scene;
