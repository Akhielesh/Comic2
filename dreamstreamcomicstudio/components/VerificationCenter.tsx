// Admin dashboard for the verification system (Phase 2).
//
// - Health bar (open findings, critical, runs last 24h)
// - Checks list with on/off toggle, run-now, delete, last-run status
// - Create-check form (built-ins + a quick custom)
// - Findings inbox with confirm / dismiss / wont-fix
//
// Wire-up of "Confirm → file GitHub issue → Claude Code PR → auto-merge" lives in
// Phase 3 (auto-resolve bridge); the dashboard already exposes the Confirm action.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Button } from './Button';

const SEVERITY_COLOR: Record<VerificationFinding['severity'], string> = {
  low: 'bg-slate-100 text-slate-700',
  med: 'bg-brand-yellow text-black',
  high: 'bg-orange-500 text-white',
  critical: 'bg-brand-red text-white'
};

const STATUS_COLOR: Record<VerificationFinding['status'], string> = {
  open: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-orange-500 text-white',
  fixing: 'bg-indigo-500 text-white',
  resolved: 'bg-green-500 text-white',
  dismissed: 'bg-slate-200 text-slate-600',
  wontfix: 'bg-slate-200 text-slate-600'
};

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
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6" />
          <h2 className="font-display text-2xl">Verification Center</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<RefreshCw className="w-4 h-4" />} onClick={() => void refresh()}>
            Refresh
          </Button>
          {onBack && (
            <Button variant="secondary" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-2 border-red-500 bg-red-50 text-red-800 rounded-xl px-4 py-3 text-sm font-semibold flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5" /> {error}
        </div>
      )}

      <HealthBar health={health} loading={loading} />

      <section className="border-2 border-black rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-display text-xl">Checks</h3>
          <Button
            variant="secondary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => setCreating(true)}
          >
            New check
          </Button>
        </div>
        {checks.length === 0 && (
          <p className="text-sm text-slate-500">
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

      <section className="border-2 border-black rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-display text-xl">Findings</h3>
          <div className="flex items-center gap-2">
            <label className="text-xs font-bold text-slate-500 uppercase">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as VerificationFinding['status'] | 'all')}
              className="border-2 border-black rounded px-2 py-1 text-sm"
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
          <p className="text-sm text-slate-500">No findings for this filter.</p>
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
    <Stat icon={<AlertTriangle className="w-4 h-4 text-amber-600" />} label="Open findings" value={loading ? '…' : String(health?.open_findings ?? 0)} />
    <Stat icon={<AlertTriangle className="w-4 h-4 text-red-600" />} label="Critical open" value={loading ? '…' : String(health?.critical_open ?? 0)} />
    <Stat icon={<Activity className="w-4 h-4 text-indigo-600" />} label="Runs (24h)" value={loading ? '…' : String(health?.runs_last_24h ?? 0)} />
  </div>
);

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="border-2 border-black rounded-xl p-4 flex items-center justify-between">
    <div className="flex items-center gap-2 text-xs uppercase font-bold text-slate-500">
      {icon} {label}
    </div>
    <div className="font-display text-2xl">{value}</div>
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
  <div className="border-2 border-black rounded-lg p-3 flex flex-wrap items-center gap-3">
    <div className="flex-1 min-w-[200px]">
      <div className="font-bold">{check.name}</div>
      <div className="text-xs text-slate-500 font-mono">
        {check.target_feature} · {check.kind} · floor: {check.severity_floor}
        {check.schedule ? ` · ${check.schedule}` : ' · manual only'}
      </div>
    </div>
    <label className="text-xs flex items-center gap-1 cursor-pointer">
      <input type="checkbox" checked={check.enabled} onChange={onToggleEnabled} className="accent-black" />
      Enabled
    </label>
    <label className="text-xs flex items-center gap-1 cursor-pointer" title="When on, confirmed findings of this check are eligible for the Phase-3 auto-fix bridge.">
      <input type="checkbox" checked={check.auto_fix_enabled} onChange={onToggleAutoFix} className="accent-black" />
      Auto-fix
    </label>
    <Button variant="secondary" icon={<Play className="w-4 h-4" />} onClick={onRun} isLoading={running}>
      Run now
    </Button>
    <Button variant="secondary" icon={<Trash2 className="w-4 h-4" />} onClick={onDelete} title="Delete check">
      Delete
    </Button>
  </div>
);

const FindingRow: React.FC<{
  finding: VerificationFinding;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (status: VerificationFinding['status']) => void;
}> = ({ finding, expanded, onToggleExpand, onUpdate }) => (
  <div className="border-2 border-black rounded-lg">
    <button
      onClick={onToggleExpand}
      className="w-full text-left p-3 flex items-center gap-2 hover:bg-slate-50"
    >
      {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-black ${SEVERITY_COLOR[finding.severity]}`}>
        {finding.severity}
      </span>
      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-black ${STATUS_COLOR[finding.status]}`}>
        {finding.status}
      </span>
      <span className="text-xs text-slate-500 font-mono">conf {(finding.confidence * 100).toFixed(0)}%</span>
      <span className="font-bold truncate">{finding.title}</span>
    </button>
    {expanded && (
      <div className="border-t-2 border-black p-3 space-y-3 bg-slate-50">
        <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(finding.detail, null, 2)}</pre>
        {finding.github_issue_number && (
          <div className="text-xs text-slate-600">GitHub issue #{finding.github_issue_number}</div>
        )}
        {finding.github_pr_number && (
          <div className="text-xs text-slate-600">GitHub PR #{finding.github_pr_number}</div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => onUpdate('confirmed')} disabled={finding.status === 'confirmed' || finding.status === 'fixing'}>
            Confirm
          </Button>
          <Button variant="secondary" onClick={() => onUpdate('dismissed')}>
            Dismiss
          </Button>
          <Button variant="secondary" onClick={() => onUpdate('wontfix')}>
            Won't fix
          </Button>
          <Button variant="secondary" onClick={() => onUpdate('resolved')}>
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
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white border-4 border-black rounded-xl shadow-comic max-w-lg w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl">New verification check</h3>
          <button onClick={onClose} className="border-2 border-black rounded p-1 hover:bg-brand-yellow"><X className="w-4 h-4" /></button>
        </div>
        {err && <div className="text-sm text-red-700">{err}</div>}
        <div>
          <label className="text-xs font-bold uppercase">Built-in template</label>
          <select value={builtinId} onChange={(e) => setBuiltinId(e.target.value)} className="w-full border-2 border-black rounded px-2 py-1">
            {builtins.map((b) => (
              <option key={b.id} value={b.id}>{b.id} — {b.target}</option>
            ))}
          </select>
          {builtin && <p className="text-xs text-slate-600 mt-1">{builtin.description}</p>}
        </div>
        <div>
          <label className="text-xs font-bold uppercase">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border-2 border-black rounded px-2 py-1" />
        </div>
        <div>
          <label className="text-xs font-bold uppercase">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border-2 border-black rounded px-2 py-1" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold uppercase">Schedule (cron)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="w-full border-2 border-black rounded px-2 py-1 font-mono" placeholder="0 3 * * * or empty for manual" />
          </div>
          <div>
            <label className="text-xs font-bold uppercase">Severity floor</label>
            <select value={severityFloor} onChange={(e) => setSeverityFloor(e.target.value as VerificationCheck['severity_floor'])} className="w-full border-2 border-black rounded px-2 py-1">
              <option value="low">low</option>
              <option value="med">med</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} isLoading={busy}>Create</Button>
        </div>
      </div>
    </div>
  );
};
