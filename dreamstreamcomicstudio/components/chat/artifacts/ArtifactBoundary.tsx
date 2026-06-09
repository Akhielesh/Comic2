import React from 'react';

// Wraps a single rendered artifact so a malformed `data` payload — from any built-in
// tool, a future generative component, or an external MCP server — degrades to a small
// inline notice instead of blanking the entire chat message. `ChatArtifact.data` is
// typed `unknown` and cast at the renderer boundary, so this is the runtime safety net
// for every card (the missing piece called out in the architecture review).

interface Props {
  children: React.ReactNode;
  /** Optional label for the failed artifact (its `type`), used only in the dev console. */
  label?: string;
}
interface State {
  failed: boolean;
}

export class ArtifactBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (typeof console !== 'undefined') {
      console.warn(`[artifact] failed to render${this.props.label ? ` "${this.props.label}"` : ''}:`, error);
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div className="my-2 rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700 animate-fade-in">
          This component couldn’t be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}
