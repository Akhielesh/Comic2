import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from './Button';

type AuthCallbackStatus = 'verifying' | 'success' | 'error';

interface AuthCallbackPageProps {
  status: AuthCallbackStatus;
  message?: string;
  flowType?: 'magiclink' | 'recovery' | 'signup' | 'unknown';
  onContinue: () => void;
}

export const AuthCallbackPage: React.FC<AuthCallbackPageProps> = ({
  status,
  message,
  flowType = 'unknown',
  onContinue
}) => {
  const title =
    status === 'verifying'
      ? 'Verifying Link'
      : status === 'success'
        ? flowType === 'recovery'
          ? 'Recovery Verified'
          : 'Authentication Complete'
        : 'Link Verification Failed';

  const description =
    message ||
    (status === 'verifying'
      ? 'Please wait while we verify your secure sign-in link.'
      : status === 'success'
        ? 'Your session is ready.'
        : 'This link is invalid or expired. Request a new one and try again.');

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md w-full bg-white border-4 border-black rounded-2xl shadow-comic p-8 text-center">
        <div className="flex justify-center mb-4">
          {status === 'verifying' && <Loader2 className="w-10 h-10 animate-spin text-brand-blue" />}
          {status === 'success' && <CheckCircle2 className="w-10 h-10 text-green-600" />}
          {status === 'error' && <AlertTriangle className="w-10 h-10 text-red-600" />}
        </div>

        <h1 className="font-display text-3xl text-black mb-2">{title}</h1>
        <p className="text-sm font-semibold text-slate-600">{description}</p>

        {status !== 'verifying' && (
          <div className="mt-6">
            <Button onClick={onContinue} className="w-full">
              {status === 'success' ? 'Continue' : 'Back to Sign In'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
