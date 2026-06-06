// StudioErrorBoundary (enterprise hardening): catches render-time crashes anywhere in the studio
// tree and shows a themed, recoverable panel instead of a white screen. "Try again" re-mounts the
// subtree; "Reload" does a hard refresh; "Back" exits the studio. Errors are logged for debugging.
//
// React error boundaries must be class components; the fallback is a function child so it can use
// the studio theme hook.

import React from 'react';
import { AlertTriangle, RotateCcw, RefreshCw, ArrowLeft, ChevronRight } from 'lucide-react';
import { useStudioTheme } from './themeStore';

const StudioErrorFallback: React.FC<{
  error: Error;
  onReset: () => void;
  onBack?: () => void;
  label?: string;
}> = ({ error, onReset, onBack, label }) => {
  const t = useStudioTheme();
  const [showDetail, setShowDetail] = React.useState(false);
  return (
    <div className={`min-h-screen ${t.bg} ${t.text} flex items-center justify-center p-6`} role="alert">
      <div className={`w-full max-w-md rounded-2xl border ${t.edge} ${t.panel} p-6 text-center`}>
        <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border ${t.edge} ${t.panelAlt}`}>
          <AlertTriangle className="h-7 w-7 text-amber-500" />
        </div>
        <h2 className={`font-display text-xl tracking-wide ${t.text}`}>{label ?? 'Something went wrong'}</h2>
        <p className={`mt-2 text-sm ${t.textDim}`}>
          The studio hit an unexpected error. Your work in this session may be unsaved — try again, or
          reload to recover.
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onReset}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-bold ${t.accentText} ${t.accentBg} ${t.accentBgHover} ${t.focusRing}`}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Try again
          </button>
          <button
            onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}
            className={`inline-flex items-center gap-1.5 rounded-full border ${t.edgeStrong} px-3 py-1.5 text-sm font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reload
          </button>
          {onBack && (
            <button
              onClick={onBack}
              className={`inline-flex items-center gap-1.5 rounded-full border ${t.edge} px-3 py-1.5 text-sm font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
          )}
        </div>

        {error?.message && (
          <div className="mt-4 text-left">
            <button
              onClick={() => setShowDetail((v) => !v)}
              className={`inline-flex items-center gap-1 text-[11px] font-semibold ${t.textFaint} ${t.hover} rounded px-1`}
              aria-expanded={showDetail}
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${showDetail ? 'rotate-90' : ''}`} />
              {showDetail ? 'Hide details' : 'Show details'}
            </button>
            {showDetail && (
              <pre className={`mt-2 max-h-40 overflow-auto rounded-lg border ${t.edge} ${t.panelAlt} p-2.5 text-[11px] ${t.textDim} whitespace-pre-wrap break-words`}>
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

interface StudioErrorBoundaryState {
  error: Error | null;
}

export class StudioErrorBoundary extends React.Component<StudioErrorBoundaryProps, StudioErrorBoundaryState> {
  state: StudioErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StudioErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[studio] render error:', error, info?.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <StudioErrorFallback
          error={this.state.error}
          onReset={this.reset}
          onBack={this.props.onBack}
          label={this.props.label}
        />
      );
    }
    return this.props.children;
  }
}
