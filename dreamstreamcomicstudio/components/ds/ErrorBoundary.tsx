/**
 * ErrorBoundary — keeps one broken part from blanking the whole screen. A render error below it shows
 * the ErrorState (role="alert", "Something went wrong" and Try again, which renders the children again)
 * or your own `fallback`; `onError` hears every caught error (report it there — the primitive itself
 * imports no service), and a change in `resetKeys` (the route, the open comic) clears it. It never shows
 * the error's message or stack to the person.
 */
import React from 'react';
import { ErrorState } from './ErrorState';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Shown instead of the default ErrorState; a function also gets the error and `reset`. */
  fallback?: React.ReactNode | ((props: ErrorBoundaryFallbackProps) => React.ReactNode);
  /** Every caught error, with React's component stack. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** When any of these change, a caught error is cleared and the children render again. */
  resetKeys?: readonly unknown[];
  /** The default fallback's words. */
  title?: string;
  description?: string;
  variant?: 'panel' | 'inline';
}

interface State {
  error: Error | null;
}

const changed = (a: readonly unknown[] = [], b: readonly unknown[] = []) => a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    this.props.onError?.(error instanceof Error ? error : new Error(String(error)), info);
  }

  componentDidUpdate(prev: ErrorBoundaryProps, prevState: State) {
    // Only an error caught in an EARLIER update is cleared: when the keys change and the new children
    // crash in the same update, clearing at once would render them again and catch (and report) twice.
    if (prevState.error !== null && this.state.error && changed(prev.resetKeys, this.props.resetKeys)) this.reset();
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback, title, description, variant } = this.props;
    if (typeof fallback === 'function') return fallback({ error, reset: this.reset });
    if (fallback !== undefined) return fallback;
    return (
      <ErrorState
        title={title ?? 'Something went wrong'}
        description={description ?? 'This part of the page stopped working. Try again; if it keeps happening, reload the page.'}
        onRetry={this.reset}
        variant={variant}
      />
    );
  }
}
