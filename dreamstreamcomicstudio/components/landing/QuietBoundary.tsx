/**
 * Keeps the home page standing when a below-the-fold chunk (a demo, the register-interest form) fails to
 * load or throws: it renders `fallback` instead and reports nothing to the reader beyond it. A failed
 * decoration must never take the page with it, and must never reload the page under the reader.
 */
import React from 'react';

interface QuietBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

export class QuietBoundary extends React.Component<QuietBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (typeof console !== 'undefined') console.warn('[home] a section failed to load', error);
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
