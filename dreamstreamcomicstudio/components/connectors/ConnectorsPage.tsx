// ============================================================================
// Connectors — managed in Chat Studio → Settings → Connectors
// ============================================================================
//
// macOS-settings-style grouped rows (not a marketing card grid) so it sits cleanly
// inside the settings modal. Catalog + live-connection management (status, force
// re-sync, reconnect, disconnect). Built on the calm-studio --ds-* tokens via the
// shadcn-pattern primitives in ./ui. OAuth uses a consent popup that posts its result
// back (relayed globally in App.tsx); API-key connectors connect inline.
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
  Settings2,
  X
} from 'lucide-react';
import { Skeleton } from '../studio/kit/Shimmer';
import { ConnectorIcon, statusVisual } from './connectorIcons';
import { Button, Group, IconTile, Section } from './ui';
import { ConnectDialog } from './ConnectDialog';
import { GoogleConnectDialog } from './GoogleConnectDialog';
import {
  fetchCatalog,
  fetchConnections,
  connectConnector,
  connectGoogleServices,
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

export const ConnectorsPage: React.FC<{ onBack?: () => void; embedded?: boolean }> = ({ onBack, embedded }) => {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogEntry, setDialogEntry] = useState<CatalogEntry | null>(null);
  const [googleDialogOpen, setGoogleDialogOpen] = useState(false);
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

  // Full-page fallback: if a full-page redirect (popup blocked) landed back here with a
  // result while this view is mounted, surface it and clean the URL. (The popup path is
  // relayed globally in App.tsx.)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('connector_error');
    if (!connected && !error) return;
    if (window.opener && window.opener !== window) return; // handled globally in App.tsx
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
      // The self-closing callback page posts from the BACKEND origin, so we don't gate on
      // e.origin here; the payload is non-sensitive (connector ids) and the authoritative
      // update is the scoped refreshConnections() below.
      const data = e.data as { type?: string; connected?: string; error?: string };
      if (data?.type !== OAUTH_RESULT) return;
      setConnecting(null);
      try {
        popupRef.current?.close();
      } catch {
        /* ignore */
      }
      popupRef.current = null;
      if (data.error) pushToast('error', `Couldn't connect: ${humanizeError(data.error)}`);
      else if (data.connected) pushToast('success', `${data.connected.replace(/_/g, ' ')} connected`);
      void refreshConnections();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushToast, refreshConnections]);

  // Reconcile when the user comes back from the OAuth popup. We deliberately DON'T poll
  // `popup.closed`: reading it while the popup sits on Google's cross-origin consent page
  // makes Chrome log a COOP "would block the window.closed call" warning on every tick
  // (the spam you'd otherwise see). Instead the popup postMessages its result (handled
  // above); this watcher only covers the "user dismissed the popup" case, via focus/
  // visibility, plus a hard safety timeout so the connect spinner can never get stuck.
  useEffect(() => {
    if (!connecting) return;
    let graceTimer: number | undefined;
    const reconcile = () => {
      if (document.visibilityState !== 'visible') return;
      if (!popupRef.current) return; // popup not opened yet (still fetching the consent URL)
      window.clearTimeout(graceTimer);
      // Give a late postMessage a beat to win the race (it clears `connecting`, which
      // tears this watcher down) before assuming the user just closed the window.
      graceTimer = window.setTimeout(() => {
        popupRef.current = null;
        void refreshConnections();
        setConnecting(null);
      }, 700);
    };
    window.addEventListener('focus', reconcile);
    document.addEventListener('visibilitychange', reconcile);
    const safety = window.setTimeout(() => {
      popupRef.current = null;
      setConnecting(null);
    }, 3 * 60_000);
    return () => {
      window.removeEventListener('focus', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
      window.clearTimeout(graceTimer);
      window.clearTimeout(safety);
    };
  }, [connecting, refreshConnections]);

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
        setDialogEntry(null);
        const popup = window.open(result.authorizationUrl, 'connector_oauth', 'width=520,height=700');
        if (!popup) {
          window.location.assign(result.authorizationUrl);
          return;
        }
        popupRef.current = popup;
      } catch (err) {
        setConnecting(null);
        pushToast('error', (err as Error)?.message || 'Connection failed');
      }
    },
    [pushToast, refreshConnections]
  );

  // Seamless multi-service Google flow: disconnect any removed services, then (if new
  // services were added) run ONE consent covering the full selection.
  const handleGoogleSubmit = useCallback(
    async (selected: string[], toDisconnect: string[]) => {
      setConnecting('google');
      try {
        for (const id of toDisconnect) {
          const conns = (connections || []).filter((c) => c.connectorId === id);
          for (const c of conns) await disconnectConnection(c.id);
        }
        const connectedSet = new Set((connections || []).map((c) => c.connectorId));
        const needConsent = selected.some((id) => !connectedSet.has(id));
        if (needConsent && selected.length) {
          const { authorizationUrl } = await connectGoogleServices(selected);
          setGoogleDialogOpen(false);
          const popup = window.open(authorizationUrl, 'connector_oauth', 'width=520,height=700');
          if (!popup) {
            window.location.assign(authorizationUrl);
            return;
          }
          popupRef.current = popup;
        } else {
          setGoogleDialogOpen(false);
          setConnecting(null);
          if (toDisconnect.length) pushToast('success', 'Google services updated');
          await refreshConnections();
        }
      } catch (err) {
        setConnecting(null);
        pushToast('error', (err as Error)?.message || 'Could not update Google services');
      }
    },
    [connections, pushToast, refreshConnections]
  );

  const handleSync = useCallback(
    async (conn: ConnectionSummary) => {
      setBusyConn(conn.id);
      try {
        await syncConnection(conn.id);
        pushToast('info', 'Sync started');
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

  // Google OAuth services group into ONE row + one consent; everything else stays a
  // standalone row.
  const googleServices = useMemo(() => (catalog || []).filter((c) => c.providerGroup === 'google'), [catalog]);
  const otherCatalog = useMemo(() => (catalog || []).filter((c) => c.providerGroup !== 'google'), [catalog]);
  const googleConnectedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of connections || []) if (googleServices.some((g) => g.id === c.connectorId)) ids.add(c.connectorId);
    return ids;
  }, [connections, googleServices]);
  const googleConfigured = googleServices.some((g) => g.configured);

  const isLoading = catalog === null || connections === null;
  const hasConnections = (connections?.length ?? 0) > 0;

  return (
    <div className={embedded ? 'text-[var(--ds-ink)]' : 'min-h-screen bg-[var(--ds-canvas)] text-[var(--ds-ink)]'}>
      <div className={embedded ? '' : 'mx-auto max-w-2xl px-4 py-8 sm:px-6 md:py-10'}>
        {!embedded && (
          <header className="mb-6 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Plug className="h-6 w-6 text-[var(--ds-accent)]" aria-hidden />
                <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
              </div>
              <p className="mt-1 max-w-xl text-sm text-[var(--ds-muted)]">
                Connect your accounts so the assistant can use that data in chat, analysis and dashboards.
              </p>
            </div>
            {onBack && (
              <Button variant="outline" size="sm" onClick={onBack}>
                Back
              </Button>
            )}
          </header>
        )}

        {loadError && (
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError}
            <button onClick={() => void load()} className="ml-auto font-medium underline">
              Retry
            </button>
          </div>
        )}

        {isLoading ? (
          <Group>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 p-4">
                <Skeleton className="h-9 w-9" />
                <div className="flex-1">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="mt-2 h-3 w-2/3" />
                </div>
                <Skeleton className="h-8 w-20" pill />
              </div>
            ))}
          </Group>
        ) : (
          <>
            {hasConnections && (
              <Section
                title="Your connections"
                subtitle="Accounts the studio can read on your behalf. Sync, reconnect or disconnect anytime."
              >
                <Group>
                  {connections!.map((conn) => (
                    <ConnectionRow
                      key={conn.id}
                      conn={conn}
                      entry={catalog?.find((c) => c.id === conn.connectorId)}
                      busy={busyConn === conn.id}
                      onSync={() => handleSync(conn)}
                      onDisconnect={() => handleDisconnect(conn)}
                      onReconnect={() => handleReconnect(conn)}
                    />
                  ))}
                </Group>
              </Section>
            )}

            <Section
              title="Add a connection"
              subtitle="Give the assistant access to your data — read-only, encrypted, revocable."
            >
              {catalog && catalog.length > 0 ? (
                <Group>
                  {googleServices.length > 0 && (
                    <GoogleRow
                      services={googleServices}
                      connectedIds={googleConnectedIds}
                      configured={googleConfigured}
                      connecting={connecting === 'google'}
                      onManage={() => setGoogleDialogOpen(true)}
                    />
                  )}
                  {otherCatalog.map((entry) => (
                    <ProviderRow
                      key={entry.id}
                      entry={entry}
                      connectionCount={connectionsByConnector.get(entry.id)?.length ?? 0}
                      connecting={connecting === entry.id}
                      onConnect={() => setDialogEntry(entry)}
                    />
                  ))}
                </Group>
              ) : (
                <Group>
                  <div className="p-8 text-center">
                    <Plug className="mx-auto h-7 w-7 text-[var(--ds-faint)]" aria-hidden />
                    <p className="mt-2 text-sm text-[var(--ds-muted)]">No connectors are available yet.</p>
                  </div>
                </Group>
              )}
            </Section>
          </>
        )}
      </div>

      {dialogEntry && (
        <ConnectDialog
          entry={dialogEntry}
          submitting={connecting === dialogEntry.id}
          onSubmit={(apiKey) => void handleConnect(dialogEntry, apiKey)}
          onClose={() => setDialogEntry(null)}
        />
      )}

      {googleDialogOpen && (
        <GoogleConnectDialog
          services={googleServices}
          connectedIds={googleConnectedIds}
          configured={googleConfigured}
          submitting={connecting === 'google'}
          onSubmit={(selected, toDisconnect) => void handleGoogleSubmit(selected, toDisconnect)}
          onClose={() => setGoogleDialogOpen(false)}
        />
      )}

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[120] flex w-full max-w-sm flex-col gap-2">
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

// ---- small inline bits ------------------------------------------------------

const ConnectedBadge: React.FC<{ count?: number }> = ({ count = 1 }) => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
    <CheckCircle2 className="h-3 w-3" /> Connected{count > 1 ? ` · ${count}` : ''}
  </span>
);

const NotConfiguredBadge: React.FC = () => (
  <span
    title="The server's Google OAuth client isn't configured yet."
    className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
  >
    Unavailable
  </span>
);

// ---- Google group row (one row, one consent for the whole suite) ------------

const GoogleRow: React.FC<{
  services: CatalogEntry[];
  connectedIds: Set<string>;
  configured: boolean;
  connecting: boolean;
  onManage: () => void;
}> = ({ services, connectedIds, configured, connecting, onManage }) => {
  const connected = connectedIds.size > 0;
  return (
    <div className="flex items-start gap-3 p-3 sm:p-4">
      <IconTile className="h-10 w-10">
        <Plug className="h-5 w-5" aria-hidden />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Google</span>
          {connected ? <ConnectedBadge count={connectedIds.size} /> : !configured && <NotConfiguredBadge />}
        </div>
        <p className="mt-0.5 text-xs text-[var(--ds-muted)]">
          Gmail, Drive, Calendar, Sheets &amp; YouTube — one sign-in for the services you pick.
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {services.map((s) => {
            const on = connectedIds.has(s.id);
            return (
              <span
                key={s.id}
                title={`${s.displayName}${on ? ' (connected)' : ''}`}
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
                  on ? 'bg-emerald-500/10 text-emerald-700' : 'bg-[var(--ds-well)] text-[var(--ds-muted)]'
                }`}
              >
                <ConnectorIcon name={s.icon} className="h-3 w-3" />
                {s.displayName.replace(/^Google /, '')}
              </span>
            );
          })}
        </div>
      </div>
      <Button
        size="sm"
        variant={connected ? 'outline' : 'primary'}
        onClick={onManage}
        disabled={connecting}
        className="mt-0.5 shrink-0"
      >
        {connecting ? <Loader2 className="animate-spin" /> : connected ? <Settings2 /> : <Plug />}
        {connected ? 'Manage' : 'Connect'}
      </Button>
    </div>
  );
};

// ---- Standalone provider row (Maps, …) --------------------------------------

const ProviderRow: React.FC<{
  entry: CatalogEntry;
  connectionCount: number;
  connecting: boolean;
  onConnect: () => void;
}> = ({ entry, connectionCount, connecting, onConnect }) => {
  const connected = connectionCount > 0;
  return (
    <div className="flex items-center gap-3 p-3 sm:p-4">
      <IconTile className="h-10 w-10">
        <ConnectorIcon name={entry.icon} className="h-5 w-5" />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{entry.displayName}</span>
          {connected ? <ConnectedBadge count={connectionCount} /> : !entry.configured && <NotConfiguredBadge />}
          <span className="rounded bg-[var(--ds-well)] px-1.5 py-0.5 text-[10px] text-[var(--ds-muted)]">
            {entry.authType === 'api_key' ? 'API key' : 'OAuth'}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-[var(--ds-muted)]">{entry.description}</p>
      </div>
      <Button
        size="sm"
        variant={connected ? 'outline' : 'primary'}
        onClick={onConnect}
        disabled={connecting}
        className="shrink-0"
      >
        {connecting ? <Loader2 className="animate-spin" /> : connected ? <Plus /> : <Plug />}
        {connected ? 'Add' : 'Connect'}
      </Button>
    </div>
  );
};

// ---- Connection (management) row --------------------------------------------

const ConnectionRow: React.FC<{
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
  const scopeSummary = conn.grantedScopes.map((s) => s.split('/').pop()).filter(Boolean).join(', ');
  const meta = [
    entry?.displayName || conn.connectorId,
    conn.sync?.itemsSynced ? `${conn.sync.itemsSynced.toLocaleString()} items` : null,
    conn.lastSyncAt ? `synced ${new Date(conn.lastSyncAt).toLocaleDateString()}` : 'not synced yet'
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex items-center gap-3 p-3 sm:p-4">
      <IconTile className="h-10 w-10">
        <ConnectorIcon name={entry?.icon || 'Plug'} className="h-5 w-5" />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium" title={scopeSummary ? `Access: ${scopeSummary}` : undefined}>
            {conn.accountLabel || conn.accountIdentifier}
          </span>
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${vis.tint}`}>
            <StatusIcon className={`h-3 w-3 ${conn.status === 'syncing' ? 'animate-spin' : ''}`} /> {vis.label}
          </span>
        </div>
        <p className="truncate text-xs text-[var(--ds-muted)]">{meta}</p>
        {conn.lastError && vis.needsReconnect && (
          <p className="truncate text-[11px] text-amber-700" title={conn.lastError}>
            {conn.lastError}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {vis.needsReconnect ? (
          <Button size="sm" variant="primary" onClick={onReconnect} disabled={busy}>
            <RotateCw /> Reconnect
          </Button>
        ) : (
          syncable && (
            <Button
              size="icon"
              variant="ghost"
              title="Sync now"
              aria-label="Sync now"
              onClick={onSync}
              disabled={busy || conn.status === 'syncing'}
            >
              <RefreshCw className={busy ? 'animate-spin' : ''} />
            </Button>
          )
        )}
        <Button
          size="icon"
          variant="destructive"
          title="Disconnect"
          aria-label="Disconnect"
          onClick={onDisconnect}
          disabled={busy}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
};
