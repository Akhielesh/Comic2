import { Router } from 'express';
import { requireModerator, hydrateAccessProfile } from '../middleware/requireAdmin.js';
import { resolveAccessProfile } from '../services/rbac.js';
import { getSupabaseAdmin } from '../services/supabase.js';

const moderationRouter = Router();

const nowIso = () => new Date().toISOString();

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

moderationRouter.get('/projects/queue', requireModerator, async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 50);
    const offset = parseCursorOffset(req.query.cursor);
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('projects')
      .select('id, user_id, name, is_public, is_forced_private, forced_private_reason, forced_private_at, republish_request_status, republish_request_reason, republish_requested_at, republish_reviewed_at, republish_review_reason')
      .or('is_forced_private.eq.true,republish_request_status.eq.pending')
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    const rows = (data || []) as Array<Record<string, unknown>>;
    const items = rows.map((row) => {
      const statusRaw = String(row.republish_request_status || 'none').toLowerCase();
      const republishRequestStatus = statusRaw === 'pending' || statusRaw === 'approved' || statusRaw === 'rejected'
        ? statusRaw
        : 'none';
      return {
        projectId: String(row.id || ''),
        ownerUserId: String(row.user_id || ''),
        projectName: typeof row.name === 'string' ? row.name : undefined,
        isPublic: row.is_public === true,
        isForcedPrivate: row.is_forced_private === true,
        forcedPrivateReason: typeof row.forced_private_reason === 'string' ? row.forced_private_reason : undefined,
        forcedPrivateAt: typeof row.forced_private_at === 'string' ? row.forced_private_at : undefined,
        republishRequestStatus,
        republishRequestReason: typeof row.republish_request_reason === 'string' ? row.republish_request_reason : undefined,
        republishRequestedAt: typeof row.republish_requested_at === 'string' ? row.republish_requested_at : undefined,
        republishReviewedAt: typeof row.republish_reviewed_at === 'string' ? row.republish_reviewed_at : undefined,
        republishReviewReason: typeof row.republish_review_reason === 'string' ? row.republish_review_reason : undefined
      };
    });

    const nextCursor = items.length === limit ? String(offset + limit) : undefined;
    res.json({ items, nextCursor });
  } catch (error) {
    next(error);
  }
});

moderationRouter.post('/projects/:projectId/request-republish', async (req, res, next) => {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const projectId = String(req.params.projectId || '').trim();
    if (!projectId) {
      return res.status(400).json({ error: { message: 'projectId is required.' } });
    }
    const reason = String(req.body?.reason || '').trim();

    const admin = getSupabaseAdmin();
    const { data: project, error: projectError } = await admin
      .from('projects')
      .select('id, user_id, is_forced_private, republish_request_status')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project) {
      return res.status(404).json({ error: { message: 'Project not found.' } });
    }
    if (String(project.user_id) !== actorId) {
      return res.status(403).json({ error: { message: 'Only the project owner can request republish.' } });
    }
    if (project.is_forced_private !== true) {
      return res.status(409).json({ error: { message: 'Project is not currently forced private.' } });
    }

    await admin
      .from('projects')
      .update({
        republish_request_status: 'pending',
        republish_request_reason: reason || null,
        republish_requested_at: nowIso(),
        republish_requested_by: actorId
      })
      .eq('id', projectId);

    await admin
      .from('project_moderation_actions')
      .insert({
        project_id: projectId,
        owner_user_id: actorId,
        action: 'request_republish',
        reason: reason || null,
        acted_by: actorId,
        metadata: {
          source: 'creator_request'
        }
      });

    console.info('[MODERATION_ACTION] request_republish', {
      actorId,
      projectId
    });

    res.json({
      success: true,
      projectId,
      republishRequestStatus: 'pending'
    });
  } catch (error) {
    next(error);
  }
});

moderationRouter.post('/projects/:projectId/approve-republish', requireModerator, async (req, res, next) => {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const projectId = String(req.params.projectId || '').trim();
    const approve = req.body?.approve !== false;
    const reason = String(req.body?.reason || '').trim();
    if (!projectId) {
      return res.status(400).json({ error: { message: 'projectId is required.' } });
    }

    const admin = getSupabaseAdmin();
    const { data: project, error: projectError } = await admin
      .from('projects')
      .select('id, user_id, republish_request_status, is_forced_private')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project) {
      return res.status(404).json({ error: { message: 'Project not found.' } });
    }
    if (project.republish_request_status !== 'pending') {
      return res.status(409).json({ error: { message: 'Republish request is not pending.' } });
    }

    if (approve) {
      await admin
        .from('projects')
        .update({
          republish_request_status: 'approved',
          republish_reviewed_at: nowIso(),
          republish_reviewed_by: actorId,
          republish_review_reason: reason || null,
          is_forced_private: false,
          forced_private_reason: null,
          forced_private_by: null,
          forced_private_at: null
        })
        .eq('id', projectId);
    } else {
      await admin
        .from('projects')
        .update({
          republish_request_status: 'rejected',
          republish_reviewed_at: nowIso(),
          republish_reviewed_by: actorId,
          republish_review_reason: reason || null
        })
        .eq('id', projectId);
    }

    await admin
      .from('project_moderation_actions')
      .insert({
        project_id: projectId,
        owner_user_id: project.user_id,
        action: approve ? 'approve_republish' : 'reject_republish',
        reason: reason || null,
        acted_by: actorId,
        metadata: {
          source: 'moderation_review'
        }
      });

    await notifyModerationEvent({
      userId: String(project.user_id),
      actorId,
      entityId: projectId,
      title: approve ? 'Republish request approved' : 'Republish request rejected',
      message: approve
        ? `Your republish request was approved.${reason ? ` Reason: ${reason}` : ''}`
        : `Your republish request was rejected.${reason ? ` Reason: ${reason}` : ''}`,
      metadata: {
        action: approve ? 'approve_republish' : 'reject_republish',
        reason
      }
    });

    console.info('[MODERATION_ACTION] review_republish', {
      actorId,
      projectId,
      approve
    });

    res.json({
      success: true,
      projectId,
      republishRequestStatus: approve ? 'approved' : 'rejected'
    });
  } catch (error) {
    next(error);
  }
});

moderationRouter.post('/users/:userId/action', requireModerator, async (req, res, next) => {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const access = await hydrateAccessProfile(req);
    const targetUserId = String(req.params.userId || '').trim();
    const statusRaw = String(req.body?.status || '').trim().toLowerCase();
    const reason = String(req.body?.reason || '').trim();
    if (!targetUserId || (statusRaw !== 'active' && statusRaw !== 'restricted' && statusRaw !== 'suspended')) {
      return res.status(400).json({
        error: { message: 'status is required. Allowed values: active, restricted, suspended.' }
      });
    }
    if (targetUserId === actorId && statusRaw !== 'active') {
      return res.status(400).json({ error: { message: 'You cannot restrict your own account.' } });
    }

    const admin = getSupabaseAdmin();
    const { data: targetProfile } = await admin
      .from('profiles')
      .select('id, email')
      .eq('id', targetUserId)
      .maybeSingle();

    if (!targetProfile) {
      return res.status(404).json({ error: { message: 'Target user not found.' } });
    }

    const targetAccess = await resolveAccessProfile({
      userId: targetUserId,
      email: typeof targetProfile.email === 'string' ? targetProfile.email : undefined
    });

    if (!access.isAdmin && targetAccess.isAdmin) {
      return res.status(403).json({ error: { message: 'Only admins can moderate admin accounts.' } });
    }

    await admin
      .from('user_moderation_status')
      .upsert({
        user_id: targetUserId,
        status: statusRaw,
        reason: reason || null,
        updated_by: actorId,
        updated_at: nowIso()
      }, { onConflict: 'user_id' });

    if (targetUserId !== actorId) {
      await notifyModerationEvent({
        userId: targetUserId,
        actorId,
        title: 'Account moderation update',
        message: `Your account status is now "${statusRaw}".${reason ? ` Reason: ${reason}` : ''}`,
        metadata: {
          action: 'user_moderation_status',
          status: statusRaw,
          reason
        }
      });
    }

    console.info('[MODERATION_ACTION] user_status', {
      actorId,
      targetUserId,
      status: statusRaw
    });

    res.json({
      success: true,
      targetUserId,
      status: statusRaw,
      reason: reason || undefined
    });
  } catch (error) {
    next(error);
  }
});

export { moderationRouter };
