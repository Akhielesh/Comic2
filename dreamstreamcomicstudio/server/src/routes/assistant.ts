import { Router } from 'express';
import type { AssistantAccountSummary, UniversalAssistantResponse } from '../../../apiTypes.js';
import { queryUniversalAssistant } from '../ai/assistant.js';
import { ASSISTANT_GEMINI_API_KEY, TEXT_MODEL } from '../config.js';
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
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';

export const assistantRouter = Router();

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
    const apiKey = ASSISTANT_GEMINI_API_KEY.trim();
    if (!apiKey) {
      return res.status(503).json({
        error: {
          message: 'Assistant provider key missing. Set ASSISTANT_GEMINI_API_KEY (or GEMINI_API_KEY).',
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

    const requestedModel = req.header('X-Gemini-Model')?.trim() || TEXT_MODEL;
    const reserve = req.user?.id
      ? await reserveForOperation({
          req,
          operation: 'assistant.chat',
          fallbackModel: requestedModel,
          provider: 'gemini',
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
      const result = await queryUniversalAssistant(apiKey, message, history, context, requestedModel);
      const settled = reserve && reserve.allowed
        ? await settleReservedOperation({
            req,
            operation: 'assistant.chat',
            provider: 'gemini',
            model: requestedModel,
            seed: {
              provider: 'gemini',
              model: requestedModel,
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
          provider: 'gemini',
          model: requestedModel,
          reason: (error as Error)?.message || 'assistant_request_failed',
          metadata: {
            route: req.path,
            historyLength: history.length
          }
        });
      }
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
