import { NextFunction, Request, Response, Router } from 'express';
import type { BillingPlanTier } from '../../../shared/types/billing.js';
import { setUserPlanTier } from '../services/billingLedger.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { hydrateAccessProfile, requireAdmin, requireModerator } from '../middleware/requireAdmin.js';

const readablePlanTiers: BillingPlanTier[] = ['free', 'creator', 'pro', 'studio', 'custom', 'admin'];
const assignablePlanTiers: BillingPlanTier[] = ['free', 'creator', 'studio', 'custom', 'admin'];
const allowedRoles = ['admin', 'moderator'] as const;
type AllowedRole = typeof allowedRoles[number];

const adminRouter = Router();

const parseLimit = (value: unknown, fallback = 50) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
};

const parseCursorOffset = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const maskEmail = (email?: string | null) => {
  const normalized = String(email || '').trim();
  if (!normalized || !normalized.includes('@')) return undefined;
  const [name, domain] = normalized.split('@');
  if (!name || !domain) return undefined;
  const visible = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${visible}***@${domain}`;
};

const nowIso = () => new Date().toISOString();

const isMissingColumnError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42703';
};

const notifyModerationEvent = async (input: {
  userId: string;
  actorId: string;
  entityId?: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}) => {
  const admin = getSupabaseAdmin();
  const payload = {
    user_id: input.userId,
    actor_id: input.actorId,
    type: 'system',
    entity_id: input.entityId,
    title: input.title,
    message: input.message,
    metadata: input.metadata || {}
  };

  const { error } = await admin.from('notifications').insert(payload);
  if (!error) return;
  if (!isMissingColumnError(error)) {
    return;
  }
  await admin.from('notifications').insert({
    user_id: input.userId,
    actor_id: input.actorId,
    type: 'system',
    entity_id: input.entityId
  });
};

const resolveActiveAdminCount = async () => {
  const admin = getSupabaseAdmin();
  const [{ data: roleRows }, { data: bootstrapRows }] = await Promise.all([
    admin
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')
      .eq('is_active', true),
    admin
      .from('profiles')
      .select('id, email')
  ]);

  const admins = new Set<string>();
  for (const row of (roleRows || []) as Array<Record<string, unknown>>) {
    const userId = typeof row.user_id === 'string' ? row.user_id : '';
    if (userId) admins.add(userId);
  }

  const configuredEmails = (process.env.ADMIN_EMAILS || 'admin@test.com')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  for (const row of (bootstrapRows || []) as Array<Record<string, unknown>>) {
    const email = String(row.email || '').toLowerCase();
    const userId = typeof row.id === 'string' ? row.id : '';
    if (userId && configuredEmails.includes(email)) {
      admins.add(userId);
    }
  }

  return admins.size;
};

adminRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const access = await hydrateAccessProfile(req);
    res.json({
      userId: req.user.id,
      isAdmin: access.isAdmin,
      isModerator: access.isModerator,
      bootstrapAdmin: access.bootstrapAdmin,
      roles: access.roles
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/users', requireModerator, async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const access = await hydrateAccessProfile(req);
    const canSeeEmail = access.isAdmin;
    const limit = parseLimit(req.query.limit, 50);
    const offset = parseCursorOffset(req.query.cursor);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const admin = getSupabaseAdmin();
    let profilesQuery = admin
      .from('profiles')
      .select('id, username, email, created_at, updated_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (q) {
      const escaped = q.replace(/[%_]/g, '');
      profilesQuery = profilesQuery.or(`username.ilike.%${escaped}%,email.ilike.%${escaped}%`);
    }

    const { data: profiles, error: profilesError } = await profilesQuery;
    if (profilesError) throw profilesError;

    const profileRows = (profiles || []) as Array<Record<string, unknown>>;
    const userIds = profileRows
      .map((row) => (typeof row.id === 'string' ? row.id : ''))
      .filter(Boolean);

    const [
      { data: plans },
      { data: roles },
      { data: moderation }
    ] = await Promise.all([
      userIds.length
        ? admin
            .from('user_plan_subscriptions')
            .select('user_id, plan_tier, status')
            .in('user_id', userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      userIds.length
        ? admin
            .from('user_roles')
            .select('user_id, role, is_active')
            .in('user_id', userIds)
            .eq('is_active', true)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      userIds.length
        ? admin
            .from('user_moderation_status')
            .select('user_id, status, reason, updated_at')
            .in('user_id', userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> })
    ]);

    const planByUser = new Map<string, { planTier: BillingPlanTier; status?: string }>();
    for (const row of (plans || []) as Array<Record<string, unknown>>) {
      const userId = typeof row.user_id === 'string' ? row.user_id : '';
      if (!userId) continue;
      const tier = String(row.plan_tier || 'free').toLowerCase();
      const normalizedTier = readablePlanTiers.includes(tier as BillingPlanTier) ? tier as BillingPlanTier : 'free';
      planByUser.set(userId, {
        planTier: normalizedTier,
        status: typeof row.status === 'string' ? row.status : undefined
      });
    }

    const rolesByUser = new Map<string, AllowedRole[]>();
    for (const row of (roles || []) as Array<Record<string, unknown>>) {
      const userId = typeof row.user_id === 'string' ? row.user_id : '';
      const role = String(row.role || '').toLowerCase();
      if (!userId || (role !== 'admin' && role !== 'moderator')) continue;
      const current = rolesByUser.get(userId) || [];
      if (!current.includes(role as AllowedRole)) {
        current.push(role as AllowedRole);
      }
      rolesByUser.set(userId, current);
    }

    const moderationByUser = new Map<string, { status: 'active' | 'restricted' | 'suspended'; reason?: string }>();
    for (const row of (moderation || []) as Array<Record<string, unknown>>) {
      const userId = typeof row.user_id === 'string' ? row.user_id : '';
      if (!userId) continue;
      const statusRaw = String(row.status || 'active').toLowerCase();
      const status = statusRaw === 'restricted' || statusRaw === 'suspended'
        ? statusRaw
        : 'active';
      moderationByUser.set(userId, {
        status,
        reason: typeof row.reason === 'string' ? row.reason : undefined
      });
    }

    const items = profileRows.map((row) => {
      const userId = typeof row.id === 'string' ? row.id : '';
      const email = typeof row.email === 'string' ? row.email : undefined;
      const plan = planByUser.get(userId);
      const moderationStatus = moderationByUser.get(userId);
      return {
        userId,
        username: typeof row.username === 'string' ? row.username : undefined,
        email: canSeeEmail ? email : undefined,
        maskedEmail: canSeeEmail ? undefined : maskEmail(email),
        planTier: plan?.planTier || 'free',
        subscriptionStatus: plan?.status,
        roles: rolesByUser.get(userId) || [],
        moderationStatus: moderationStatus?.status || 'active',
        moderationReason: moderationStatus?.reason,
        createdAt: typeof row.created_at === 'string' ? row.created_at : undefined,
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined
      };
    });

    const nextCursor = items.length === limit ? String(offset + limit) : undefined;
    res.json({ items, nextCursor });
  } catch (error) {
    next(error);
  }
});

const handleUserPlanUpdate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const targetUserId = String(req.params.userId || '').trim();
    if (!targetUserId) {
      return res.status(400).json({ error: { message: 'userId is required' } });
    }

    const removePlanStatus = req.body?.removePlanStatus === true;
    const rawPlanTier = String(req.body?.planTier || '').trim().toLowerCase();
    if (!removePlanStatus && !assignablePlanTiers.includes(rawPlanTier as BillingPlanTier)) {
      return res.status(400).json({
        error: { message: 'Invalid plan tier. Allowed values: free, creator, studio, custom, admin.' }
      });
    }
    const planTier: BillingPlanTier = removePlanStatus
      ? 'free'
      : rawPlanTier as BillingPlanTier;

    const summary = await setUserPlanTier(targetUserId, planTier, {
      source: 'admin_plan_override',
      actorUserId: actorId,
      removePlanStatus
    });

    const admin = getSupabaseAdmin();
    await admin
      .from('user_plan_subscriptions')
      .upsert({
        user_id: targetUserId,
        plan_tier: planTier,
        status: planTier === 'free' ? 'inactive' : 'active',
        updated_at: nowIso(),
        metadata: {
          source: 'admin_plan_override',
          actorUserId: actorId,
          removePlanStatus
        }
      }, { onConflict: 'user_id' });

    console.info('[ADMIN_ACTION] plan_update', {
      actorId,
      targetUserId,
      planTier,
      removePlanStatus
    });

    res.json({
      success: true,
      targetUserId,
      planTier,
      removedPlanStatus: removePlanStatus,
      summary
    });
  } catch (error) {
    next(error);
  }
};

adminRouter.patch('/users/:userId/plan', requireAdmin, handleUserPlanUpdate);
adminRouter.post('/users/:userId/plan', requireAdmin, handleUserPlanUpdate);

const handleUserRoleUpdate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const targetUserId = String(req.params.userId || '').trim();
    const role = String(req.body?.role || '').trim().toLowerCase();
    const action = String(req.body?.action || '').trim().toLowerCase();
    if (!targetUserId || (role !== 'admin' && role !== 'moderator') || (action !== 'grant' && action !== 'revoke')) {
      return res.status(400).json({ error: { message: 'role and action are required. role: admin|moderator, action: grant|revoke' } });
    }

    const admin = getSupabaseAdmin();
    if (role === 'admin' && action === 'revoke') {
      const activeAdminCount = await resolveActiveAdminCount();
      if (activeAdminCount <= 1) {
        return res.status(409).json({
          error: { message: 'Cannot remove the last active admin account.' }
        });
      }
    }

    if (action === 'grant') {
      await admin
        .from('user_roles')
        .upsert({
          user_id: targetUserId,
          role,
          is_active: true,
          granted_by: actorId,
          updated_at: nowIso()
        }, { onConflict: 'user_id,role' });
    } else {
      await admin
        .from('user_roles')
        .update({
          is_active: false,
          updated_at: nowIso()
        })
        .eq('user_id', targetUserId)
        .eq('role', role)
        .eq('is_active', true);
    }

    console.info('[ADMIN_ACTION] role_update', {
      actorId,
      targetUserId,
      role,
      action
    });

    res.json({
      success: true,
      targetUserId,
      role,
      action
    });
  } catch (error) {
    next(error);
  }
};

adminRouter.patch('/users/:userId/role', requireAdmin, handleUserRoleUpdate);
adminRouter.post('/users/:userId/role', requireAdmin, handleUserRoleUpdate);

adminRouter.post('/projects/:projectId/force-private', requireModerator, async (req, res, next) => {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const projectId = String(req.params.projectId || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!projectId || !reason) {
      return res.status(400).json({ error: { message: 'projectId and reason are required.' } });
    }

    const admin = getSupabaseAdmin();
    const { data: project, error: projectError } = await admin
      .from('projects')
      .select('id, user_id, name, is_public')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project) {
      return res.status(404).json({ error: { message: 'Project not found.' } });
    }

    await admin
      .from('projects')
      .update({
        is_public: false,
        is_forced_private: true,
        forced_private_reason: reason,
        forced_private_by: actorId,
        forced_private_at: nowIso(),
        republish_request_status: 'none',
        republish_review_reason: null
      })
      .eq('id', projectId);

    await admin
      .from('project_moderation_actions')
      .insert({
        project_id: projectId,
        owner_user_id: project.user_id,
        action: 'force_private',
        reason,
        acted_by: actorId,
        metadata: {
          source: 'admin_route'
        }
      });

    await notifyModerationEvent({
      userId: String(project.user_id),
      actorId,
      entityId: projectId,
      title: 'Comic made private by moderation',
      message: `A moderator made your comic private. Reason: ${reason}`,
      metadata: {
        reason,
        action: 'force_private'
      }
    });

    console.info('[ADMIN_ACTION] force_private', {
      actorId,
      projectId,
      ownerUserId: project.user_id
    });

    res.json({
      success: true,
      projectId,
      ownerUserId: project.user_id,
      reason
    });
  } catch (error) {
    next(error);
  }
});

export { adminRouter };
