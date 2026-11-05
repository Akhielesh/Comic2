import { Router } from 'express';
import type { AssistantAccountSummary, UniversalAssistantResponse } from '../../../apiTypes.js';
import { queryUniversalAssistant } from '../ai/assistant.js';
import { NoFreeModelAvailableError, pickTextModel } from '../ai/autoRouter.js';
import {
  ASSISTANT_POLICY_SCOPE,
  buildOffTopicResponse,
  isPlatformScopedMessage,
  sanitizeAssistantContext,
  sanitizeAssistantHistory
} from '../ai/assistantPolicy.js';
import { supabase } from '../services/supabase.js';
import { getBillingSummary } from '../services/billingLedger.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  hasByokForProvider,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';
import { assertModelAllowedForTier } from '../services/modelAccessPolicy.js';

export const assistantRouter = Router();

/** The calm answer when no free model can take the call right now (nothing was spent). */
const ASSISTANT_BUSY_BODY = {
  error: {
    code: 'ASSISTANT_BUSY',
    message: "The assistant's free model is busy right now. Nothing was spent — try again in a minute."
  }
};

/** A free model that couldn't take the call: none free in the catalog, retired (404), rate-limited (429). */
const isFreeModelMiss = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string; code?: string } | null | undefined;
  if (err instanceof NoFreeModelAvailableError || e?.code === 'NO_FREE_MODEL_AVAILABLE') return true;
  if (e?.status === 404 || e?.status === 429) return true;
  return /no endpoints|rate.?limit|too many requests|\b404\b|\b429\b/i.test(String(e?.message || ''));
};

const maskEmail = (email?: string) => {
  if (!email || !email.includes('@')) return undefined;
  const [name, domain] = email.split('@');
  if (!name || !domain) return undefined;
  const visible = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${visible}***@${domain}`;
};

const resolveSafeAccountSummary = async (
  user: { id: string; email?: string }
): Promise<AssistantAccountSummary> => {
  const account: AssistantAccountSummary = {
    isAuthenticated: true,
    maskedEmail: maskEmail(user.email)
  };

  try {
    const [profileResult, usageResult] = await Promise.all([
      supabase
        .from('profiles')
        .select('username')
        .eq('id', user.id)
        .maybeSingle(),
      getBillingSummary(user.id)
    ]);

    const username = profileResult.data?.username;
    if (typeof username === 'string' && username.trim()) {
      account.username = username.trim();
    }

    if (usageResult) {
      const tier = usageResult.plan.id;
      account.planTier = tier;
      account.isAdmin = tier === 'admin' || user.email === 'admin@test.com';
      account.usage = {
        dailyRemainingCt: usageResult.usage.dailyRemainingCt,
        availableCt: usageResult.wallet.availableCt,
        isPremium: tier === 'pro' || tier === 'studio' || tier === 'admin'
      };
      account.billing = usageResult;
    } else {
      account.planTier = user.email === 'admin@test.com' ? 'admin' : 'free';
      account.isAdmin = user.email === 'admin@test.com';
    }
  } catch {
    account.planTier = user.email === 'admin@test.com' ? 'admin' : 'free';
    account.isAdmin = user.email === 'admin@test.com';
  }

  return account;
};

assistantRouter.post('/chat', async (req, res, next) => {
  try {
    // The assistant runs on a free OpenRouter model. Use the user's BYOK key or the
    // platform OPENROUTER_API_KEY (both are free against a :free model).
    const apiKey = (req.apiKeys?.openRouterKey || '').trim();
    if (!apiKey) {
      return res.status(503).json({
        error: {
          message: 'Assistant needs an OpenRouter key. Add one in Settings → API Configuration, or set OPENROUTER_API_KEY on the server.',
          code: 'MISSING_ASSISTANT_API_KEY'
        }
      });
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 2000) : '';
    if (!message) {
      return res.status(400).json({ error: { message: 'message is required' } });
    }

    const isAuthenticated = !!req.user;
    const history = sanitizeAssistantHistory(req.body?.history);
    const context = sanitizeAssistantContext(req.body?.context, { isAuthenticated });
    context.account = isAuthenticated
      ? await resolveSafeAccountSummary({ id: req.user!.id, email: req.user!.email })
      : { isAuthenticated: false };

    if (!isPlatformScopedMessage(message)) {
      const blocked: UniversalAssistantResponse = {
        text: buildOffTopicResponse(),
        model: 'policy/platform-only',
        limitInfo: req.assistantLimitInfo,
        policy: {
          scope: ASSISTANT_POLICY_SCOPE,
          offTopicBlocked: true,
          reason: 'NON_PLATFORM'
        }
      };
      return res.json(blocked);
    }

    // S10: on the PLATFORM key the assistant only ever runs free models — a free-only pick (never
    // the cheapest paid model or the catalog-down TEXT_FALLBACK) and no paid retry — so the
    // platform never pays for it and its $0 hold and $0 settle are true for guests, governed users
    // and admins alike. The user's own key (BYOK) keeps the paid safety net, unless they turned
    // Free-only on.
    const freeOnly = !hasByokForProvider(req, 'openrouter') || req.freeOnly === true;
    let effectiveModel: string;
    try {
      // Auto-routed free model from the live catalog (no hardcoded/retired model id).
      effectiveModel = await pickTextModel(freeOnly ? { costPref: 'free-only', stageHint: 'assistant' } : { preferFree: true });
    } catch (err) {
      if (freeOnly && isFreeModelMiss(err)) return res.status(503).json(ASSISTANT_BUSY_BODY);
      throw err;
    }
    const reserve = req.user?.id
      ? await reserveForOperation({
          req,
          operation: 'assistant.chat',
          fallbackModel: effectiveModel,
          provider: 'openrouter',
          stage: 'assistant',
          metadata: {
            route: req.path,
            historyLength: history.length
          }
        })
      : null;

    if (reserve && 'details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const result = await queryUniversalAssistant(apiKey, message, history, context, effectiveModel, { freeOnly });
      const settled = reserve && reserve.allowed
        ? await settleReservedOperation({
            req,
            operation: 'assistant.chat',
            provider: 'openrouter',
            model: effectiveModel,
            seed: {
              provider: 'openrouter',
              model: effectiveModel,
              operation: 'assistant.chat',
              stage: 'assistant',
              byok: reserve.reservation.byokBypass
            },
            usage: result.usage,
            metadata: {
              route: req.path,
              historyLength: history.length
            }
          })
        : null;

      const payload: UniversalAssistantResponse = {
        text: result.text,
        usage: result.usage,
        model: result.model,
        limitInfo: req.assistantLimitInfo,
        policy: {
          scope: ASSISTANT_POLICY_SCOPE,
          offTopicBlocked: false
        }
      };

      res.json(reserve && reserve.allowed ? attachBillingToPayload(payload as unknown as Record<string, unknown>, reserve.reservation, settled) : payload);
    } catch (error) {
      if (reserve && reserve.allowed) {
        await releaseReservedOperation({
          req,
          operation: 'assistant.chat',
          provider: 'openrouter',
          model: effectiveModel,
          reason: (error as Error)?.message || 'assistant_request_failed',
          metadata: {
            route: req.path,
            historyLength: history.length
          }
        });
      }
      // A busy/retired free model: a calm answer (never the raw provider error), nothing spent.
      if (freeOnly && isFreeModelMiss(error)) return res.status(503).json(ASSISTANT_BUSY_BODY);
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

assistantRouter.all('/story*', (_req, res) => {
  res.status(410).json({ error: { message: 'Story Assistant has been removed.' } });
});

assistantRouter.all('*', (_req, res) => {
  res.status(410).json({ error: { message: 'Story Assistant has been removed. Use /api/assistant/chat for Universal Assistant.' } });
});
