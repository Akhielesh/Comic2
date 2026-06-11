// Admin "Studios" panel — per-studio (product_access) onboarding for standalone accounts.
// Look a user up by email, see their current grants, and grant/revoke each studio.
// Granting can optionally send the branded studio-invite email.
//
// Server endpoints (server/src/routes/admin.ts, requireAdmin):
//   GET  /api/admin/product-access?email=…   → { userId, email, grants }
//   POST /api/admin/product-access           → { email, product, active, sendInvite?, inviterName?, personalNote? }

import React, { useState } from 'react';
import { Check, Loader2, Mail, MonitorPlay, Search, ShieldOff } from 'lucide-react';
import { Button } from '../Button';
import {
  adminGetProductAccess,
  adminSetProductAccess,
  PRODUCT_IDS,
  PRODUCT_LABELS,
  invalidateProductAccess,
  type ProductAccessGrant,
  type ProductId
} from '../../services/productAccess';

const STUDIO_BLURB: Record<ProductId, string> = {
  stream_studio: 'Go-live streaming at /live.html — standalone accounts land there directly.',
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
        text: active
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

  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-slate-500">
        Onboard a user to a standalone studio (or revoke one). Accounts with <strong>no grants</strong> have
        default access to everything; <strong>any grant confines the account</strong> to exactly its active
        studios. A user granted only Stream Studio is routed straight to /live.html.
      </p>

      {/* Lookup */}
      <form
        className="border-2 border-black rounded-xl bg-slate-50 p-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); void loadGrants(email); }}
      >
        <label className="text-xs font-bold grow max-w-sm">User email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            type="email"
            className="block mt-1 w-full border-2 border-black rounded-md px-2 py-1.5 bg-white font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={lookup.status === 'loading'}
          className="flex items-center gap-1 text-sm font-bold border-2 border-black rounded-md px-3 py-1.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40"
        >
          {lookup.status === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Look up
        </button>
      </form>

      {lookup.status === 'error' && (
        <div className="border-2 border-red-400 bg-red-50 text-red-700 rounded-lg px-3 py-2 text-xs font-bold">{lookup.message}</div>
      )}
      {message && (
        <div className={`border-2 rounded-lg px-3 py-2 text-xs font-bold ${message.type === 'success' ? 'border-green-500 bg-green-50 text-green-700' : 'border-red-400 bg-red-50 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {lookup.status === 'loaded' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-bold">{lookup.email}</span>
            <span className="text-slate-400 font-mono truncate">{lookup.userId}</span>
            <span className={`px-1.5 py-0.5 rounded font-bold ${grants.length === 0 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
              {grants.length === 0 ? 'Default access (no grants — everything open)' : `Confined to ${grants.filter((g) => g.active).length} active studio(s)`}
            </span>
          </div>

          {/* Invite email options (used when granting) */}
          <div className="border-2 border-black rounded-xl bg-white p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
              <input
                type="checkbox"
                checked={sendInvite}
                onChange={(e) => setSendInvite(e.target.checked)}
                className="w-4 h-4 accent-black"
              />
              <Mail className="w-4 h-4" /> Send invite email when granting
            </label>
            {sendInvite && (
              <div className="grid sm:grid-cols-2 gap-3 pl-6">
                <label className="text-xs font-bold">Inviter name (optional)
                  <input
                    value={inviterName}
                    onChange={(e) => setInviterName(e.target.value)}
                    placeholder="e.g. Akhielesh"
                    maxLength={80}
                    className="block mt-1 w-full border-2 border-black rounded-md px-2 py-1.5 bg-white text-sm"
                  />
                </label>
                <label className="text-xs font-bold">Personal note (optional)
                  <input
                    value={personalNote}
                    onChange={(e) => setPersonalNote(e.target.value)}
                    placeholder="A short note shown in the email"
                    maxLength={500}
                    className="block mt-1 w-full border-2 border-black rounded-md px-2 py-1.5 bg-white text-sm"
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
              const busy = busyProduct === product;
              return (
                <div key={product} className="border-2 border-black rounded-xl bg-white p-3 space-y-2 flex flex-col">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-display text-lg flex items-center gap-1.5">
                      <MonitorPlay size={16} /> {PRODUCT_LABELS[product]}
                    </div>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${state === 'granted' ? 'bg-green-100 text-green-700' : state === 'revoked' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>
                      {state === 'default' ? 'No grant' : state}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-snug grow">{STUDIO_BLURB[product]}</p>
                  {grant?.note && <p className="text-[11px] text-slate-400 italic truncate">Note: {grant.note}</p>}
                  {grant?.updated_at && (
                    <p className="text-[10px] text-slate-400 tabular-nums">Updated {new Date(grant.updated_at).toLocaleString()}</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={state === 'granted' ? 'outline' : 'secondary'}
                      disabled={busy || state === 'granted'}
                      onClick={() => void handleSet(product, true)}
                      icon={busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    >
                      {state === 'granted' ? 'Granted' : 'Grant'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || state === 'revoked'}
                      onClick={() => void handleSet(product, false)}
                      icon={busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />}
                    >
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
