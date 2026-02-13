import crypto from 'node:crypto';
import type {
  AdminCouponAssignment,
  AdminCouponDefinition,
  AdminCouponRedemptionEvent,
  CouponPreviewResult,
  CouponRedemptionResult
} from '../../../shared/types/billing.js';
import { getSupabaseAdmin } from './supabase.js';

const nowIso = () => new Date().toISOString();
const EXPIRY_WARNING_MS = 72 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toInt = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.floor(numeric);
};

const toOptionalInt = (value: unknown): number | undefined => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.floor(numeric);
};

const normalizeCode = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!raw) throw new Error('Coupon code is required.');
  if (!/^[A-Z0-9-]{6,64}$/.test(raw)) {
    throw new Error('Coupon code must be 6-64 chars (A-Z, 0-9, -).');
  }
  return raw;
};

const normalizeEmail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
};

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

const createDeprecatedCouponOperationError = () => {
  const error = new Error('Coupon assignment workflow is deprecated. Use admin generated single-use coupons.') as Error & {
    status?: number;
    publicCode?: string;
  };
  error.status = 410;
  error.publicCode = 'ENDPOINT_DEPRECATED';
  return error;
};

const computeCouponStatus = (row: Record<string, unknown>, atMs = Date.now()) => {
  const startsAt = String(row.starts_at || nowIso());
  const endsAt = String(row.ends_at || nowIso());
  const isActive = row.is_active !== false;
  const maxRedemptions = Math.max(1, toInt(row.max_redemptions, 1));
  const redemptionCount = Math.max(0, toInt(row.redemption_count, 0));

  const startMs = new Date(startsAt).getTime();
  const endMs = new Date(endsAt).getTime();

  if (!isActive) return { status: 'inactive' as const, isRedeemableNow: false };
  if (Number.isFinite(startMs) && atMs < startMs) return { status: 'scheduled' as const, isRedeemableNow: false };
  if (!Number.isFinite(endMs) || atMs >= endMs) return { status: 'expired' as const, isRedeemableNow: false };
  if (redemptionCount >= maxRedemptions) return { status: 'exhausted' as const, isRedeemableNow: false };
  return { status: 'active' as const, isRedeemableNow: true };
};

const computeExpiryWarning = (endsAt: string, atMs = Date.now()) => {
  const endMs = new Date(endsAt).getTime();
  if (!Number.isFinite(endMs) || endMs <= atMs) {
    return { expiresSoon: false, expiresInHours: undefined as number | undefined };
  }
  const remainingMs = endMs - atMs;
  const expiresSoon = remainingMs <= EXPIRY_WARNING_MS;
  return {
    expiresSoon,
    expiresInHours: Math.ceil(remainingMs / (60 * 60 * 1000))
  };
};

const mapDefinition = (row: Record<string, unknown>): AdminCouponDefinition => {
  const startsAt = String(row.starts_at || nowIso());
  const endsAt = String(row.ends_at || nowIso());
  const tokenAmountCt = Math.max(0, toInt(row.token_amount_ct, 0));
  const maxRedemptions = Math.max(1, toInt(row.max_redemptions, 1));
  const redemptionCount = Math.max(0, toInt(row.redemption_count, 0));
  const remainingRedemptions = Math.max(0, maxRedemptions - redemptionCount);
  const state = computeCouponStatus(row);
  const warning = computeExpiryWarning(endsAt);

  return {
    id: String(row.id),
    code: String(row.code),
    tokenAmountCt,
    startsAt,
    endsAt,
    isActive: row.is_active !== false,
    couponMode: String(row.coupon_mode || 'legacy') === 'single_use_global' ? 'single_use_global' : 'legacy',
    maxRedemptions,
    redemptionCount,
    remainingRedemptions,
    firstRedeemedAt: typeof row.first_redeemed_at === 'string' ? row.first_redeemed_at : undefined,
    lastRedeemedAt: typeof row.last_redeemed_at === 'string' ? row.last_redeemed_at : undefined,
    firstRedeemedBy: typeof row.first_redeemed_by === 'string' ? row.first_redeemed_by : undefined,
    lastRedeemedBy: typeof row.last_redeemed_by === 'string' ? row.last_redeemed_by : undefined,
    status: state.status,
    isRedeemableNow: state.isRedeemableNow,
    warningExpiresSoon: warning.expiresSoon,
    createdAt: String(row.created_at || nowIso()),
    updatedAt: String(row.updated_at || nowIso())
  };
};

const mapAssignment = (row: Record<string, unknown>): AdminCouponAssignment => {
  const definition = isRecord(row.coupon_definitions) ? row.coupon_definitions : null;
  return {
    id: String(row.id),
    couponDefinitionId: String(row.coupon_definition_id),
    couponCode: String(definition?.code || ''),
    userId: typeof row.user_id === 'string' ? row.user_id : undefined,
    email: typeof row.email === 'string' ? row.email : undefined,
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    isActive: row.is_active === true,
    isRedeemed: row.is_redeemed === true,
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
  tokenAmountCt: isRecord(row.metadata) ? toOptionalInt(row.metadata.tokenAmountCt) : undefined,
  redemptionCount: isRecord(row.metadata) ? toOptionalInt(row.metadata.redemptionCount) : undefined,
  createdAt: String(row.created_at || nowIso())
});

const writeRedemptionEvent = async (input: {
  couponDefinitionId?: string;
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
      user_id: input.userId || null,
      email: input.email || null,
      coupon_code: input.couponCode,
      outcome: input.outcome,
      reason: input.reason || null,
      metadata: input.metadata || {},
      created_at: nowIso()
    });
};

const selectDefinitionByCode = async (code: string) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('coupon_definitions')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (error || !data || !isRecord(data)) return null;
  return data;
};

const buildPreviewMessage = (definition: AdminCouponDefinition): string => {
  if (!definition.isActive) return 'Coupon is inactive.';
  if (definition.status === 'scheduled') return 'Coupon is not active yet.';
  if (definition.status === 'expired') return 'Coupon expired.';
  if (definition.status === 'exhausted') return 'Coupon already redeemed.';
  return 'Coupon is valid and ready to redeem.';
};

const toPreviewResult = (definition: Record<string, unknown>): CouponPreviewResult => {
  const mapped = mapDefinition(definition);
  const warning = computeExpiryWarning(mapped.endsAt);
  return {
    success: mapped.isRedeemableNow,
    message: buildPreviewMessage(mapped),
    couponCode: mapped.code,
    tokenAmountCt: mapped.tokenAmountCt,
    startsAt: mapped.startsAt,
    endsAt: mapped.endsAt,
    maxRedemptions: mapped.maxRedemptions,
    redemptionCount: mapped.redemptionCount,
    remainingRedemptions: mapped.remainingRedemptions,
    isActive: mapped.isActive,
    canRedeemNow: mapped.isRedeemableNow,
    warnings: warning
  };
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const randomCodeSegment = (length: number) => {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    const index = bytes[i] % CODE_ALPHABET.length;
    result += CODE_ALPHABET[index];
  }
  return result;
};

const generateCandidateCode = () => `${randomCodeSegment(4)}-${randomCodeSegment(4)}-${randomCodeSegment(4)}`;

const generateUniqueCode = async () => {
  const admin = getSupabaseAdmin();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generateCandidateCode();
    const { data, error } = await admin
      .from('coupon_definitions')
      .select('id')
      .eq('code', candidate)
      .maybeSingle();

    if (error) {
      throw new Error(error.message || 'Failed to validate coupon code uniqueness.');
    }

    if (!data) return candidate;
  }

  throw new Error('Failed to generate unique coupon code.');
};

const toPositiveInt = (value: unknown, fieldName: string, min = 1, max = 10_000_000) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.floor(numeric) !== numeric) {
    throw new Error(`${fieldName} must be an integer.`);
  }
  if (numeric < min || numeric > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}.`);
  }
  return numeric;
};

export const previewCoupon = async (input: {
  couponCode: string;
}): Promise<CouponPreviewResult> => {
  const couponCode = normalizeCode(input.couponCode);
  const definition = await selectDefinitionByCode(couponCode);

  if (!definition) {
    return {
      success: false,
      message: 'Invalid or expired code.',
      couponCode
    };
  }

  return toPreviewResult(definition);
};

export const redeemAssignedCoupon = async (input: {
  userId: string;
  email?: string;
  couponCode: string;
}): Promise<CouponRedemptionResult> => {
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
    return { success: false, message: 'Invalid or expired code.', couponCode };
  }

  const preview = toPreviewResult(definition);
  if (!preview.canRedeemNow) {
    await writeRedemptionEvent({
      couponCode,
      couponDefinitionId: String(definition.id),
      userId: input.userId,
      email: normalizedEmail,
      outcome: 'rejected',
      reason: preview.message.replace(/\s+/g, '_').toLowerCase(),
      metadata: {
        tokenAmountCt: preview.tokenAmountCt,
        redemptionCount: preview.redemptionCount,
        maxRedemptions: preview.maxRedemptions
      }
    });

    return {
      success: false,
      message: preview.message,
      couponCode,
      tokenAmountCt: preview.tokenAmountCt,
      startsAt: preview.startsAt,
      endsAt: preview.endsAt,
      maxRedemptions: preview.maxRedemptions,
      redemptionCount: preview.redemptionCount,
      remainingRedemptions: preview.remainingRedemptions,
      canRedeemNow: false,
      warnings: preview.warnings
    };
  }

  const now = nowIso();
  const admin = getSupabaseAdmin();
  const currentRedemptionCount = Math.max(0, toInt(definition.redemption_count, 0));
  const maxRedemptions = Math.max(1, toInt(definition.max_redemptions, 1));
  const firstRedeemedAt = typeof definition.first_redeemed_at === 'string' ? definition.first_redeemed_at : undefined;
  const firstRedeemedBy = typeof definition.first_redeemed_by === 'string' ? definition.first_redeemed_by : undefined;

  const { data: updated, error } = await admin
    .from('coupon_definitions')
    .update({
      redemption_count: currentRedemptionCount + 1,
      first_redeemed_at: firstRedeemedAt || now,
      first_redeemed_by: firstRedeemedBy || input.userId,
      last_redeemed_at: now,
      last_redeemed_by: input.userId,
      updated_at: now
    })
    .eq('id', definition.id)
    .eq('is_active', true)
    .lte('starts_at', now)
    .gt('ends_at', now)
    .lt('redemption_count', maxRedemptions)
    .select('*')
    .maybeSingle();

  if (error || !updated || !isRecord(updated)) {
    const latest = await selectDefinitionByCode(couponCode);
    const latestPreview = latest ? toPreviewResult(latest) : undefined;

    await writeRedemptionEvent({
      couponCode,
      couponDefinitionId: String(definition.id),
      userId: input.userId,
      email: normalizedEmail,
      outcome: 'rejected',
      reason: 'already_redeemed_or_unavailable',
      metadata: {
        tokenAmountCt: latestPreview?.tokenAmountCt,
        redemptionCount: latestPreview?.redemptionCount,
        maxRedemptions: latestPreview?.maxRedemptions
      }
    });

    return {
      success: false,
      message: latestPreview?.message || 'Coupon already redeemed or unavailable.',
      couponCode,
      tokenAmountCt: latestPreview?.tokenAmountCt,
      startsAt: latestPreview?.startsAt,
      endsAt: latestPreview?.endsAt,
      maxRedemptions: latestPreview?.maxRedemptions,
      redemptionCount: latestPreview?.redemptionCount,
      remainingRedemptions: latestPreview?.remainingRedemptions,
      canRedeemNow: latestPreview?.canRedeemNow,
      warnings: latestPreview?.warnings
    };
  }

  const mapped = mapDefinition(updated);
  const warning = computeExpiryWarning(mapped.endsAt);

  await writeRedemptionEvent({
    couponCode,
    couponDefinitionId: mapped.id,
    userId: input.userId,
    email: normalizedEmail,
    outcome: 'redeemed',
    reason: 'success',
    metadata: {
      tokenAmountCt: mapped.tokenAmountCt,
      redemptionCount: mapped.redemptionCount,
      maxRedemptions: mapped.maxRedemptions
    }
  });

  return {
    success: true,
    message: 'Coupon redeemed successfully.',
    couponCode: mapped.code,
    tokenAmountCt: mapped.tokenAmountCt,
    redeemedAt: now,
    startsAt: mapped.startsAt,
    endsAt: mapped.endsAt,
    maxRedemptions: mapped.maxRedemptions,
    redemptionCount: mapped.redemptionCount,
    remainingRedemptions: mapped.remainingRedemptions,
    canRedeemNow: mapped.isRedeemableNow,
    warnings: warning
  };
};

export const createCouponDefinition = async (input: {
  tokenAmountCt: number;
  validForHours: number;
  createdBy?: string;
}) => {
  const tokenAmountCt = toPositiveInt(input.tokenAmountCt, 'tokenAmountCt', 1, 50_000_000);
  const validForHours = toPositiveInt(input.validForHours, 'validForHours', 1, 24 * 365);
  const code = await generateUniqueCode();

  const startsAtDate = new Date();
  const endsAtDate = new Date(startsAtDate.getTime() + validForHours * 60 * 60 * 1000);
  const startsAt = startsAtDate.toISOString();
  const endsAt = endsAtDate.toISOString();

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('coupon_definitions')
    .insert({
      code,
      token_amount_ct: tokenAmountCt,
      starts_at: startsAt,
      ends_at: endsAt,
      is_active: true,
      max_redemptions: 1,
      redemption_count: 0,
      coupon_mode: 'single_use_global',
      created_by: input.createdBy || null,
      created_at: nowIso(),
      updated_at: nowIso(),
      policy: {
        bonusCt: tokenAmountCt
      }
    })
    .select('*')
    .single();

  if (error || !data || !isRecord(data)) {
    throw new Error(error?.message || 'Failed to create coupon.');
  }

  return mapDefinition(data);
};

export const assignCouponDefinition = async (_input: {
  couponDefinitionId: string;
  userId?: string;
  email?: string;
  startsAt: string;
  endsAt: string;
  createdBy?: string;
}) => {
  throw createDeprecatedCouponOperationError();
};

export const revokeCouponAssignment = async (_input: {
  assignmentId: string;
  revokedBy?: string;
  reason?: string;
}) => {
  throw createDeprecatedCouponOperationError();
};

export const listCouponAdminState = async (input?: { limit?: number; cursor?: string }) => {
  const safeLimit = Math.max(10, Math.min(500, Math.floor(Number(input?.limit || 100))));
  const cursor = typeof input?.cursor === 'string' && input.cursor.trim() ? input.cursor.trim() : undefined;
  const admin = getSupabaseAdmin();

  let definitionsQuery = admin
    .from('coupon_definitions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (cursor) {
    definitionsQuery = definitionsQuery.lt('created_at', cursor);
  }

  const [definitionsResult, eventsResult, assignmentsResult] = await Promise.all([
    definitionsQuery,
    admin
      .from('coupon_redemption_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit * 5),
    admin
      .from('coupon_assignments')
      .select('*, coupon_definitions(code)')
      .order('created_at', { ascending: false })
      .limit(safeLimit)
  ]);

  const definitionsRows = Array.isArray(definitionsResult.data)
    ? definitionsResult.data.filter((row) => isRecord(row)) as Record<string, unknown>[]
    : [];

  const eventsRows = Array.isArray(eventsResult.data)
    ? eventsResult.data.filter((row) => isRecord(row)) as Record<string, unknown>[]
    : [];

  const legacyAssignments = assignmentsResult.error && isMissingTableError(assignmentsResult.error)
    ? []
    : Array.isArray(assignmentsResult.data)
      ? assignmentsResult.data.filter((row) => isRecord(row)).map((row) => mapAssignment(row as Record<string, unknown>))
      : [];

  const nextCursor = definitionsRows.length === safeLimit
    ? String((definitionsRows[definitionsRows.length - 1] as Record<string, unknown>).created_at || '') || undefined
    : undefined;

  return {
    definitions: definitionsRows.map((row) => mapDefinition(row)),
    assignments: legacyAssignments,
    events: eventsRows.map((row) => mapEvent(row)),
    nextCursor
  };
};
