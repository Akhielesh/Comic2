// Connect dialog — the 2–3 click connect flow. OAuth connectors show a least-privilege
// scope preview + a single "Connect" button that launches the consent popup; API-key
// connectors show a key field (optional when a platform key is configured).

import React, { useEffect, useRef, useState } from 'react';
import { X, ShieldCheck, KeyRound, ExternalLink, Loader2 } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import { ConnectorIcon } from './connectorIcons';
import type { CatalogEntry } from '../../services/connectorsApi';

interface ConnectDialogProps {
  entry: CatalogEntry;
  submitting: boolean;
  onSubmit: (apiKey?: string) => void;
  onClose: () => void;
}

const prettyScope = (scope: string): string => {
  const tail = scope.split('/').pop() || scope;
  return tail.replace(/\.(readonly|read)$/i, ' (read-only)').replace(/\./g, ' ');
};

export const ConnectDialog: React.FC<ConnectDialogProps> = ({ entry, submitting, onSubmit, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const isApiKey = entry.authType === 'api_key';
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap entry + Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-dialog-title"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !submitting) onClose();
        }}
      >
        <div
          ref={dialogRef}
          className="w-full max-w-md rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-xl backdrop-blur-xl"
        >
          <div className="flex items-start gap-3 p-5 border-b border-[var(--ds-hairline-soft)]">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#D97757]/10 text-[var(--ds-accent)]">
              <ConnectorIcon name={entry.icon} className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="connect-dialog-title" className="text-base font-semibold text-[var(--ds-ink)]">
                Connect {entry.displayName}
              </h2>
              <p className="mt-0.5 text-sm text-[var(--ds-muted)]">{entry.description}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
              className="rounded-lg p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            {isApiKey ? (
              <div className="space-y-2">
                <label htmlFor="connector-api-key" className="flex items-center gap-2 text-sm font-medium text-[var(--ds-ink)]">
                  <KeyRound className="h-4 w-4 text-[var(--ds-muted)]" /> API key
                </label>
                <input
                  id="connector-api-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={entry.userProvidesKey ? 'Paste your API key' : 'Optional — uses the platform key'}
                  className="w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-sm text-[var(--ds-ink)] outline-none focus:border-[var(--ds-accent)] focus-visible:ring-2 focus-visible:ring-[#D97757]/30"
                />
                <p className="text-xs text-[var(--ds-muted)]">
                  Stored encrypted at rest (AES-256-GCM). The key is validated before it is saved.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm font-medium text-[var(--ds-ink)]">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" /> You'll grant least-privilege access to:
                </p>
                <ul className="space-y-1.5 rounded-xl bg-[var(--ds-well)] p-3">
                  {entry.requiredScopes
                    .filter((s) => !/userinfo/.test(s))
                    .map((s) => (
                      <li key={s} className="flex items-center gap-2 text-sm text-[var(--ds-ink)]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]" />
                        <span className="capitalize">{prettyScope(s)}</span>
                      </li>
                    ))}
                </ul>
                <p className="text-xs text-[var(--ds-muted)]">
                  A Google consent window opens. Tokens are encrypted at rest and never leave this app; you can
                  disconnect anytime.
                </p>
              </div>
            )}

            {!entry.configured && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                This connector isn't configured on the server yet, so connecting may fail. {entry.docsUrl ? 'See the connector docs.' : ''}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 p-5 pt-0">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl px-4 py-2 text-sm font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSubmit(isApiKey ? apiKey.trim() || undefined : undefined)}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[var(--ds-accent-hover)] focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
              {isApiKey ? 'Save & connect' : `Connect ${entry.displayName}`}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
