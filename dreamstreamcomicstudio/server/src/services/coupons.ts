import type {
  AdminCouponAssignment,
  AdminCouponDefinition,
  AdminCouponRedemptionEvent,
  BillingCouponEntitlement,
  BillingPlanTier,
  CouponEntitlementPolicy
} from '../../../shared/types/billing.js';
import { getSupabaseAdmin } from './supabase.js';

const nowIso = () => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toNonNegativeInt = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
};

const toBooleanOrUndefined = (value: unknown): boolean | undefined => {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
};

const toIso = (value: unknown, label: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid date.`);
  }
  return parsed.toISOString();
};

const normalizeCode = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!raw) throw new Error('Coupon code is required.');
  if (!/^[A-Z0-9_-]{4,64}$/.test(raw)) {
    throw new Error('Coupon code must be 4-64 chars (A-Z, 0-9, _, -).');
  }
  return raw;
};

const normalizeEmail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
};

const toPlanTier = (value: unknown): BillingPlanTier | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'free' || normalized === 'creator' || normalized === 'pro' || normalized === 'studio' || normalized === 'custom' || normalized === 'admin') {
    return normalized;
  }
  return undefined;
};

const normalizePolicy = (value: unknown): CouponEntitlementPolicy => {
  const raw = isRecord(value) ? value : {};

  const policy: CouponEntitlementPolicy = {
    planTierOverride: toPlanTier(raw.planTierOverride),
    includedMonthlyCtOverride: toNonNegativeInt(raw.includedMonthlyCtOverride),
    dailyGuardrailCtOverride: toNonNegativeInt(raw.dailyGuardrailCtOverride),
    includedMonthlyCtBonus: toNonNegativeInt(raw.includedMonthlyCtBonus),
    dailyGuardrailCtBonus: toNonNegativeInt(raw.dailyGuardrailCtBonus),
    bonusCt: toNonNegativeInt(raw.bonusCt),
    overageEnabledOverride: toBooleanOrUndefined(raw.overageEnabledOverride)
  };

  const hasEffect = Object.values(policy).some((entry) => entry !== undefined);
  if (!hasEffect) {
    throw new Error('Coupon policy must include at least one entitlement field.');
  }

  return policy;
};

const sanitizePolicy = (value: unknown): CouponEntitlementPolicy => {
  try {
    return normalizePolicy(value);
  } catch {
    return {};
  }
};

const mapDefinition = (row: Record<string, unknown>): AdminCouponDefinition => ({
  id: String(row.id),
  code: String(row.code),
  startsAt: String(row.starts_at),
  endsAt: String(row.ends_at),
  isActive: Boolean(row.is_active),
  policy: sanitizePolicy(row.policy),
  createdAt: String(row.created_at || nowIso()),
  updatedAt: String(row.updated_at || nowIso())
});

const mapAssignment = (row: Record<string, unknown>): AdminCouponAssignment => {
  const definition = isRecord(row.coupon_definitions) ? row.coupon_definitions : null;
  return {
    id: String(row.id),
    couponDefinitionId: String(row.coupon_definition_id),
    couponCode: String(definition?.code || row.coupon_code || ''),
    userId: typeof row.user_id === 'string' ? row.user_id : undefined,
    email: typeof row.email === 'string' ? row.email : undefined,
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    isActive: Boolean(row.is_active),
    isRedeemed: Boolean(row.is_redeemed),
    redeemedAt: typeof row.redeemed_at === 'string' ? row.redeemed_at : undefined,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : undefined,
    revokeReason: typeof row.revoke_reason === 'string' ? row.revoke_reason : undefined,
    createdAt: String(row.created_at || nowIso()),
    updatedAt: String(row.updated_at || nowIso())
  };
};

const mapEvent = (row: Record<string, unknown>): AdminCouponRedemptionEvent => ({
  id: String(row.id),
  couponDefinitionId: typeof row.coupon_definition_id === 'string' ? row.coupon_definition_id : '',
  assignmentId: typeof row.assignment_id === 'string' ? row.assignment_id : undefined,
  userId: typeof row.user_id === 'string' ? row.user_id : undefined,
  email: typeof row.email === 'string' ? row.email : undefined,
  couponCode: String(row.coupon_code || ''),
  outcome: String(row.outcome || 'unknown'),
  reason: typeof row.reason === 'string' ? row.reason : undefined,
  createdAt: String(row.created_at || nowIso())
});

const mapEntitlement = (assignment: Record<string, unknown>, definition: Record<string, unknown>): BillingCouponEntitlement => ({
  assignmentId: String(assignment.id),
  couponDefinitionId: String(definition.id),
  couponCode: String(definition.code),
  startsAt: String(assignment.starts_at || definition.starts_at),
  endsAt: String(assignment.ends_at || definition.ends_at),
  policy: sanitizePolicy(definition.policy)
});

const expireOutdatedCoupons = async () => {
  const admin = getSupabaseAdmin();
  const now = nowIso();

  await admin
    .from('coupon_definitions')
    .update({
      is_active: false,
      updated_at: now
    })
    .eq('is_active', true)
    .lte('ends_at', now);

  await admin
    .from('coupon_assignments')
    .update({
      is_active: false,
      updated_at: now
    })
    .eq('is_active', true)
    .lte('ends_at', now);
};

const writeRedemptionEvent = async (input: {
  couponDefinitionId?: string;
  assignmentId?: string;
  userId?: string;
  email?: string;
  couponCode: string;
  outcome: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) => {
  const admin = getSupabaseAdmin();
  await admin
    .from('coupon_redemption_events')
    .insert({
      coupon_definition_id: input.couponDefinitionId || null,
      assignment_id: input.assignmentId || null,
      user_id: input.userId || null,
      email: input.email || null,
      coupon_code: input.couponCode,
      outcome: input.outcome,
      reason: input.reason || null,
      metadata: input.metadata || {},
      created_at: nowIso()
    });
};

const isWithinWindow = (startsAt: string, endsAt: string, nowMs: number) => {
  const startMs = new Date(startsAt).getTime();
  const endMs = new Date(endsAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return nowMs >= startMs && nowMs < endMs;
};

const assignmentMatchesTarget = (
  assignment: Record<string, unknown>,
  userId: string,
  email?: string
) => {
  const assignmentUserId = typeof assignment.user_id === 'string' ? assignment.user_id : undefined;
  const assignmentEmail = normalizeEmail(assignment.email);

  if (assignmentUserId && assignmentUserId === userId) return true;
  if (assignmentEmail && email && assignmentEmail === email) return true;
  return false;
};

const selectDefinitionByCode = async (code: string) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('coupon_definitions')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (error || !data || !isRecord(data)) {
    return null;
  }

  return data;
};

const selectAssignmentsForDefinition = async (definitionId: string) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('coupon_assignments')
    .select('*')
    .eq('coupon_definition_id', definitionId)
    .is('revoked_at', null)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error || !Array.isArray(data)) return [];
  return data.filter((row) => isRecord(row)) as Record<string, unknown>[];
};

export const getActiveCouponEntitlementForUser = async (input: {
  userId: string;
  email?: string;
}): Promise<BillingCouponEntitlement | null> => {
  await expireOutdatedCoupons();

  const normalizedEmail = normalizeEmail(input.email);
  const admin = getSupabaseAdmin();
  const now = nowIso();
  const { data, error } = await admin
    .from('coupon_assignments')
    .select('id, coupon_definition_id, user_id, email, starts_at, ends_at, is_active, is_redeemed, coupon_definitions(id, code, starts_at, ends_at, is_active, policy)')
    .eq('is_active', true)
    .eq('is_redeemed', true)
    .is('revoked_at', null)
    .lte('starts_at', now)
    .gt('ends_at', now)
    .order('redeemed_at', { ascending: false })
    .limit(100);

  if (error || !Array.isArray(data)) return null;

  const nowMs = Date.now();
  for (const row of data) {
    if (!isRecord(row) || !assignmentMatchesTarget(row, input.userId, normalizedEmail)) continue;
    const definition = isRecord(row.coupon_definitions) ? row.coupon_definitions : null;
    if (!definition) continue;
    if (definition.is_active !== true) continue;
    if (!isWithinWindow(String(definition.starts_at), String(definition.ends_at), nowMs)) continue;
    return mapEntitlement(row, definition);
  }

  return null;
};

export const redeemAssignedCoupon = async (input: {
  userId: string;
  email?: string;
  couponCode: string;
}): Promise<{
  success: boolean;
  message: string;
  entitlement?: BillingCouponEntitlement;
  bonusCt?: number;
}> => {
  await expireOutdatedCoupons();

  const couponCode = normalizeCode(input.couponCode);
  const normalizedEmail = normalizeEmail(input.email);
  const definition = await selectDefinitionByCode(couponCode);

  if (!definition) {
    await writeRedemptionEvent({
      couponCode,
      userId: input.userId,
      email: normalizedEmail,
      outcome: 'rejected',
      reason: 'coupon_not_found'
    });
    return { success: false, message: 'Invalid or expired code.' };
  }

  const nowMs = Date.now();
  if (definition.is_active !== true || !isWithinWindow(String(definition.starts_at), String(definition.ends_at), nowMs)) {
    await writeRedemptionEvent({
      couponCode,
      couponDefinitionId: String(definition.id),
      userId: input.userId,
      email: normalizedEmail,
      outcome: 'rejected',
      reason: 'coupon_inactive_or_expired'
    });
    return { success: false, message: 'Coupon is inactive or expired.' };
  }

  const assignments = await selectAssignmentsForDefinition(String(definition.id));
  const candidates = assignments.filter((assignment) => assignmentMatchesTarget(assignment, input.userId, normalizedEmail));

  const now = nowIso();
  const redeemable = candidates.find((assignment) =>
    assignment.is_redeemed !== true
    && isWithinWindow(String(assignment.starts_at), String(assignment.ends_at), nowMs)
  );

  if (!redeemable) {
    const alreadyRedeemed = candidates.some((assignment) => assignment.is_redeemed === true);
    await writeRedemptionEvent({
      couponCode,
      couponDefinitionId: String(definition.id),
      userId: input.userId,
      email: normalizedEmail,
      outcome: 'rejected',
      reason: alreadyRedeemed ? 'already_redeemed' : 'assignment_not_found_or_expired'
    });
    return {
      success: false,
      message: alreadyRedeemed
        ? 'Coupon already redeemed for this account.'
        : 'This coupon is not assigned to your account or is expired.'
    };
  }

  const admin = getSupabaseAdmin();
  const { data: updated, error } = await admin
    .from('coupon_assignments')
    .update({
      is_redeemed: true,
      redeemed_at: now,
      redeemed_by: input.userId,
      user_id: typeof redeemable.user_id === 'string' ? redeemable.user_id : input.userId,
      updated_at: now
    })
    .eq('id', redeemable.id)
    .eq('is_redeemed', false)
    .eq('is_active', true)
    .is('revoked_at', null)
    .select('*')
    .maybeSingle();

  if (error || !updated || !isRecord(updated)) {
    await writeRedemptionEvent({
      couponCode,
      couponDefinitionId: String(definition.id),
      assignmentId: String(redeemable.id),
      userId: input.userId,
      email: normalizedEmail,
      outcome: 'rejected',
      reason: 'concurrent_redeem_conflict'
    });
    return {
      success: false,
      message: 'Coupon could not be redeemed. Please try again.'
    };
  }

  const entitlement = mapEntitlement(updated, definition);
  const policy = sanitizePolicy(definition.policy);

  await writeRedemptionEvent({
    couponCode,
    couponDefinitionId: String(definition.id),
    assignmentId: String(updated.id),
    userId: input.userId,
    email: normalizedEmail,
    outcome: 'redeemed',
    reason: 'success',
    metadata: {
      bonusCt: policy.bonusCt || 0
    }
  });

  return {
    success: true,
    message: 'Coupon redeemed successfully.',
    entitlement,
    bonusCt: policy.bonusCt || 0
  };
};

export const createCouponDefinition = async (input: {
  code: string;
  startsAt: string;
  endsAt: string;
  policy: unknown;
  createdBy?: string;
}) => {
  const code = normalizeCode(input.code);
  const startsAt = toIso(input.startsAt, 'startsAt');
  const endsAt = toIso(input.endsAt, 'endsAt');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('endsAt must be after startsAt.');
  }

  const policy = normalizePolicy(input.policy);

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('coupon_definitions')
    .insert({
      code,
      starts_at: startsAt,
      ends_at: endsAt,
      policy,
      is_active: true,
      created_by: input.createdBy || null,
      created_at: nowIso(),
      updated_at: nowIso()
    })
    .select('*')
    .single();

  if (error || !data || !isRecord(data)) {
    throw new Error(error?.message || 'Failed to create coupon definition.');
  }

  return mapDefinition(data);
};

export const assignCouponDefinition = async (input: {
  couponDefinitionId: string;
  userId?: string;
  email?: string;
  startsAt: string;
  endsAt: string;
  createdBy?: string;
}) => {
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : undefined;
  const email = normalizeEmail(input.email);
  if (!userId && !email) {
    throw new Error('Assign coupon requires userId or email.');
  }

  const startsAt = toIso(input.startsAt, 'startsAt');
  const endsAt = toIso(input.endsAt, 'endsAt');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('endsAt must be after startsAt.');
  }

  const admin = getSupabaseAdmin();
  const { data: definition, error: definitionError } = await admin
    .from('coupon_definitions')
    .select('id, code, starts_at, ends_at, is_active')
    .eq('id', input.couponDefinitionId)
    .maybeSingle();

  if (definitionError || !definition || !isRecord(definition)) {
    throw new Error('Coupon definition not found.');
  }

  if (definition.is_active !== true) {
    throw new Error('Coupon definition is inactive.');
  }

  const definitionStart = new Date(String(definition.starts_at)).getTime();
  const definitionEnd = new Date(String(definition.ends_at)).getTime();
  if (new Date(startsAt).getTime() < definitionStart || new Date(endsAt).getTime() > definitionEnd) {
    throw new Error('Assignment window must be within coupon definition window.');
  }

  const { data, error } = await admin
    .from('coupon_assignments')
    .insert({
      coupon_definition_id: input.couponDefinitionId,
      user_id: userId || null,
      email: email || null,
      starts_at: startsAt,
      ends_at: endsAt,
      is_active: true,
      is_redeemed: false,
      metadata: {
        createdBy: input.createdBy || null
      },
      created_at: nowIso(),
      updated_at: nowIso()
    })
    .select('*, coupon_definitions(code)')
    .single();

  if (error || !data || !isRecord(data)) {
    throw new Error(error?.message || 'Failed to assign coupon.');
  }

  return mapAssignment(data);
};

export const revokeCouponAssignment = async (input: {
  assignmentId: string;
  revokedBy?: string;
  reason?: string;
}) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('coupon_assignments')
    .update({
      is_active: false,
      revoked_at: nowIso(),
      revoked_by: input.revokedBy || null,
      revoke_reason: input.reason || null,
      updated_at: nowIso()
    })
    .eq('id', input.assignmentId)
    .is('revoked_at', null)
    .select('*, coupon_definitions(code)')
    .maybeSingle();

  if (error || !data || !isRecord(data)) {
    throw new Error(error?.message || 'Failed to revoke assignment.');
  }

  return mapAssignment(data);
};

export const listCouponAdminState = async (input?: { limit?: number }) => {
  await expireOutdatedCoupons();

  const safeLimit = Math.max(10, Math.min(500, Math.floor(Number(input?.limit || 100))));
  const admin = getSupabaseAdmin();

  const [{ data: definitions }, { data: assignments }, { data: events }] = await Promise.all([
    admin
      .from('coupon_definitions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit),
    admin
      .from('coupon_assignments')
      .select('*, coupon_definitions(code)')
      .order('created_at', { ascending: false })
      .limit(safeLimit * 2),
    admin
      .from('coupon_redemption_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit * 3)
  ]);

  return {
    definitions: Array.isArray(definitions)
      ? definitions.filter((row) => isRecord(row)).map((row) => mapDefinition(row))
      : [],
    assignments: Array.isArray(assignments)
      ? assignments.filter((row) => isRecord(row)).map((row) => mapAssignment(row))
      : [],
    events: Array.isArray(events)
      ? events.filter((row) => isRecord(row)).map((row) => mapEvent(row))
      : []
  };
};
