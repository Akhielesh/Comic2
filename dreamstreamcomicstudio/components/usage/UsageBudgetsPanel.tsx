// Admin → Costs → "Usage budgets" (P1-LIMITS). Every non-admin user has $10 of platform-paid
// usage across all studios (lifetime, real provider cost; their own keys never count). Here an
// admin sees each user's usage in percent AND dollars, tops someone up, exempts them, allows Pro
// quality, or starts a fresh window — every change is audited server-side (audit_log).
//
// Users never see this; the server serves it only behind requireAdmin. Calm-studio glass, --ds-*
// tokens, rows reflow into cards on phones (no horizontal scroll from 320 px), 44 px targets.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, RefreshCw, ShieldCheck, TriangleAlert, Wallet } from 'lucide-react';
import { Surface, SurfaceSubtitle, SurfaceTitle } from '../chat/artifacts/kit';
import {
  listUsageBudgets,
  updateUsageBudget,
  type UsageBudgetRow,
  type UsageBudgetUpdate,
  type UsageBudgetsReport
} from '../../services/usageAllowance';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** "$10" · "$4.27" · "$0.0031" — admins see honest small numbers. */
export const fmtBudgetUsd = (n: number): string => {
  if (!Number.isFinite(n) || n === 0) return '$0';
  const abs = Math.abs(n);
  if (abs >= 100) return `$${Math.round(abs).toLocaleString('en-US')}`;
  if (abs >= 0.01) return `$${abs.toFixed(2).replace(/\.00$/, '')}`;
  return `$${Number(abs.toPrecision(2))}`;
};

const fmtWhen = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const stateOf = (row: UsageBudgetRow): { label: string; cls: string } =>
  row.admin
    ? { label: 'Admin · no limit', cls: 'bg-[#D97757]/10 text-[var(--ds-ink)]' }
    : row.exempt
      ? { label: 'Exempt', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' }
      : row.exhausted
        ? { label: 'Used up', cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' }
        : { label: row.hasRow ? 'Custom' : 'Default', cls: 'bg-[var(--ds-surface-soft)] text-[var(--ds-muted)]' };

const INPUT =
  'h-11 w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 text-[13px] text-[var(--ds-ink)] tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 sm:h-9';
const BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-50 sm:h-9';

type Draft = { budgetUsd: string; exempt: boolean; allowPro: boolean; resetPeriod: boolean; note: string };

const draftFor = (row?: UsageBudgetRow, defaultUsd = 10): Draft => ({
  budgetUsd: String(row ? row.budgetUsd : defaultUsd),
  exempt: row?.exempt ?? false,
  allowPro: row?.allowPro ?? false,
  resetPeriod: false,
  note: row?.note ?? ''
});

/** Only the fields that changed (a new user sends everything). */
export const buildBudgetUpdate = (draft: Draft, row?: UsageBudgetRow): UsageBudgetUpdate | string => {
  const budget = Number(draft.budgetUsd);
  if (!Number.isFinite(budget) || budget < 0 || budget > 1000) return 'Budget must be between $0 and $1,000.';
  const out: UsageBudgetUpdate = {};
  if (!row || Math.abs(budget - row.budgetUsd) > 0.00005) out.budgetUsd = Math.round(budget * 10000) / 10000;
  if (!row || draft.exempt !== row.exempt) out.exempt = draft.exempt;
  if (!row || draft.allowPro !== row.allowPro) out.allowPro = draft.allowPro;
  if (draft.resetPeriod) out.resetPeriod = true;
  const note = draft.note.trim();
  if (!row ? note : note !== (row.note ?? '')) out.note = note || null;
  if (Object.keys(out).length === 0) return 'Nothing changed.';
  return out;
};

const Toggle: React.FC<{ label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, hint, checked, onChange }) => (
  <label className="flex min-h-11 cursor-pointer items-start gap-2 text-[13px] text-[var(--ds-ink)] sm:min-h-0">
    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#D97757]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="min-w-0">
      {label}
      {hint && <span className="block text-[11.5px] text-[var(--ds-muted)]">{hint}</span>}
    </span>
  </label>
);

const BudgetEditor: React.FC<{
  row?: UsageBudgetRow;
  defaultUsd: number;
  onSaved: () => void;
  onCancel: () => void;
}> = ({ row, defaultUsd, onSaved, onCancel }) => {
  const [who, setWho] = useState('');
  const [draft, setDraft] = useState<Draft>(() => draftFor(row, defaultUsd));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    const target = row ? row.userId : who.trim();
    if (!target) return setError('Enter the person’s email or user id.');
    const update = buildBudgetUpdate(draft, row);
    if (typeof update === 'string') return setError(update);
    setSaving(true);
    setError(null);
    try {
      await updateUsageBudget(target, update);
      onSaved();
    } catch (err) {
      setError((err as Error)?.message || 'Could not save — try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
      {!row && (
        <label className="block text-[12px] font-medium text-[var(--ds-muted)]">
          Email or user id
          <input className={cx(INPUT, 'mt-1')} value={who} onChange={(e) => setWho(e.target.value)} placeholder="tester@example.com" autoComplete="off" />
        </label>
      )}
      <label className="block text-[12px] font-medium text-[var(--ds-muted)]">
        Budget (USD, real provider cost)
        <input className={cx(INPUT, 'mt-1')} type="number" inputMode="decimal" min={0} max={1000} step={0.5} value={draft.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value })} />
      </label>
      <Toggle label="Exempt (no limit)" checked={draft.exempt} onChange={(v) => set({ exempt: v })} />
      <Toggle label="Allow Pro quality and the model picker" hint="Pro pages cost ~2.6× a Standard page." checked={draft.allowPro} onChange={(v) => set({ allowPro: v })} />
      <Toggle label="Start a fresh window now" hint="Spend so far stops counting. Leave off to top up on top of what they used." checked={draft.resetPeriod} onChange={(v) => set({ resetPeriod: v })} />
      <label className="block text-[12px] font-medium text-[var(--ds-muted)]">
        Note (audit log)
        <input className={cx(INPUT, 'mt-1')} value={draft.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} placeholder="e.g. beta top-up, week 2" />
      </label>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-rose-700 dark:text-rose-300">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cx(BTN, 'bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]')} onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : row ? 'Save' : 'Add'}
        </button>
        <button type="button" className={cx(BTN, 'border border-[var(--ds-hairline)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]')} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
};

const BudgetRowView: React.FC<{ row: UsageBudgetRow; onEdit: () => void }> = ({ row, onEdit }) => {
  const state = stateOf(row);
  const limited = !row.admin && !row.exempt;
  const left = Math.max(0, Math.min(100, row.pctLeft));
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--ds-ink)]" title={row.email || row.userId}>
            {row.email || row.userId}
          </span>
          <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold', state.cls)}>{state.label}</span>
          {row.allowPro && <span className="shrink-0 rounded-full bg-[var(--ds-surface-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ds-muted)]">Pro</span>}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1.5 w-full max-w-[14rem] overflow-hidden rounded-full bg-[var(--ds-well)]" aria-hidden>
            <div
              className={cx('h-full rounded-full', !limited ? 'bg-[var(--ds-hairline)]' : left < 10 ? 'bg-rose-500' : left < 30 ? 'bg-amber-500' : 'bg-emerald-500')}
              style={{ width: `${limited ? Math.min(100, row.pctUsed) : 0}%` }}
            />
          </div>
          <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--ds-muted)]">
            {limited ? `${Math.round(row.pctUsed)}% used` : 'not limited'}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        <span className="text-[12.5px] tabular-nums text-[var(--ds-ink)]">
          {fmtBudgetUsd(row.spentUsd + row.inflightUsd)} <span className="text-[var(--ds-muted)]">of {limited ? fmtBudgetUsd(row.budgetUsd) : '∞'}</span>
          <span className="ml-2 text-[11px] text-[var(--ds-muted)]">· {row.period === 'monthly' ? 'monthly' : 'lifetime'} · last {fmtWhen(row.lastUsedAt)}</span>
        </span>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit usage budget for ${row.email || row.userId}`}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 sm:h-8 sm:w-8"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </li>
  );
};

export const UsageBudgetsPanel: React.FC = () => {
  const [report, setReport] = useState<UsageBudgetsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await listUsageBudgets());
    } catch (err) {
      setError((err as Error)?.message || 'Could not load usage budgets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const rows = report?.users || [];
    const limited = rows.filter((r) => !r.admin && !r.exempt);
    return {
      users: rows.length,
      usedUp: limited.filter((r) => r.exhausted).length,
      spent: limited.reduce((s, r) => s + r.spentUsd + r.inflightUsd, 0)
    };
  }, [report]);

  const saved = () => {
    setEditing(null);
    void load();
  };

  return (
    <Surface
      className="!my-0"
      header={
        <div>
          <SurfaceTitle>
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="h-4 w-4 text-[var(--ds-accent)]" aria-hidden /> Usage budgets
            </span>
          </SurfaceTitle>
          <SurfaceSubtitle>
            {report
              ? `Default ${fmtBudgetUsd(report.defaultBudgetUsd)} ${report.defaultPeriod} per user, all studios, real provider cost · own keys never count · users see only “usage left”`
              : 'Per-user platform usage, all studios'}
          </SurfaceSubtitle>
        </div>
      }
      right={
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing('new')}
            className={cx(BTN, 'border border-[var(--ds-hairline)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]')}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add
          </button>
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh usage budgets"
            disabled={loading}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-50 sm:h-9 sm:w-9"
          >
            <RefreshCw className={cx('h-4 w-4', loading && 'motion-safe:animate-spin')} aria-hidden />
          </button>
        </div>
      }
    >
      <div className="space-y-3 px-3 pb-3">
        {report && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ds-muted)]">
            <span>
              <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{totals.users}</span> users
            </span>
            <span>
              <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{fmtBudgetUsd(totals.spent)}</span> used by limited users
            </span>
            {totals.usedUp > 0 && (
              <span className="text-rose-700 dark:text-rose-300">
                <span className="font-semibold tabular-nums">{totals.usedUp}</span> used up
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> admins are never limited
            </span>
          </p>
        )}

        {editing === 'new' && report && (
          <BudgetEditor defaultUsd={report.defaultBudgetUsd} onSaved={saved} onCancel={() => setEditing(null)} />
        )}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-rose-700 dark:text-rose-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {error}
            <span className="text-[var(--ds-muted)]"> If this is the first deploy, the user_usage_budgets migration may not be applied yet.</span>
          </p>
        )}

        {!error && report && report.users.length === 0 && (
          <p className="text-[12.5px] text-[var(--ds-muted)]">No one has used platform-paid AI yet. Add a tester to set their budget before they start.</p>
        )}

        {report && report.users.length > 0 && (
          <ul className="divide-y divide-[var(--ds-hairline-soft)]">
            {report.users.map((row) =>
              editing === row.userId ? (
                <li key={row.userId} className="py-2.5">
                  <BudgetEditor row={row} defaultUsd={report.defaultBudgetUsd} onSaved={saved} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <BudgetRowView key={row.userId} row={row} onEdit={() => setEditing(row.userId)} />
              )
            )}
          </ul>
        )}

        {loading && !report && <p className="text-[12.5px] text-[var(--ds-muted)]">Loading usage budgets…</p>}
      </div>
    </Surface>
  );
};

export default UsageBudgetsPanel;
