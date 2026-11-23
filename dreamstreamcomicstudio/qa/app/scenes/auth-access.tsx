// Public account creation on the Atlas auth surface.
import React from 'react';
import { AuthPage } from '../../../components/AuthPage';
import type { QaAppScene } from '../index';

const noop = () => undefined;
const googleAvailableInFixture = async () => true;

const AuthAccessScene: React.FC = () => <AuthPage onLoginSuccess={noop} onOpenPrivacy={noop} onOpenTerms={noop} initialMode="signup" checkGoogleAvailability={googleAvailableInFixture} />;

const scene: QaAppScene = { id: 'auth-access', title: 'Create your account', Scene: AuthAccessScene };
export default scene;
