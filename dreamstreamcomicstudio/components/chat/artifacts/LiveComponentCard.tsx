import React, { lazy, Suspense, useState } from 'react';
import { Play, Code2, Eye, Loader2 } from 'lucide-react';
import type { ReactComponentArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Badge, useCompact } from './kit';

// Renders a bespoke, model-/MCP-authored React component. The code runs in Sandpack's
// SANDBOXED iframe (loaded only on tap — no silent execution, and the heavy bundler
// chunk ships only when wanted). A Code view exposes the exact TSX. This is the safe,
// in-house core of "custom widgets on demand": the model writes a real component today;
// a 21st.dev/shadcn MCP can generate that TSX tomorrow — both land here unchanged.

const LiveComponentSandbox = lazy(() => import('./LiveComponentSandbox'));

const ACCENT = '#8b5cf6';

export const LiveComponentCard: React.FC<{ data: ReactComponentArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const height = Math.max(160, Math.min(720, data.height ?? 320));
  const hasCode = typeof data.code === 'string' && data.code.trim().length > 0;
  const lineCount = hasCode ? data.code.split('\n').length : 0;

  // Compact: a glance — header + a one-line summary (don't load the heavy sandbox).
  if (compact) {
    return (
      <Surface
        accent={ACCENT}
        header={
          <>
            <SurfaceTitle>{data.title || 'Custom component'}</SurfaceTitle>
            {data.description && <SurfaceSubtitle>{data.description}</SurfaceSubtitle>}
          </>
        }
        right={<Badge color={ACCENT}>React · sandboxed</Badge>}
      >
        <p className="px-3 pb-3 text-[11px] text-[var(--ds-muted)]">
          {hasCode ? `Interactive React widget · ${lineCount} lines · expand to run the live preview.` : 'No component code was provided.'}
        </p>
      </Surface>
    );
  }

  return (
    <Surface
      accent={ACCENT}
      header={
        <>
          <SurfaceTitle>{data.title || 'Custom component'}</SurfaceTitle>
          {data.description && <SurfaceSubtitle>{data.description}</SurfaceSubtitle>}
        </>
      }
      right={<Badge color={ACCENT}>React · sandboxed</Badge>}
    >
      {!hasCode ? (
        <p className="px-3 pb-3 text-[11px] text-[var(--ds-muted)]">No component code was provided.</p>
      ) : (
        <>
          <div className="px-3 pb-2">
            <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5 text-[11px] font-semibold">
              {([['preview', Eye, 'Preview'], ['code', Code2, 'Code']] as const).map(([id, Icon, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 transition-all duration-200 ${
                    tab === id ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>

          {tab === 'preview' ? (
            <div className="px-3 pb-3">
              {running ? (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]" style={{ height }}>
                      <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-accent)]" />
                    </div>
                  }
                >
                  <div className="overflow-hidden rounded-xl border border-[var(--ds-hairline)]">
                    <LiveComponentSandbox code={data.code} height={height} dependencies={data.dependencies} />
                  </div>
                </Suspense>
              ) : (
                <button
                  onClick={() => setRunning(true)}
                  className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] py-10 text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-full text-white" style={{ backgroundColor: ACCENT }}>
                    <Play className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-semibold">Run component</span>
                  <span className="text-[11px] text-[var(--ds-muted)]">Runs in a sandboxed iframe — it can’t access your data.</span>
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 pb-3">
              <pre className="max-h-[440px] overflow-auto rounded-xl bg-[var(--ds-well-strong)] p-3 text-[11px] leading-snug text-[var(--ds-ink)]">
                <code className="font-mono">{data.code}</code>
              </pre>
            </div>
          )}
        </>
      )}
    </Surface>
  );
};
