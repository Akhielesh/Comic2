// Seamless "pick your Google services" dialog. The user checks the services they want
// (Gmail, Drive, Calendar, Sheets, YouTube), and a SINGLE Google consent grants the
// union of scopes. Re-opening it later lets them add or remove services — additions
// re-consent (incrementally), removals disconnect. Target: one click here + one consent.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, ShieldCheck, Check, Loader2, Plug } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import { ConnectorIcon } from './connectorIcons';
import type { CatalogEntry } from '../../services/connectorsApi';

interface GoogleConnectDialogProps {
  services: CatalogEntry[];
  connectedIds: Set<string>;
  configured: boolean;
  submitting: boolean;
  /** selected = services to (re)connect; toDisconnect = currently-connected, now unchecked. */
  onSubmit: (selected: string[], toDisconnect: string[]) => void;
  onClose: () => void;
}

const DEFAULT_PRESELECT = ['gmail', 'google_drive', 'google_calendar'];

export const GoogleConnectDialog: React.FC<GoogleConnectDialogProps> = ({
  services,
  connectedIds,
  configured,
  submitting,
  onSubmit,
  onClose
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (connectedIds.size) return new Set(connectedIds);
    const preset = services.filter((s) => DEFAULT_PRESELECT.includes(s.id)).map((s) => s.id);
    return new Set(preset.length ? preset : services.map((s) => s.id));
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const { selectedIds, toDisconnect, changed } = useMemo(() => {
    const selectedIds = [...selected];
    const toDisconnect = [...connectedIds].filter((id) => !selected.has(id));
    const toAdd = selectedIds.filter((id) => !connectedIds.has(id));
    return { selectedIds, toDisconnect, changed: toAdd.length > 0 || toDisconnect.length > 0 };
  }, [selected, connectedIds]);

  const willConsent = selectedIds.some((id) => !connectedIds.has(id));

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="google-connect-title"
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
              <Plug className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="google-connect-title" className="text-base font-semibold text-[var(--ds-ink)]">
                Connect your Google services
              </h2>
              <p className="mt-0.5 text-sm text-[var(--ds-muted)]">
                Pick what to connect — one sign-in covers everything you choose.
              </p>
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

          <div className="max-h-[46vh] overflow-auto p-3">
            <ul className="space-y-1" role="group" aria-label="Google services">
              {services.map((s) => {
                const isOn = selected.has(s.id);
                const isConnected = connectedIds.has(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isOn}
                      onClick={() => toggle(s.id)}
                      disabled={submitting}
                      className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left hover:bg-[var(--ds-hover)] focus-visible:ring-2 focus-visible:ring-[#D97757]/30 disabled:opacity-60"
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                          isOn ? 'border-[var(--ds-accent)] bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-hairline)]'
                        }`}
                      >
                        {isOn && <Check className="h-3.5 w-3.5" />}
                      </span>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-well)] text-[var(--ds-muted)]">
                        <ConnectorIcon name={s.icon} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[var(--ds-ink)]">{s.displayName}</span>
                          {isConnected && (
                            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                              Connected
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-[var(--ds-muted)]">{s.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="border-t border-[var(--ds-hairline-soft)] p-5 pt-4">
            {willConsent && (
              <p className="mb-3 flex items-start gap-2 text-xs text-[var(--ds-muted)]">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                Least-privilege, read-only access. A Google consent window opens; tokens are encrypted at rest
                and you can change this anytime.
              </p>
            )}
            {!configured && (
              <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Google isn't configured on the server yet, so connecting may fail until the admin sets the OAuth client.
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-[var(--ds-muted)]">
                {selectedIds.length} selected
                {toDisconnect.length ? ` · ${toDisconnect.length} to remove` : ''}
              </span>
              <div className="flex items-center gap-2">
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
                  onClick={() => onSubmit(selectedIds, toDisconnect)}
                  disabled={submitting || !changed}
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[var(--ds-accent-hover)] focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-60"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {connectedIds.size ? 'Save changes' : `Connect ${selectedIds.length || ''}`.trim()}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
