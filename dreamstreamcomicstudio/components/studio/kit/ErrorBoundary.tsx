// StudioErrorBoundary (enterprise hardening): catches render-time crashes anywhere in the studio
// tree and shows a recoverable panel instead of a white screen. "Try again" re-mounts the
// subtree; "Reload" does a hard refresh; "Back" exits the studio. Errors are logged for debugging.
//
// Built on the DS ErrorBoundary (components/ds) with the DS state look: the error tile, the title
// and words of ErrorState, the DS buttons and the page canvas in both themes. Unlike the DS
// default it can show the error's message behind "Show details", for a creator reporting a bug.

import React from 'react';
import { AlertCircle, ArrowLeft, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, RADIUS_PANEL, STATUS_SURFACE } from '../../chat/studioDesign';
import { Button } from '../../ds/Button';
import { ErrorBoundary as DsErrorBoundary } from '../../ds/ErrorBoundary';
import { STATE_DESCRIPTION, STATE_TITLE, StateIconTile } from '../../ds/stateParts';

const StudioErrorFallback: React.FC<{
  error: Error;
  onReset: () => void;
  onBack?: () => void;
  label?: string;
}> = ({ error, onReset, onBack, label }) => {
  const [showDetail, setShowDetail] = React.useState(false);
  return (
    <div data-slot="studio-error" className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] p-6 text-[var(--ds-ink)]" role="alert">
      <div className={cn('flex w-full max-w-md flex-col items-center border px-6 py-10 text-center', RADIUS_PANEL, STATUS_SURFACE.error)}>
        <StateIconTile tone="error">
          <AlertCircle />
        </StateIconTile>
        <h2 className={STATE_TITLE}>{label ?? 'Something went wrong'}</h2>
        <p className={cn(STATE_DESCRIPTION, 'mt-2')}>
          The studio hit an unexpected error. Your work in this session may be unsaved — try again, or
          reload to recover.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onReset}>
            <RotateCcw aria-hidden="true" /> Try again
          </Button>
          <Button variant="outline" onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}>
            <RefreshCw aria-hidden="true" /> Reload
          </Button>
          {onBack && (
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft aria-hidden="true" /> Back
            </Button>
          )}
        </div>

        {error?.message && (
          <div className="mt-5 w-full text-left">
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-[var(--ds-radius-sm,0.25rem)] px-1 text-[11px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] coarse:min-h-[var(--ds-density-touch)] ${FOCUS_RING}`}
              aria-expanded={showDetail}
            >
              <ChevronRight aria-hidden="true" className={cn('h-3 w-3 transition-transform duration-[var(--ds-motion-fast,120ms)] motion-reduce:transition-none', showDetail && 'rotate-90')} />
              {showDetail ? 'Hide details' : 'Show details'}
            </button>
            {showDetail && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[var(--ds-radius-control,0.75rem)] border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-2.5 text-[11px] text-[var(--ds-muted)]">
                {error.message}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

interface StudioErrorBoundaryProps {
  children: React.ReactNode;
  onBack?: () => void;
  label?: string;
}

const logStudioError = (error: Error, info: React.ErrorInfo): void => {
  // eslint-disable-next-line no-console
  console.error('[studio] render error:', error, info?.componentStack);
};

export class StudioErrorBoundary extends React.Component<StudioErrorBoundaryProps> {
  render(): React.ReactNode {
    return (
      <DsErrorBoundary
        onError={logStudioError}
        fallback={({ error, reset }) => <StudioErrorFallback error={error} onReset={reset} onBack={this.props.onBack} label={this.props.label} />}
      >
        {this.props.children}
      </DsErrorBoundary>
    );
  }
}
