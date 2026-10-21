import React from 'react';
import { Cloud, ExternalLink, KeyRound, TriangleAlert } from 'lucide-react';
import { Surface, SurfaceSubtitle, SurfaceTitle } from '../../chat/artifacts/kit';
import type { CloudflareSection, CloudflareWorkerRow } from '../../../shared/types/costCentre';
import { SortableTable, type Column } from './SortableTable';
import { fmtCount } from './costFormat';
import { STATUS } from './costPalette';

// Live Cloudflare usage (Workers invocations + R2 storage) when the read-only analytics token
// is configured; otherwise a short, exact setup card. Token values never reach the browser —
// the server only reports configured/not.

const bytes = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

const WORKER_COLUMNS: Column<CloudflareWorkerRow>[] = [
  { key: 'script', label: 'Worker', value: (r) => r.script, className: 'font-mono text-[11px]' },
  { key: 'requests', label: 'Requests', align: 'right', value: (r) => r.requests, render: (r) => fmtCount(r.requests) },
  { key: 'errors', label: 'Errors', align: 'right', value: (r) => r.errors, render: (r) => fmtCount(r.errors) },
  { key: 'subrequests', label: 'Subrequests', align: 'right', value: (r) => r.subrequests ?? null, render: (r) => fmtCount(r.subrequests) },
  {
    key: 'cpu',
    label: 'CPU p50',
    align: 'right',
    value: (r) => r.cpuP50Ms,
    render: (r) => (r.cpuP50Ms === null ? '—' : `${r.cpuP50Ms.toFixed(r.cpuP50Ms < 10 ? 2 : 1)} ms`)
  }
];

export const CloudflareCard: React.FC<{ cloudflare: CloudflareSection; days: number }> = ({ cloudflare, days }) => {
  if (!cloudflare.configured) {
    return (
      <Surface className="!my-0"
        header={
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />
            <div>
              <SurfaceTitle>Live Cloudflare usage</SurfaceTitle>
              <SurfaceSubtitle>Not connected — optional: per-Worker requests and R2 storage</SurfaceSubtitle>
            </div>
          </div>
        }
      >
        <ol className="list-decimal space-y-1.5 px-3 pb-3 pl-8 text-xs leading-relaxed text-[var(--ds-ink)]">
          <li>
            Create a read-only API token with <span className="font-semibold">Account › Account Analytics › Read</span>{' '}
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 text-[#D97757] hover:underline"
            >
              (API tokens <ExternalLink className="h-3 w-3" aria-hidden />)
            </a>
            .
          </li>
          <li>
            Set <code className="rounded bg-[var(--ds-well-strong)] px-1 font-mono text-[11px]">CF_ANALYTICS_API_TOKEN</code> and{' '}
            <code className="rounded bg-[var(--ds-well-strong)] px-1 font-mono text-[11px]">CLOUDFLARE_ACCOUNT_ID</code> as secrets on the{' '}
            <span className="font-mono text-[11px]">dreamstream-api</span> Worker (or rows in D1 <span className="font-mono text-[11px]">backend_env</span>).
          </li>
          <li>The backend container picks them up on its next start; this card then shows per-Worker requests, errors and CPU.</li>
        </ol>
        <p className="flex items-center gap-1.5 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-2 text-[11px] text-[var(--ds-muted)]">
          <KeyRound className="h-3 w-3" aria-hidden /> The token is read server-side only and never sent to the browser.
        </p>
      </Surface>
    );
  }

  if (cloudflare.error) {
    return (
      <Surface className="!my-0"
        header={
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4" style={{ color: STATUS.warning }} aria-hidden />
            <div>
              <SurfaceTitle>Live Cloudflare usage unavailable</SurfaceTitle>
              <SurfaceSubtitle>Configured, but the analytics query failed</SurfaceSubtitle>
            </div>
          </div>
        }
      >
        <p className="px-3 pb-3 text-xs text-[var(--ds-ink)]">
          {cloudflare.error}. Check that the token has <span className="font-semibold">Account Analytics › Read</span> on this account.
        </p>
      </Surface>
    );
  }

  const workers = cloudflare.workers || [];
  const r2 = cloudflare.r2 || [];
  return (
    <Surface className="!my-0"
      header={
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />
          <div>
            <SurfaceTitle>Live Cloudflare usage</SurfaceTitle>
            <SurfaceSubtitle>
              Workers invocations, last {days} days · included in Workers Paid up to 10M requests/month
            </SurfaceSubtitle>
          </div>
        </div>
      }
    >
      <div className="space-y-3 px-3 pb-3">
        <SortableTable
          caption="Cloudflare Workers usage"
          csvName={`cloudflare-workers-${days}d`}
          columns={WORKER_COLUMNS}
          rows={workers}
          rowKey={(r) => r.script}
          emptyText="No DreamStream Worker invocations reported in this period."
          initialSort={{ key: 'requests', dir: 'desc' }}
        />
        {(cloudflare.excludedScripts || 0) > 0 && (
          <p className="text-[11px] text-[var(--ds-muted)]">
            {cloudflare.excludedScripts} non-DreamStream Worker{cloudflare.excludedScripts === 1 ? '' : 's'} on the same account left out.
          </p>
        )}
        {r2.length > 0 && (
          <div className="text-[11px] text-[var(--ds-muted)]">
            <span className="font-semibold text-[var(--ds-ink)]">R2 storage</span> (free up to 10 GB):{' '}
            {r2.map((b) => `${b.bucket} ${bytes(b.payloadBytes)} · ${fmtCount(b.objectCount)} objects`).join(' · ')}
          </div>
        )}
      </div>
    </Surface>
  );
};
