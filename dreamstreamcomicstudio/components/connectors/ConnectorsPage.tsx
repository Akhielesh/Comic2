// ============================================================================
// Connectors — a top-level primary nav section (NOT under Settings/Tools)
// ============================================================================
//
// Catalog grid of available connectors + management of the user's live connections
// (status, scopes, force re-sync, reconnect, disconnect). Built on the house "calm
// studio" design tokens (--ds-*). OAuth uses a consent popup that posts its result
// back to this page; API-key connectors connect inline.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plug,
  RefreshCw,
  Trash2,
  RotateCw,
  Loader2,
  Plus,
  AlertTriangle,
  CheckCircle2,
  X
} from 'lucide-react';
import { Skeleton } from '../studio/kit/Shimmer';
import { ConnectorIcon, statusVisual } from './connectorIcons';
import { ConnectDialog } from './ConnectDialog';
import {
  fetchCatalog,
  fetchConnections,
  connectConnector,
  syncConnection,
  disconnectConnection,
  type CatalogEntry,
  type ConnectionSummary
} from '../../services/connectorsApi';

type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: string };

const OAUTH_RESULT = 'connector-oauth-result';

const humanizeError = (code: string): string => {
  switch (code) {
    case 'access_denied':
      return 'you cancelled the consent screen';
    case 'invalid_or_expired_state':
      return 'the request expired — please try again';
    case 'no_credentials':
      return 'this connector is not configured on the server';
    case 'storage_unavailable':
      return 'secure storage is unavailable on the server';
    default:
      return code.replace(/_/g, ' ');
  }
};

export const ConnectorsPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogEntry, setDialogEntry] = useState<CatalogEntry | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [busyConn, setBusyConn] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const popupRef = useRef<Window | null>(null);

  const pushToast = useCallback((tone: Toast['tone'], message: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await fetchConnections());
    } catch (err) {
      pushToast('error', (err as Error)?.message || 'Could not load connections');
    }
  }, [pushToast]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [cat, conns] = await Promise.all([fetchCatalog(), fetchConnections()]);
      setCatalog(cat);
      setConnections(conns);
    } catch (err) {
      setLoadError((err as Error)?.message || 'Could not load connectors');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // If THIS page is the OAuth popup (it loaded the SPA after the callback redirect),
  // relay the result to the opener and close. Otherwise, if a full-page redirect
  // carried the params, surface them and clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('connector_error');
    if (!connected && !error) return;

    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage({ type: OAUTH_RESULT, connected, error }, window.location.origin);
      } catch {
        /* ignore */
      }
      window.close();
      return;
    }
    // Full-page fallback: toast + scrub the params so a refresh doesn't repeat them.
    if (error) pushToast('error', `Couldn't connect: ${humanizeError(error)}`);
    else if (connected) pushToast('success', `${connected.replace(/_/g, ' ')} connected`);
    params.delete('connected');
    params.delete('connector_error');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    void refreshConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for the popup's postMessage result.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; connected?: string; error?: string };
      if (data?.type !== OAUTH_RESULT) return;
      setConnecting(null);
      try {
        popupRef.current?.close();
      } catch {
        /* ignore */
      }
      if (data.error) pushToast('error', `Couldn't connect: ${humanizeError(data.error)}`);
      else if (data.connected) pushToast('success', `${data.connected.replace(/_/g, ' ')} connected`);
      void refreshConnections();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushToast, refreshConnections]);

  const watchPopupClose = useCallback(
    (popup: Window) => {
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          // The message handler usually fires first; this clears state if the user
          // simply closed the window, and re-syncs in case the connection landed.
          setConnecting((c) => c);
          setTimeout(() => setConnecting(null), 300);
          void refreshConnections();
        }
      }, 800);
    },
    [refreshConnections]
  );

  const handleConnect = useCallback(
    async (entry: CatalogEntry, apiKey?: string) => {
      setConnecting(entry.id);
      try {
        const result = await connectConnector(entry.id, apiKey ? { apiKey } : {});
        if (result.mode === 'completed') {
          setDialogEntry(null);
          setConnecting(null);
          pushToast('success', `${entry.displayName} connected`);
          await refreshConnections();
          return;
        }
        // OAuth: open the consent popup; fall back to a full redirect if blocked.
        setDialogEntry(null);
        const popup = window.open(result.authorizationUrl, 'connector_oauth', 'width=520,height=700');
        if (!popup) {
          window.location.assign(result.authorizationUrl);
          return;
        }
        popupRef.current = popup;
        watchPopupClose(popup);
      } catch (err) {
        setConnecting(null);
        pushToast('error', (err as Error)?.message || 'Connection failed');
      }
    },
    [pushToast, refreshConnections, watchPopupClose]
  );

  const handleSync = useCallback(
    async (conn: ConnectionSummary) => {
      setBusyConn(conn.id);
      try {
        await syncConnection(conn.id);
        pushToast('info', 'Sync started');
        // Reflect the 'syncing' state quickly, then poll once shortly after.
        await refreshConnections();
        setTimeout(() => void refreshConnections(), 4000);
      } catch (err) {
        pushToast('error', (err as Error)?.message || 'Sync failed to start');
      } finally {
        setBusyConn(null);
      }
    },
    [pushToast, refreshConnections]
  );

  const handleDisconnect = useCallback(
    async (conn: ConnectionSummary) => {
      if (!window.confirm(`Disconnect ${conn.accountLabel || conn.accountIdentifier}? This removes its synced data.`)) return;
      setBusyConn(conn.id);
      try {
        await disconnectConnection(conn.id);
        pushToast('success', 'Disconnected');
        await refreshConnections();
      } catch (err) {
        pushToast('error', (err as Error)?.message || 'Disconnect failed');
      } finally {
        setBusyConn(null);
      }
    },
    [pushToast, refreshConnections]
  );

  const handleReconnect = useCallback(
    (conn: ConnectionSummary) => {
      const entry = catalog?.find((c) => c.id === conn.connectorId);
      if (entry) void handleConnect(entry);
    },
    [catalog, handleConnect]
  );

  const connectionsByConnector = useMemo(() => {
    const map = new Map<string, ConnectionSummary[]>();
    for (const c of connections || []) {
      const arr = map.get(c.connectorId) || [];
      arr.push(c);
      map.set(c.connectorId, arr);
    }
    return map;
  }, [connections]);

  const isLoading = catalog === null || connections === null;

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] text-[var(--ds-ink)]">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:py-10">
        {/* Header */}
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Plug className="h-6 w-6 text-[var(--ds-accent)]" aria-hidden />
              <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
            </div>
            <p className="mt-1 max-w-xl text-sm text-[var(--ds-muted)]">
              Connect your accounts — Gmail, Maps and more — so the studio can use that data in chat, analysis and dashboards.
            </p>
          </div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-xl border border-[var(--ds-hairline)] px-3 py-1.5 text-sm text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              Back
            </button>
          )}
        </header>

        {loadError && (
          <div className="mb-6 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
            <AlertTriangle className="h-4 w-4" /> {loadError}
            <button onClick={() => void load()} className="ml-auto font-medium underline">
              Retry
            </button>
          </div>
        )}

        {/* Your connections */}
        {!isLoading && (connections?.length ?? 0) > 0 && (
          <section className="mb-10" aria-labelledby="your-connections">
            <h2 id="your-connections" className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ds-muted)]">
              Your connections
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {connections!.map((conn) => (
                <ConnectionCard
                  key={conn.id}
                  conn={conn}
                  entry={catalog?.find((c) => c.id === conn.connectorId)}
                  busy={busyConn === conn.id}
                  onSync={() => handleSync(conn)}
                  onDisconnect={() => handleDisconnect(conn)}
                  onReconnect={() => handleReconnect(conn)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Catalog */}
        <section aria-labelledby="catalog-heading">
          <h2 id="catalog-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ds-muted)]">
            Available connectors
          </h2>

          {isLoading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4">
                  <Skeleton className="h-10 w-10" />
                  <Skeleton className="mt-3 h-4 w-1/2" />
                  <Skeleton className="mt-2 h-3 w-full" />
                  <Skeleton className="mt-1.5 h-3 w-2/3" />
                  <Skeleton className="mt-4 h-9 w-full" pill />
                </div>
              ))}
            </div>
          ) : catalog && catalog.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.map((entry) => (
                <CatalogCard
                  key={entry.id}
                  entry={entry}
                  connectionCount={connectionsByConnector.get(entry.id)?.length ?? 0}
                  connecting={connecting === entry.id}
                  onConnect={() => setDialogEntry(entry)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--ds-hairline)] p-10 text-center">
              <Plug className="mx-auto h-8 w-8 text-[var(--ds-faint)]" aria-hidden />
              <p className="mt-3 text-sm text-[var(--ds-muted)]">No connectors are available yet.</p>
            </div>
          )}
        </section>
      </div>

      {dialogEntry && (
        <ConnectDialog
          entry={dialogEntry}
          submitting={connecting === dialogEntry.id}
          onSubmit={(apiKey) => void handleConnect(dialogEntry, apiKey)}
          onClose={() => setDialogEntry(null)}
        />
      )}

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[110] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md ${
              t.tone === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800'
                : t.tone === 'error'
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-800'
                  : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-ink)]'
            }`}
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : t.tone === 'error' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : null}
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => setToasts((arr) => arr.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
              className="opacity-60 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// ---- Catalog card ----------------------------------------------------------

const CatalogCard: React.FC<{
  entry: CatalogEntry;
  connectionCount: number;
  connecting: boolean;
  onConnect: () => void;
}> = ({ entry, connectionCount, connecting, onConnect }) => {
  const connected = connectionCount > 0;
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-[var(--ds-hairline)]/80">
      <div className="flex items-start justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#D97757]/10 text-[var(--ds-accent)]">
          <ConnectorIcon name={entry.icon} className="h-5 w-5" />
        </div>
        {connected && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="h-3 w-3" /> Connected{connectionCount > 1 ? ` ·${connectionCount}` : ''}
          </span>
        )}
      </div>
      <h3 className="mt-3 text-base font-semibold">{entry.displayName}</h3>
      <p className="mt-1 flex-1 text-sm text-[var(--ds-muted)]">{entry.description}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="rounded-md bg-[var(--ds-well)] px-1.5 py-0.5 text-[11px] text-[var(--ds-muted)]">
          {entry.authType === 'api_key' ? 'API key' : 'OAuth'}
        </span>
        {entry.capabilities.syncable && (
          <span className="rounded-md bg-[var(--ds-well)] px-1.5 py-0.5 text-[11px] text-[var(--ds-muted)]">Syncs</span>
        )}
        {entry.capabilities.realtime && (
          <span className="rounded-md bg-[var(--ds-well)] px-1.5 py-0.5 text-[11px] text-[var(--ds-muted)]">Realtime</span>
        )}
      </div>
      <button
        type="button"
        onClick={onConnect}
        disabled={connecting}
        className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--ds-accent)] px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[var(--ds-accent-hover)] focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-60"
      >
        {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : connected ? <Plus className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
        {connected ? 'Add account' : 'Connect'}
      </button>
    </div>
  );
};

// ---- Connection (management) card ------------------------------------------

const ConnectionCard: React.FC<{
  conn: ConnectionSummary;
  entry?: CatalogEntry;
  busy: boolean;
  onSync: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}> = ({ conn, entry, busy, onSync, onDisconnect, onReconnect }) => {
  const vis = statusVisual(conn.status);
  const StatusIcon = vis.Icon;
  const syncable = entry?.capabilities.syncable ?? false;
  const [showScopes, setShowScopes] = useState(false);

  return (
    <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#D97757]/10 text-[var(--ds-accent)]">
          <ConnectorIcon name={entry?.icon || 'Plug'} className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold">{entry?.displayName || conn.connectorId}</p>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${vis.tint}`}>
              <StatusIcon className={`h-3 w-3 ${conn.status === 'syncing' ? 'animate-spin' : ''}`} /> {vis.label}
            </span>
          </div>
          <p className="truncate text-xs text-[var(--ds-muted)]">{conn.accountLabel || conn.accountIdentifier}</p>
          <p className="mt-1 text-[11px] text-[var(--ds-faint)]">
            {conn.sync?.itemsSynced ? `${conn.sync.itemsSynced} items · ` : ''}
            {conn.lastSyncAt ? `synced ${new Date(conn.lastSyncAt).toLocaleString()}` : 'not synced yet'}
          </p>
          {conn.lastError && vis.needsReconnect && (
            <p className="mt-1 text-[11px] text-amber-700">{conn.lastError}</p>
          )}
          {conn.grantedScopes.length > 0 && (
            <button
              type="button"
              onClick={() => setShowScopes((s) => !s)}
              aria-expanded={showScopes}
              className="mt-1 text-[11px] text-[var(--ds-muted)] underline-offset-2 hover:underline"
            >
              {showScopes ? 'Hide' : 'View'} granted access
            </button>
          )}
          {showScopes && (
            <ul className="mt-1 space-y-0.5">
              {conn.grantedScopes.map((s) => (
                <li key={s} className="truncate text-[11px] text-[var(--ds-muted)]">
                  • {s.split('/').pop()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {vis.needsReconnect ? (
          <button
            type="button"
            onClick={onReconnect}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-60"
          >
            <RotateCw className="h-3.5 w-3.5" /> Reconnect
          </button>
        ) : (
          syncable && (
            <button
              type="button"
              onClick={onSync}
              disabled={busy || conn.status === 'syncing'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] px-2.5 py-1.5 text-xs font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Sync now
            </button>
          )
        )}
        <button
          type="button"
          onClick={onDisconnect}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Disconnect
        </button>
      </div>
    </div>
  );
};
