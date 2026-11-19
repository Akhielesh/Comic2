// Admin dashboard for the verification system (Phase 2).
//
// - Health bar (open findings, critical, runs last 24h)
// - Checks list with on/off toggle, run-now, delete, last-run status
// - Create-check form (built-ins + a quick custom)
// - Findings inbox with confirm / dismiss / wont-fix
//
// Wire-up of "Confirm → file GitHub issue → Claude Code PR → auto-merge" lives in
// Phase 3 (auto-resolve bridge); the dashboard already exposes the Confirm action.

import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X
} from 'lucide-react';
import {
  createCheck,
  deleteCheck,
  fetchBuiltins,
  fetchChecks,
  fetchFindings,
  fetchHealth,
  patchCheck,
  patchFinding,
  runCheckNow,
  type VerificationBuiltin,
  type VerificationCheck,
  type VerificationFinding,
  type VerificationHealth
} from '../services/verificationApi';
import { cn } from '../lib/utils';
import { Button, IconButton } from './ds';
import {
  DENSITY,
  DIALOG_TITLE,
  FIELD,
  FOCUS_RING,
  MUTED,
  OVERLAY,
  OVERLINE,
  SCRIM,
  SECTION_CARD,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_XL,
  TONE_TEXT,
  TWO_LINE_TEXT,
  Z,
  type StatusState
} from './chat/studioDesign';

// One status vocabulary (the word always rides with the tint).
const SEVERITY_STATE: Record<VerificationFinding['severity'], StatusState> = {
  low: 'waiting',
  med: 'attention',
  high: 'error',
  critical: 'error'
};

const STATUS_STATE: Record<VerificationFinding['status'], StatusState> = {
  open: 'attention',
  confirmed: 'error',
  fixing: 'active',
  resolved: 'healthy',
  dismissed: 'waiting',
  wontfix: 'waiting'
};

const FIELD_CLS = cn(FIELD, 'h-9 w-full px-2 text-sm', DENSITY.coarse);
const FIELD_LABEL = cn(OVERLINE, 'mb-1 block');
const SECTION = cn(SECTION_CARD, 'space-y-4 p-4 sm:p-5');
const SECTION_TITLE = 'text-[length:var(--ds-text-lg)] font-semibold leading-6';

export const VerificationCenter: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<VerificationHealth | null>(null);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [findings, setFindings] = useState<VerificationFinding[]>([]);
  const [builtins, setBuiltins] = useState<VerificationBuiltin[]>([]);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<VerificationFinding['status'] | 'all'>('open');

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [h, c, b, f] = await Promise.all([
        fetchHealth(),
        fetchChecks(),
        fetchBuiltins(),
        fetchFindings({ status: statusFilter === 'all' ? undefined : statusFilter, limit: 100 })
      ]);
      setHealth(h);
      setChecks(c.checks);
      setBuiltins(b.builtins);
      setFindings(f.findings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleEnabled = async (check: VerificationCheck) => {
    try {
      await patchCheck(check.id, { enabled: !check.enabled });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleAutoFix = async (check: VerificationCheck) => {
    try {
      await patchCheck(check.id, { auto_fix_enabled: !check.auto_fix_enabled });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runOne = async (check: VerificationCheck) => {
    setRunningId(check.id);
    try {
      await runCheckNow(check.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunningId(null);
    }
  };

  const removeCheck = async (check: VerificationCheck) => {
    if (!confirm(`Delete check "${check.name}"? Runs + findings will cascade-delete.`)) return;
    try {
      await deleteCheck(check.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const updateFindingStatus = async (id: string, status: VerificationFinding['status']) => {
    try {
      await patchFinding(id, status);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6" aria-hidden />
          <h2 className={cn(TEXT_XL, 'm-0 font-semibold tracking-tight text-[var(--ds-ink)]')}>Verification Center</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refresh()}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
          {onBack && (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className={cn('flex items-start gap-2 rounded-[var(--ds-radius-panel)] border px-4 py-3 text-sm font-medium [overflow-wrap:anywhere]', STATUS_SURFACE.error, STATUS_INK.error)}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}
        </div>
      )}

      <HealthBar health={health} loading={loading} />

      <section className={SECTION}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className={SECTION_TITLE}>Checks</h3>
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus className="w-4 h-4" /> New check
          </Button>
        </div>
        {checks.length === 0 && (
          <p className={cn('text-sm', MUTED)}>
            No checks yet. Create one from a built-in template to seed the dashboard.
          </p>
        )}
        <div className="space-y-2">
          {checks.map((c) => (
            <CheckRow
              key={c.id}
              check={c}
              onToggleEnabled={() => void toggleEnabled(c)}
              onToggleAutoFix={() => void toggleAutoFix(c)}
              onRun={() => void runOne(c)}
              onDelete={() => void removeCheck(c)}
              running={runningId === c.id}
            />
          ))}
        </div>
      </section>

      <section className={SECTION}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className={SECTION_TITLE}>Findings</h3>
          <div className="flex items-center gap-2">
            <label className={OVERLINE}>Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as VerificationFinding['status'] | 'all')}
              className={cn(FIELD, 'h-9 px-2 text-sm', DENSITY.coarse)}
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="confirmed">Confirmed</option>
              <option value="fixing">Fixing</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
              <option value="wontfix">Wontfix</option>
            </select>
          </div>
        </div>
        {findings.length === 0 && (
          <p className={cn('text-sm', MUTED)}>No findings for this filter.</p>
        )}
        <div className="space-y-2">
          {findings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              expanded={expandedFindingId === f.id}
              onToggleExpand={() => setExpandedFindingId(expandedFindingId === f.id ? null : f.id)}
              onUpdate={(s) => void updateFindingStatus(f.id, s)}
            />
          ))}
        </div>
      </section>

      {creating && (
        <NewCheckModal
          builtins={builtins}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
};

const HealthBar: React.FC<{ health: VerificationHealth | null; loading: boolean }> = ({ health, loading }) => (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
    <Stat icon={<AlertTriangle className={cn('w-4 h-4', TONE_TEXT.warning)} aria-hidden />} label="Open findings" value={loading ? '…' : String(health?.open_findings ?? 0)} />
    <Stat icon={<AlertTriangle className={cn('w-4 h-4', TONE_TEXT.danger)} aria-hidden />} label="Critical open" value={loading ? '…' : String(health?.critical_open ?? 0)} />
    <Stat icon={<Activity className="w-4 h-4" aria-hidden />} label="Runs (24h)" value={loading ? '…' : String(health?.runs_last_24h ?? 0)} />
  </div>
);

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className={cn(SECTION_CARD, 'flex items-center justify-between gap-3 p-4')}>
    <div className={cn(OVERLINE, 'flex items-center gap-2')}>
      {icon} {label}
    </div>
    <div className={cn(TEXT_XL, 'font-semibold tabular-nums')}>{value}</div>
  </div>
);

const CheckRow: React.FC<{
  check: VerificationCheck;
  onToggleEnabled: () => void;
  onToggleAutoFix: () => void;
  onRun: () => void;
  onDelete: () => void;
  running: boolean;
}> = ({ check, onToggleEnabled, onToggleAutoFix, onRun, onDelete, running }) => (
  <div className="flex flex-wrap items-center gap-3 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3">
    <div className="min-w-0 flex-1 basis-[200px]">
      <div className="font-semibold [overflow-wrap:anywhere]">{check.name}</div>
      <div className={cn('font-mono text-xs [overflow-wrap:anywhere]', MUTED)}>
        {check.target_feature} · {check.kind} · floor: {check.severity_floor}
        {check.schedule ? ` · ${check.schedule}` : ' · manual only'}
      </div>
    </div>
    <label className={cn('flex cursor-pointer items-center gap-1 text-xs', DENSITY.coarse)}>
      <input type="checkbox" checked={check.enabled} onChange={onToggleEnabled} className="accent-[var(--ds-accent)]" />
      Enabled
    </label>
    <label className={cn('flex cursor-pointer items-center gap-1 text-xs', DENSITY.coarse)} title="When on, confirmed findings of this check are eligible for the Phase-3 auto-fix bridge.">
      <input type="checkbox" checked={check.auto_fix_enabled} onChange={onToggleAutoFix} className="accent-[var(--ds-accent)]" />
      Auto-fix
    </label>
    <Button variant="outline" size="sm" onClick={onRun} loading={running}>
      <Play className="w-4 h-4" /> Run now
    </Button>
    <Button variant="outline" size="sm" onClick={onDelete} title="Delete check">
      <Trash2 className="w-4 h-4" /> Delete
    </Button>
  </div>
);

const FindingRow: React.FC<{
  finding: VerificationFinding;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (status: VerificationFinding['status']) => void;
}> = ({ finding, expanded, onToggleExpand, onUpdate }) => (
  <div className="overflow-hidden rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
    <button
      onClick={onToggleExpand}
      aria-expanded={expanded}
      className={cn('flex w-full flex-wrap items-center gap-2 p-3 text-left transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:bg-[var(--ds-hover)]', FOCUS_RING, 'focus-visible:outline-offset-[-2px]')}
    >
      {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
      <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[SEVERITY_STATE[finding.severity]])}>
        {finding.severity}
      </span>
      <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[STATUS_STATE[finding.status]])}>
        {finding.status}
      </span>
      <span className={cn('font-mono text-xs', MUTED)}>conf {(finding.confidence * 100).toFixed(0)}%</span>
      <span className={cn(TWO_LINE_TEXT, 'font-semibold')} title={finding.title}>{finding.title}</span>
    </button>
    {expanded && (
      <div className="space-y-3 border-t border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3">
        <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(finding.detail, null, 2)}</pre>
        {finding.github_issue_number && (
          <div className={cn('text-xs', MUTED)}>GitHub issue #{finding.github_issue_number}</div>
        )}
        {finding.github_pr_number && (
          <div className={cn('text-xs', MUTED)}>GitHub PR #{finding.github_pr_number}</div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onUpdate('confirmed')} disabled={finding.status === 'confirmed' || finding.status === 'fixing'}>
            Confirm
          </Button>
          <Button variant="outline" size="sm" onClick={() => onUpdate('dismissed')}>
            Dismiss
          </Button>
          <Button variant="outline" size="sm" onClick={() => onUpdate('wontfix')}>
            Won't fix
          </Button>
          <Button variant="outline" size="sm" onClick={() => onUpdate('resolved')}>
            Resolved
          </Button>
        </div>
      </div>
    )}
  </div>
);

const NewCheckModal: React.FC<{
  builtins: VerificationBuiltin[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}> = ({ builtins, onClose, onCreated }) => {
  const titleId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [builtinId, setBuiltinId] = useState(builtins[0]?.id || '');
  const [schedule, setSchedule] = useState('0 3 * * *');
  const [severityFloor, setSeverityFloor] = useState<VerificationCheck['severity_floor']>('high');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const builtin = useMemo(() => builtins.find((b) => b.id === builtinId), [builtins, builtinId]);
  useEffect(() => {
    if (builtin && !name) setName(builtin.id.replace(/_/g, ' '));
  }, [builtin, name]);

  const submit = async () => {
    if (!builtin) {
      setErr('Pick a built-in.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createCheck({
        name: name || builtin.id,
        description: description || builtin.description,
        target_feature: builtin.target,
        kind: builtin.kind,
        config: { builtin: builtin.id },
        schedule: schedule || null,
        enabled: true,
        auto_fix_enabled: false,
        severity_floor: severityFloor
      });
      await onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('fixed inset-0 flex items-center justify-center p-4', Z.dialog, SCRIM)} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn(OVERLAY, 'max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto p-5')} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className={cn(DIALOG_TITLE, 'm-0')}>New verification check</h2>
          <IconButton label="Close" onClick={onClose} className={MUTED}><X className="w-4 h-4" /></IconButton>
        </div>
        {err && <div className={cn('text-sm [overflow-wrap:anywhere]', TONE_TEXT.danger)}>{err}</div>}
        <div>
          <label className={FIELD_LABEL}>Built-in template</label>
          <select value={builtinId} onChange={(e) => setBuiltinId(e.target.value)} className={FIELD_CLS}>
            {builtins.map((b) => (
              <option key={b.id} value={b.id}>{b.id} — {b.target}</option>
            ))}
          </select>
          {builtin && <p className={cn('mt-1 text-xs', MUTED)}>{builtin.description}</p>}
        </div>
        <div>
          <label className={FIELD_LABEL}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD_CLS} />
        </div>
        <div>
          <label className={FIELD_LABEL}>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD_CLS} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={FIELD_LABEL}>Schedule (cron)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} className={cn(FIELD_CLS, 'font-mono')} placeholder="0 3 * * * or empty for manual" />
          </div>
          <div>
            <label className={FIELD_LABEL}>Severity floor</label>
            <select value={severityFloor} onChange={(e) => setSeverityFloor(e.target.value as VerificationCheck['severity_floor'])} className={FIELD_CLS}>
              <option value="low">low</option>
              <option value="med">med</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy}>Create</Button>
        </div>
      </div>
    </div>
  );
};
