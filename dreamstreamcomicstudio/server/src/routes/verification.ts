// Admin CRUD + run/trigger for the verification system.
//
// Mounted at /api/admin/verification — same admin gate as the rest of /api/admin/*.
// Phase 2 dashboard talks to these endpoints; Phase 3 will add an "auto-fix dispatch"
// endpoint that turns a confirmed finding into a labelled GitHub issue.

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { listBuiltins } from '../verification/registry.js';
import { runCheck } from '../verification/runner.js';
import { fileFindingIssue } from '../verification/githubIssueFiler.js';
import type { VerificationFinding } from '../verification/findingsTypes.js';
import type { CheckRecord, CheckKind, Severity, TargetFeature } from '../verification/types.js';

export const verificationRouter = Router();
verificationRouter.use(requireAdmin);

const STATUSES = new Set([
  'open',
  'confirmed',
  'dismissed',
  'fixing',
  'resolved',
  'wontfix'
]);

const asRecord = (row: Record<string, unknown>): CheckRecord => ({
  id: String(row.id),
  name: String(row.name),
  description: row.description ? String(row.description) : undefined,
  target_feature: String(row.target_feature) as TargetFeature,
  kind: String(row.kind) as CheckKind,
  config: (row.config as Record<string, unknown>) || {},
  schedule: row.schedule ? String(row.schedule) : null,
  enabled: Boolean(row.enabled),
  auto_fix_enabled: Boolean(row.auto_fix_enabled),
  severity_floor: String(row.severity_floor) as Severity
});

// List built-ins (for the "create a check" form).
verificationRouter.get('/builtins', (_req: Request, res: Response) => {
  res.json({
    builtins: listBuiltins().map((b) => ({
      id: b.builtinId,
      description: b.description,
      kind: b.kind,
      target: b.target,
      severity: b.severity
    }))
  });
});

// List all checks.
verificationRouter.get('/checks', async (_req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('verification_checks')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ checks: data || [] });
  } catch (err) {
    next(err);
  }
});

// Create a check.
verificationRouter.post('/checks', async (req: Request, res: Response, next) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.target_feature || !body.kind) {
      return res.status(400).json({ error: { message: 'name, target_feature, and kind are required' } });
    }
    const admin = getSupabaseAdmin();
    const insert = {
      name: String(body.name),
      description: body.description ? String(body.description) : null,
      target_feature: String(body.target_feature),
      kind: String(body.kind),
      config: body.config && typeof body.config === 'object' ? body.config : {},
      schedule: body.schedule ? String(body.schedule) : null,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      auto_fix_enabled: Boolean(body.auto_fix_enabled),
      severity_floor: body.severity_floor ? String(body.severity_floor) : 'high',
      created_by: req.user?.id || null
    };
    const { data, error } = await admin.from('verification_checks').insert(insert).select('*').single();
    if (error) throw error;
    res.json({ check: data });
  } catch (err) {
    next(err);
  }
});

// Update a check (enable/disable, schedule, auto_fix toggle, config).
verificationRouter.patch('/checks/:id', async (req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    const allowed = ['name', 'description', 'config', 'schedule', 'enabled', 'auto_fix_enabled', 'severity_floor'];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in (req.body || {})) patch[key] = (req.body as Record<string, unknown>)[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'No allowed fields in patch' } });
    }
    const { data, error } = await admin
      .from('verification_checks')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ check: data });
  } catch (err) {
    next(err);
  }
});

// Delete a check (cascades to runs + findings).
verificationRouter.delete('/checks/:id', async (req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    const { error } = await admin.from('verification_checks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Trigger a check immediately.
verificationRouter.post('/checks/:id/run', async (req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('verification_checks')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) {
      return res.status(404).json({ error: { message: 'Check not found' } });
    }
    const result = await runCheck(admin, asRecord(data as Record<string, unknown>), {
      trigger: 'manual'
    });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

// List recent runs for a check.
verificationRouter.get('/checks/:id/runs', async (req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const { data, error } = await admin
      .from('verification_runs')
      .select('id, status, trigger, summary, started_at, finished_at')
      .eq('check_id', req.params.id)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ runs: data || [] });
  } catch (err) {
    next(err);
  }
});

// List findings, optionally filtered by status / check_id / severity.
verificationRouter.get('/findings', async (req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    let q = admin
      .from('verification_findings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(200, Number(req.query.limit) || 50)));
    if (req.query.status) q = q.eq('status', String(req.query.status));
    if (req.query.check_id) q = q.eq('check_id', String(req.query.check_id));
    if (req.query.severity) q = q.eq('severity', String(req.query.severity));
    const { data, error } = await q;
    if (error) throw error;
    res.json({ findings: data || [] });
  } catch (err) {
    next(err);
  }
});

// Update a finding's status (Confirm / Dismiss / Won't-fix / Resolved).
// On a Confirm of an auto_fix_enabled check's finding, we additionally file a
// labelled GitHub issue (`auto-fix`) so the Claude Code Action picks it up.
verificationRouter.patch('/findings/:id', async (req: Request, res: Response, next) => {
  try {
    const status = String(req.body?.status || '');
    if (!STATUSES.has(status)) {
      return res.status(400).json({ error: { message: `status must be one of ${[...STATUSES].join(', ')}` } });
    }
    const admin = getSupabaseAdmin();
    const patch: Record<string, unknown> = { status };
    if (status === 'resolved' || status === 'wontfix' || status === 'dismissed') {
      patch.resolved_at = new Date().toISOString();
    }
    const { data: updated, error } = await admin
      .from('verification_findings')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    const finding = updated as unknown as VerificationFinding;

    // Confirm → file GitHub issue when the parent check has auto_fix_enabled and the
    // finding is at or above the severity floor and doesn't already have an issue.
    let issueDispatched: { number: number; url: string } | null = null;
    let issueError: string | undefined;
    if (status === 'confirmed' && !finding.github_issue_number) {
      const { data: check } = await admin
        .from('verification_checks')
        .select('id, name, auto_fix_enabled, severity_floor')
        .eq('id', finding.check_id)
        .single();
      const checkRow = check as unknown as { id: string; name: string; auto_fix_enabled: boolean; severity_floor: Severity } | null;
      if (checkRow?.auto_fix_enabled) {
        try {
          issueDispatched = await fileFindingIssue(finding, checkRow.name, { dispatchAutoFix: true });
          if (issueDispatched) {
            await admin
              .from('verification_findings')
              .update({ github_issue_number: issueDispatched.number, status: 'fixing' })
              .eq('id', finding.id);
          }
        } catch (filerErr) {
          issueError = (filerErr as Error).message;
        }
      }
    }

    res.json({ finding: updated, issueDispatched, issueError });
  } catch (err) {
    next(err);
  }
});

// Lightweight automation-health stats for the dashboard top bar.
verificationRouter.get('/health', async (_req: Request, res: Response, next) => {
  try {
    const admin = getSupabaseAdmin();
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const [{ count: openCount }, { count: criticalOpen }, { count: runs24h }] = await Promise.all([
      admin.from('verification_findings').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      admin
        .from('verification_findings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open')
        .eq('severity', 'critical'),
      admin.from('verification_runs').select('id', { count: 'exact', head: true }).gte('started_at', since)
    ]);
    res.json({
      open_findings: openCount || 0,
      critical_open: criticalOpen || 0,
      runs_last_24h: runs24h || 0
    });
  } catch (err) {
    next(err);
  }
});
