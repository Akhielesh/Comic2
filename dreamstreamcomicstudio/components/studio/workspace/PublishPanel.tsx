// PublishPanel — "share & deploy the app you built".
//
// Fixes the gap where a built app couldn't be shared: it gives the user (a) the live preview link
// to share while the container is alive, (b) a deploy-ready bundle download, and (c) a provider-
// agnostic deploy path — Cloudflare Pages / Vercel / Supabase — with real, copy-able commands and
// an honest one-click attempt against the server. Provider-agnostic by design (the user picks).
//
// It never claims a deploy happened that didn't: the one-click button reports the server's true
// status (live / queued / not-enabled-yet), and the manual commands always work as a fallback.

import React, { useEffect, useRef, useState } from 'react';
import {
  X, Share2, Check, Download, Cloud, Rocket, Database, Copy, ExternalLink, Loader2, Terminal,
} from 'lucide-react';
import { useStudioTheme } from '../kit';
import { useDialogA11y } from '../kit/useDialogA11y';
import type { DeployTarget, DeployResult, StudioDeploymentRecord } from '../../../services/studioDeployApi';

/** Compact relative time for deployment timestamps. */
const relTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

interface ProviderMeta {
  id: DeployTarget;
  name: string;
  Icon: React.FC<{ className?: string }>;
  blurb: string;
  /** Real, copy-able shell steps to deploy this project. */
  steps: string[];
  docs: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare Pages',
    Icon: Cloud,
    blurb: 'Fast global static/SPA hosting — the same infra DreamStream already runs on.',
    steps: ['npm install', 'npm run build', 'npx wrangler pages deploy ./dist'],
    docs: 'https://developers.cloudflare.com/pages/',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    Icon: Rocket,
    blurb: 'Zero-config hosting for static + serverless apps, with instant preview URLs.',
    steps: ['npm install -g vercel', 'vercel', 'vercel --prod'],
    docs: 'https://vercel.com/docs/cli',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    Icon: Database,
    blurb: 'Add a real backend — Postgres, auth & edge functions — then host the frontend anywhere.',
    steps: ['npx supabase init', 'npx supabase link --project-ref <ref>', 'npx supabase db push'],
    docs: 'https://supabase.com/docs/guides/cli',
  },
];

const STATUS_TONE: Record<DeployResult['status'], string> = {
  live: 'text-emerald-500',
  queued: 'text-sky-500',
  unavailable: 'text-amber-500',
  error: 'text-rose-500',
};

export interface PublishPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  previewUrl: string | null;
  /** Saved project id — enables fetching deploy history. */
  projectId?: string | null;
  /** The project's last successful deploy URL (permanent link), if any. */
  deployedUrl?: string | null;
  /** Download the project as a deploy-ready .zip. */
  onDownloadZip: () => void;
  /** Attempt the server one-click deploy for a provider (best-effort; reports honest status). */
  onDeploy: (target: DeployTarget) => Promise<DeployResult>;
}

export const PublishPanel: React.FC<PublishPanelProps> = ({ open, onClose, title, previewUrl, projectId, deployedUrl, onDownloadZip, onDeploy }) => {
  const t = useStudioTheme();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(open, onClose); // Esc closes + restores focus
  useEffect(() => { if (open) dialogRef.current?.focus(); }, [open]);
  const [provider, setProvider] = useState<DeployTarget>('cloudflare');
  const [copied, setCopied] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [history, setHistory] = useState<StudioDeploymentRecord[]>([]);

  // Load deploy history when the panel opens (best-effort; dynamic import keeps apiClient lazy).
  useEffect(() => {
    if (!open || !projectId) return;
    let alive = true;
    void (async () => {
      try {
        const { listStudioDeployments } = await import('../../../services/studioDeployApi');
        const list = await listStudioDeployments(projectId);
        if (alive) setHistory(list);
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [open, projectId, result]);

  if (!open) return null;
  const meta = PROVIDERS.find((p) => p.id === provider)!;

  const copy = (key: string, text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1300);
    } catch { /* clipboard unavailable */ }
  };

  const runDeploy = async () => {
    setDeploying(true);
    setResult(null);
    try {
      setResult(await onDeploy(provider));
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Publish & share"
        className={`w-full max-w-xl max-h-[88vh] overflow-auto rounded-xl border ${t.edgeStrong} ${t.panel} ${t.text} shadow-2xl focus:outline-none`}
      >
        <div className={`sticky top-0 z-10 flex items-center gap-2 px-4 py-3 border-b ${t.edge} ${t.panel}`}>
          <Share2 className={`w-4 h-4 ${t.accent}`} />
          <span className="font-bold">Publish &amp; share</span>
          <button onClick={onClose} aria-label="Close" className={`ml-auto rounded-full p-1 ${t.hover} ${t.textDim} ${t.focusRing}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Already deployed → the permanent link, front and center. */}
          {deployedUrl && (
            <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-500 mb-2">Deployed · live</p>
              <div className="flex items-center gap-2">
                <code className={`min-w-0 flex-1 truncate rounded-md border ${t.edge} ${t.panel} px-2.5 py-1.5 font-mono text-[11px] ${t.textDim}`}>{deployedUrl}</code>
                <button
                  onClick={() => copy('deployed', deployedUrl)}
                  className={`shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-500 ${t.focusRing}`}
                >
                  {copied === 'deployed' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'deployed' ? 'Copied' : 'Copy'}
                </button>
                <a href={deployedUrl} target="_blank" rel="noreferrer" className={`shrink-0 rounded-full border ${t.edge} p-1.5 ${t.textDim} ${t.hover} ${t.focusRing}`} title="Open the live app">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </section>
          )}
          {/* Share the live preview link */}
          <section className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
            <p className={`text-[11px] font-bold uppercase tracking-wide ${t.textFaint} mb-2`}>Share the live preview</p>
            {previewUrl ? (
              <div className="flex items-center gap-2">
                <code className={`min-w-0 flex-1 truncate rounded-md border ${t.edge} ${t.panel} px-2.5 py-1.5 font-mono text-[11px] ${t.textDim}`}>{previewUrl}</code>
                <button
                  onClick={() => copy('link', previewUrl)}
                  className={`shrink-0 inline-flex items-center gap-1 rounded-full ${t.accentBg} ${t.accentText} px-2.5 py-1.5 text-[11px] font-bold ${t.accentBgHover} ${t.focusRing}`}
                >
                  {copied === 'link' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'link' ? 'Copied' : 'Copy link'}
                </button>
                <a
                  href={previewUrl} target="_blank" rel="noreferrer"
                  className={`shrink-0 rounded-full border ${t.edge} p-1.5 ${t.textDim} ${t.hover} ${t.focusRing}`}
                  title="Open in a new tab"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            ) : (
              <p className={`text-xs ${t.textDim}`}>
                Press <span className="font-semibold">Build &amp; run</span> (⌘K) to boot the app in a live container — its shareable link appears here. The link is live while the container is awake; deploy below for a permanent URL.
              </p>
            )}
          </section>

          {/* Deploy to a provider */}
          <section className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3 space-y-3`}>
            <div className="flex items-center gap-2">
              <Rocket className={`w-4 h-4 ${t.accent}`} />
              <p className="text-sm font-bold">Deploy “{title || 'your app'}”</p>
            </div>

            {/* Provider chooser */}
            <div className="flex flex-wrap gap-1.5">
              {PROVIDERS.map((p) => {
                const active = p.id === provider;
                const Icon = p.Icon;
                return (
                  <button
                    key={p.id}
                    onClick={() => { setProvider(p.id); setResult(null); }}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${t.focusRing} ${
                      active ? `${t.edgeStrong} ${t.accentSoft} ${t.accent}` : `${t.edge} ${t.textDim} ${t.hover}`
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" /> {p.name}
                  </button>
                );
              })}
            </div>
            <p className={`text-[11px] ${t.textFaint}`}>{meta.blurb}</p>

            {/* One-click attempt (honest about server support) + bundle download */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void runDeploy()}
                disabled={deploying}
                className={`inline-flex items-center gap-1.5 rounded-full ${t.accentBg} ${t.accentText} px-3 py-1.5 text-xs font-bold ${t.accentBgHover} disabled:opacity-50 ${t.focusRing}`}
              >
                {deploying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                {deploying ? 'Deploying…' : `Deploy to ${meta.name}`}
              </button>
              <button
                onClick={onDownloadZip}
                className={`inline-flex items-center gap-1.5 rounded-full border ${t.edge} px-3 py-1.5 text-xs font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}
              >
                <Download className="w-3.5 h-3.5" /> Deploy bundle (.zip)
              </button>
              <a
                href={meta.docs} target="_blank" rel="noreferrer"
                className={`inline-flex items-center gap-1 text-[11px] font-semibold ${t.accent} ${t.hover} rounded-full px-2 py-1 ${t.focusRing}`}
              >
                Docs <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            {result && (
              <div className={`rounded-md border ${t.edge} ${t.panel} px-3 py-2 text-xs ${STATUS_TONE[result.status]}`}>
                <span className="font-bold capitalize">{result.status}</span>
                {result.url && (
                  <a href={result.url} target="_blank" rel="noreferrer" className="ml-2 underline">{result.url}</a>
                )}
                {result.message && <p className={`mt-0.5 ${t.textDim}`}>{result.message}</p>}
              </div>
            )}

            {/* Real, copy-able manual steps — always work. */}
            <div className={`rounded-md border ${t.edge} ${t.panel} overflow-hidden`}>
              <div className={`flex items-center gap-2 px-2.5 py-1.5 ${t.panelAlt} border-b ${t.edge}`}>
                <Terminal className={`w-3.5 h-3.5 ${t.textFaint}`} />
                <span className={`text-[10px] font-bold uppercase tracking-wide ${t.textFaint}`}>Deploy steps</span>
                <button
                  onClick={() => copy('steps', meta.steps.join('\n'))}
                  className={`ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${t.textDim} ${t.hover} ${t.focusRing}`}
                >
                  {copied === 'steps' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} Copy
                </button>
              </div>
              <pre className={`px-3 py-2 font-mono text-[11px] ${t.textDim} whitespace-pre-wrap`}>
{meta.steps.map((s) => `$ ${s}`).join('\n')}
              </pre>
            </div>
          </section>

          {/* Deploy history (most recent first) — appears once the project has deployments. */}
          {history.length > 0 && (
            <section className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
              <p className={`text-[11px] font-bold uppercase tracking-wide ${t.textFaint} mb-2`}>Recent deployments</p>
              <ul className="space-y-1.5">
                {history.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-semibold ${d.status === 'live' ? 'bg-emerald-500/15 text-emerald-500' : d.status === 'failed' || d.status === 'error' ? 'bg-rose-500/15 text-rose-500' : `${t.panel} ${t.textDim}`}`}>{d.status}</span>
                    <span className={`shrink-0 ${t.textDim}`}>{d.target}</span>
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className={`min-w-0 flex-1 truncate ${t.accent} hover:underline`}>{d.url.replace(/^https?:\/\//, '')}</a>
                    ) : (
                      <span className={`min-w-0 flex-1 truncate ${t.textFaint}`}>—</span>
                    )}
                    <span className={`shrink-0 ${t.textFaint}`}>{relTime(d.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
