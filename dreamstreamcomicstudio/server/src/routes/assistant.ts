import { Router } from 'express';
import type { AssistantAccountSummary, UniversalAssistantResponse } from '../../../apiTypes.js';
import { queryUniversalAssistant } from '../ai/assistant.js';
import {
  ASSISTANT_POLICY_SCOPE,
  buildOffTopicResponse,
  isPlatformScopedMessage,
  sanitizeAssistantContext,
  sanitizeAssistantHistory
} from '../ai/assistantPolicy.js';
import { requireGeminiKey } from '../middleware/keys.js';
import { supabase } from '../services/supabase.js';

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
      supabase
        .from('usage_limits')
        .select('images_generated_count, max_images_allowed, has_byok, is_premium, plan_tier')
        .eq('user_id', user.id)
        .maybeSingle()
    ]);

    const username = profileResult.data?.username;
    if (typeof username === 'string' && username.trim()) {
      account.username = username.trim();
    }

    const usage = usageResult.data;
    if (usage) {
      const rawTier = typeof usage.plan_tier === 'string' ? usage.plan_tier.toLowerCase() : 'free';
      const tier = rawTier === 'pro' || rawTier === 'admin'
        ? rawTier
        : (usage.is_premium ? 'pro' : 'free');
      account.planTier = tier;
      account.isAdmin = tier === 'admin' || user.email === 'admin@test.com';
      account.usage = {
        imagesGenerated: typeof usage.images_generated_count === 'number' ? usage.images_generated_count : undefined,
        maxImagesAllowed: typeof usage.max_images_allowed === 'number' ? usage.max_images_allowed : undefined,
        hasByok: typeof usage.has_byok === 'boolean' ? usage.has_byok : undefined,
        isPremium: usage.is_premium === true
      };
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
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;

    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
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

    const result = await queryUniversalAssistant(apiKey, message, history, context, requestedModel);
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
    res.json(payload);
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
