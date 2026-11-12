import React, { Component, ErrorInfo, ReactNode } from 'react';
import { captureEvent } from '../../services/telemetry';
import { FeedbackButtons } from '../feedback/FeedbackButtons';
import { ErrorBoundary as DsErrorBoundary } from '../ds/ErrorBoundary';
import { ErrorState } from '../ds/ErrorState';

interface Props {
    children: ReactNode;
}

/** Record the crash so "every failed log" is captured, with enough context (message + stacks) to reconstruct it. */
export const reportAppCrash = (error: Error, errorInfo: ErrorInfo): void => {
    console.error('Uncaught error:', error, errorInfo);
    captureEvent({
        eventType: 'app_crash',
        severity: 'critical',
        source: 'client',
        message: error.message,
        metadata: {
            name: error.name,
            stack: typeof error.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
            componentStack: errorInfo.componentStack?.slice(0, 4000)
        }
    });
};

/**
 * What the whole app shows when a render crashes below the root: the DS error state, centred on the page in
 * both themes, in plain words and with the one way out (reload), plus a quiet "Helpful?" so the person can say
 * what they were doing. The error's message and stack go to telemetry, never onto the screen.
 */
export const AppCrashScreen: React.FC<{ error: Error }> = ({ error }) => (
    <div data-slot="app-crash" className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] p-4 text-[var(--ds-ink)]">
        <div className="w-full max-w-md">
            <ErrorState
                as="h2"
                title="Something went wrong"
                description="DreamStream hit an unexpected error. Reload the page to pick up where you left off."
                retryLabel="Reload"
                onRetry={() => window.location.reload()}
            />
            <div className="mt-4 flex justify-center">
                <FeedbackButtons targetType="app_crash" source="client" metadata={{ message: error.message }} />
            </div>
        </div>
    </div>
);

/**
 * The app's root boundary: the DS ErrorBoundary (components/ds) with the crash report and the full-page
 * AppCrashScreen.
 */
export class ErrorBoundary extends Component<Props> {
    public render() {
        return (
            <DsErrorBoundary onError={reportAppCrash} fallback={({ error }) => <AppCrashScreen error={error} />}>
                {this.props.children}
            </DsErrorBoundary>
        );
    }
}
