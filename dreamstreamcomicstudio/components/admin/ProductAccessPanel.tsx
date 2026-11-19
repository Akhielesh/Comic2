// Admin "Studios" panel — per-studio (product_access) onboarding for standalone accounts.
// Look a user up by email, see their current grants, and grant/revoke each studio.
// Granting can optionally send the branded studio-invite email.
//
// Server endpoints (server/src/routes/admin.ts, requireAdmin):
//   GET  /api/admin/product-access?email=…   → { userId, email, grants }
//   POST /api/admin/product-access           → { email, product, active, sendInvite?, inviterName?, personalNote? }

import React, { useState } from 'react';
import { Check, Loader2, Mail, MonitorPlay, Search, ShieldOff } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ds';
import { CARD_TITLE } from '../ds/Card';
import { DENSITY, FIELD, MUTED, STATUS_CHIP, STATUS_CHIP_TONE, STATUS_INK, STATUS_SURFACE } from '../chat/studioDesign';
import {
  adminGetProductAccess,
  adminResetProductAccess,
  adminSetProductAccess,
  PRODUCT_IDS,
  PRODUCT_LABELS,
  invalidateProductAccess,
  type ProductAccessGrant,
  type ProductId
} from '../../services/productAccess';
import { streamAddressLabel } from '../../shared/streamHost';

const STUDIO_BLURB: Record<ProductId, string> = {
  stream_studio: `Go-live streaming and the baby monitor at ${streamAddressLabel()} — standalone accounts land there directly.`,
  comic_studio: 'Script-to-comic creation: dashboard, editors and the public library.',
  chat_studio: 'The AI chat workspace with 100+ models, widgets and dashboards.'
};

type LookupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; userId: string; email: string; grants: ProductAccessGrant[] };

export const ProductAccessPanel: React.FC = () => {
  const [email, setEmail] = useState('');
  const [lookup, setLookup] = useState<LookupState>({ status: 'idle' });
  const [busyProduct, setBusyProduct] = useState<ProductId | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Invite-email options applied when granting.
  const [sendInvite, setSendInvite] = useState(false);
  const [inviterName, setInviterName] = useState('');
  const [personalNote, setPersonalNote] = useState('');

  const loadGrants = async (target: string) => {
    const normalized = target.trim().toLowerCase();
    if (!normalized) {
      setLookup({ status: 'error', message: 'Enter an email address to look up.' });
      return;
    }
    setLookup({ status: 'loading' });
    setMessage(null);
    try {
      const result = await adminGetProductAccess(normalized);
      setLookup({ status: 'loaded', userId: result.userId, email: result.email, grants: result.grants || [] });
    } catch (err) {
      setLookup({ status: 'error', message: err instanceof Error ? err.message : 'Lookup failed.' });
    }
  };

  const handleSet = async (product: ProductId, active: boolean) => {
    if (lookup.status !== 'loaded') return;
    // First grant on a default account flips it from "everything open" to "confined to
    // the granted studios" — confirm the operator wants confinement, not addition.
    if (active && lookup.grants.length === 0) {
      const ok = window.confirm(
        `${lookup.email} currently has full access to every studio (default).\n\n` +
        `Granting ${PRODUCT_LABELS[product]} will CONFINE the account to only the studios you explicitly grant.\n\nContinue?`
      );
      if (!ok) return;
    }
    setBusyProduct(product);
    setMessage(null);
    try {
      const result = await adminSetProductAccess({
        email: lookup.email,
        product,
        active,
        ...(active && sendInvite
          ? {
              sendInvite: true,
              inviterName: inviterName.trim() || undefined,
              personalNote: personalNote.trim() || undefined
            }
          : {})
      });
      setMessage({
        type: 'success',
        text: result.alreadyGranted
          ? `${PRODUCT_LABELS[product]}: already has access — nothing to do.`
          : active
            ? `${PRODUCT_LABELS[product]} granted${result.emailed ? ' — invite email sent.' : sendInvite ? ' (invite email was not sent).' : '.'}`
            : `${PRODUCT_LABELS[product]} revoked.`
      });
      // If the operator changed their OWN account, the suite's gates re-check immediately.
      invalidateProductAccess();
      await loadGrants(lookup.email);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Update failed.' });
    } finally {
      setBusyProduct(null);
    }
  };

  const grants = lookup.status === 'loaded' ? lookup.grants : [];
  const grantFor = (product: ProductId) => grants.find((g) => g.product === product);
  const isDefault = grants.length === 0;

  // Delete every grant row → back to default full access (the inverse of confinement).
  const handleReset = async () => {
    if (lookup.status !== 'loaded') return;
    setBusyProduct('stream_studio'); // any sentinel to disable the grid while resetting
    setMessage(null);
    try {
      const result = await adminResetProductAccess(lookup.email);
      setMessage({ type: 'success', text: `Reset to full access — ${result.cleared} grant${result.cleared === 1 ? '' : 's'} cleared (all studios open).` });
      invalidateProductAccess();
      await loadGrants(lookup.email);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Reset failed.' });
    } finally {
      setBusyProduct(null);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <p className={cn('text-xs', MUTED)}>
        Onboard a user to a standalone studio (or revoke one). Accounts with <strong>no grants</strong> have
        default access to everything; <strong>any grant confines the account</strong> to exactly its active
        studios. A user granted only Stream Studio is routed straight to {streamAddressLabel()}.
      </p>

      {/* Lookup */}
      <form
        className="flex flex-wrap items-end gap-3 rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3"
        onSubmit={(e) => { e.preventDefault(); void loadGrants(email); }}
      >
        <label className="min-w-0 max-w-sm grow text-xs font-medium text-[var(--ds-muted)]">User email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            type="email"
            className={cn(FIELD, 'mt-1 block h-9 w-full px-2 text-sm', DENSITY.coarse)}
          />
        </label>
        <Button type="submit" disabled={lookup.status === 'loading'}>
          {lookup.status === 'loading' ? <Loader2 className="w-4 h-4 motion-safe:animate-spin" /> : <Search className="w-4 h-4" />} Look up
        </Button>
      </form>

      {lookup.status === 'error' && (
        <div className={cn('rounded-[var(--ds-radius-control)] border px-3 py-2 text-xs font-medium [overflow-wrap:anywhere]', STATUS_SURFACE.error, STATUS_INK.error)}>{lookup.message}</div>
      )}
      {message && (
        <div className={cn('rounded-[var(--ds-radius-control)] border px-3 py-2 text-xs font-medium [overflow-wrap:anywhere]', message.type === 'success' ? `${STATUS_SURFACE.healthy} ${STATUS_INK.healthy}` : `${STATUS_SURFACE.error} ${STATUS_INK.error}`)}>
          {message.text}
        </div>
      )}

      {lookup.status === 'loaded' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{lookup.email}</span>
            <span className={cn('min-w-0 truncate font-mono', MUTED)}>{lookup.userId}</span>
            <span className={cn(STATUS_CHIP, 'whitespace-normal', STATUS_CHIP_TONE[isDefault ? 'healthy' : 'attention'])}>
              {isDefault ? 'Full access (default — everything open)' : `Confined to ${grants.filter((g) => g.active).length} active studio(s)`}
            </span>
            {!isDefault && (
              <Button variant="outline" size="sm" onClick={() => void handleReset()} disabled={busyProduct !== null}>
                Reset to full access (all studios)
              </Button>
            )}
          </div>

          {/* Invite email options (used when granting) */}
          <div className={cn('space-y-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-well)] p-3')}>
            <label className={cn('flex cursor-pointer items-center gap-2 text-sm font-medium', DENSITY.coarse)}>
              <input
                type="checkbox"
                checked={sendInvite}
                onChange={(e) => setSendInvite(e.target.checked)}
                className="w-4 h-4 accent-[var(--ds-accent)]"
              />
              <Mail className="w-4 h-4" /> Send invite email when granting
            </label>
            {sendInvite && (
              <div className="grid gap-3 pl-6 sm:grid-cols-2">
                <label className="text-xs font-medium text-[var(--ds-muted)]">Inviter name (optional)
                  <input
                    value={inviterName}
                    onChange={(e) => setInviterName(e.target.value)}
                    placeholder="e.g. Akhielesh"
                    maxLength={80}
                    className={cn(FIELD, 'mt-1 block h-9 w-full px-2 text-sm', DENSITY.coarse)}
                  />
                </label>
                <label className="text-xs font-medium text-[var(--ds-muted)]">Personal note (optional)
                  <input
                    value={personalNote}
                    onChange={(e) => setPersonalNote(e.target.value)}
                    placeholder="A short note shown in the email"
                    maxLength={500}
                    className={cn(FIELD, 'mt-1 block h-9 w-full px-2 text-sm', DENSITY.coarse)}
                  />
                </label>
              </div>
            )}
          </div>

          {/* Per-studio grants */}
          <div className="grid md:grid-cols-3 gap-3">
            {PRODUCT_IDS.map((product) => {
              const grant = grantFor(product);
              const state: 'default' | 'granted' | 'revoked' = !grant ? 'default' : grant.active ? 'granted' : 'revoked';
              // Effective access, not raw row state: in default mode every studio is open;
              // in confined mode a missing row means locked out.
              const stateLabel = state !== 'default' ? state : isDefault ? 'Open (default)' : 'Not allowed';
              const stateTone = STATUS_CHIP_TONE[state === 'granted' ? 'healthy' : state === 'revoked' ? 'error' : isDefault ? 'healthy' : 'error'];
              const busy = busyProduct === product;
              return (
                <div key={product} className={cn('flex flex-col space-y-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] p-3')}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className={cn(CARD_TITLE, 'flex items-center gap-1.5')}>
                      <MonitorPlay size={16} aria-hidden /> {PRODUCT_LABELS[product]}
                    </div>
                    <span className={cn(STATUS_CHIP, stateTone)}>
                      {stateLabel}
                    </span>
                  </div>
                  <p className={cn('grow text-[11px] leading-snug', MUTED)}>{STUDIO_BLURB[product]}</p>
                  {grant?.note && <p className={cn('truncate text-[11px] italic', MUTED)}>Note: {grant.note}</p>}
                  {grant?.updated_at && (
                    <p className={cn('text-[11px] tabular-nums', MUTED)}>Updated {new Date(grant.updated_at).toLocaleString()}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={state === 'granted' ? 'outline' : 'secondary'}
                      disabled={busy || state === 'granted'}
                      onClick={() => void handleSet(product, true)}
                    >
                      {busy ? <Loader2 size={13} className="motion-safe:animate-spin" /> : <Check size={13} />}
                      {state === 'granted' ? 'Granted' : 'Grant'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || state === 'revoked'}
                      onClick={() => void handleSet(product, false)}
                    >
                      {busy ? <Loader2 size={13} className="motion-safe:animate-spin" /> : <ShieldOff size={13} />}
                      Revoke
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
