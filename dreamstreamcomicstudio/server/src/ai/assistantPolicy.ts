import type {
  AssistantMessage,
  AssistantMap,
  AssistantProjectSummary,
  UniversalAssistantContext
} from '../../../apiTypes.js';
import { OFF_TOPIC_REDIRECT_TIPS } from './assistantKnowledge.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_TEXT_VALUE = 800;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 48;
const MAX_DEPTH = 3;

const PLATFORM_SCOPE = 'platform_only' as const;

const PLATFORM_KEYWORDS = [
  'dreamstream',
  'comic studio',
  'assistant',
  'ai assistant',
  'universal assistant',
  'studio',
  'comic',
  'script',
  'scene',
  'panel',
  'layout',
  'style',
  'world builder',
  'cover',
  'generation',
  'regenerate',
  'dashboard',
  'editor',
  'reader',
  'gallery',
  'project',
  'artifact',
  'export',
  'account',
  'settings',
  'profile',
  'billing',
  'plan',
  'coupon',
  'credit',
  'sign in',
  'login',
  'test lab',
  'privacy',
  'terms',
  'faq',
  'support',
  'gemini',
  'flux',
  'pixazo'
];

const PLATFORM_HELP_PATTERNS = [
  /^(hi|hello|hey)\b/i,
  /^(help|assist)\b/i,
  /\bwho are you\b/i,
  /\bwhat (?:can|do) you do\b/i,
  /\bwhat are your (?:limits|capabilities)\b/i,
  /\bwhat can i ask\b/i,
  /\bwhat is this (?:assistant|ai)\b/i,
  /\bhow can you help\b/i,
  /\bhow do i\b/i,
  /\bwhat is wrong\b/i,
  /\bwhy (?:isn'?t|is not|didn'?t|did not)\b/i,
  /\bi need help\b/i,
  /\bcan you help\b/i,
  /\bwhere (?:is|do)\b/i
];

const LIKELY_OFF_TOPIC_PATTERNS = [
  /\bwho is the richest\b/i,
  /\bweather\b/i,
  /\bstock(?: market)?\b/i,
  /\bcrypto\b/i,
  /\bbtc|bitcoin\b/i,
  /\bpresident\b/i,
  /\bprime minister\b/i,
  /\bsports\b/i,
  /\bmovie review\b/i
];

const SENSITIVE_KEY_PATTERN = /(token|secret|password|passcode|authorization|cookie|api[_-]?key|refresh[_-]?token|access[_-]?token|session[_-]?token|encrypted|private_profile|dob|phone|contact_message|billing|payment|card|credit|ssn|pixazo[_-]?key|gemini[_-]?key|flux[_-]?key|email_pref)/i;

const sanitizeText = (value: unknown, maxLength = MAX_TEXT_VALUE): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\u0000/g, '').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
};

const sanitizeNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
};

const sanitizeBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeStringRecord = (value: unknown): Record<string, number> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .slice(0, MAX_OBJECT_KEYS)
    .filter(([key, val]) => !SENSITIVE_KEY_PATTERN.test(key) && typeof val === 'number' && Number.isFinite(val));
  if (!entries.length) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
};

const sanitizeProjectSummary = (value: unknown): AssistantProjectSummary | undefined => {
  if (!isRecord(value)) return undefined;
  const summary: AssistantProjectSummary = {};
  const id = sanitizeText(value.id, 120);
  const name = sanitizeText(value.name, 120);
  const updatedAt = sanitizeNumber(value.updatedAt);
  const step = sanitizeNumber(value.step);
  const panelCount = sanitizeNumber(value.panelCount);
  const generatedPanels = sanitizeNumber(value.generatedPanels);
  const hasCover = sanitizeBoolean(value.hasCover);
  if (id) summary.id = id;
  if (name) summary.name = name;
  if (updatedAt !== undefined) summary.updatedAt = updatedAt;
  if (step !== undefined) summary.step = step;
  if (panelCount !== undefined) summary.panelCount = panelCount;
  if (generatedPanels !== undefined) summary.generatedPanels = generatedPanels;
  if (hasCover !== undefined) summary.hasCover = hasCover;
  return Object.keys(summary).length ? summary : undefined;
};

const sanitizeLooseValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === 'string') return sanitizeText(value, MAX_TEXT_VALUE);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLooseValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return sanitized.length ? sanitized : undefined;
  }
  if (!isRecord(value)) return undefined;

  const next: AssistantMap = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  for (const [key, nested] of entries) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const cleaned = sanitizeLooseValue(nested, depth + 1);
    if (cleaned !== undefined) {
      next[key] = cleaned;
    }
  }
  return Object.keys(next).length ? next : undefined;
};

export const sanitizeAssistantHistory = (history: unknown): AssistantMessage[] => {
  if (!Array.isArray(history)) return [];
  const sanitized: AssistantMessage[] = [];
  for (const item of history.slice(-MAX_HISTORY_MESSAGES)) {
    if (!isRecord(item)) continue;
    const role = item.role === 'user' || item.role === 'model' ? item.role : undefined;
    const text = sanitizeText(item.text, MAX_MESSAGE_LENGTH);
    if (!role || !text) continue;
    sanitized.push({ role, text });
  }
  return sanitized;
};

const sanitizePublicHints = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const hints = value
    .map((item) => sanitizeText(item, 180))
    .filter((item): item is string => !!item)
    .slice(0, 8);
  return hints.length ? hints : undefined;
};

export const sanitizeAssistantContext = (
  rawContext: unknown,
  options: { isAuthenticated: boolean }
): UniversalAssistantContext => {
  const source = isRecord(rawContext) ? rawContext : {};
  const view = sanitizeText(source.view, 48) || 'unknown';
  const publicHints = sanitizePublicHints(source.publicHints);

  if (!options.isAuthenticated) {
    return {
      view,
      ...(publicHints ? { publicHints } : {})
    };
  }

  const next: UniversalAssistantContext = { view };

  if (publicHints) next.publicHints = publicHints;

  if (isRecord(source.account)) {
    const account: UniversalAssistantContext['account'] = {
      isAuthenticated: true
    };
    const username = sanitizeText(source.account.username, 120);
    const maskedEmail = sanitizeText(source.account.maskedEmail, 160);
    const isAdmin = sanitizeBoolean(source.account.isAdmin);
    const planTier = source.account.planTier === 'free' || source.account.planTier === 'pro' || source.account.planTier === 'admin'
      ? source.account.planTier
      : undefined;
    if (username) account.username = username;
    if (maskedEmail) account.maskedEmail = maskedEmail;
    if (isAdmin !== undefined) account.isAdmin = isAdmin;
    if (planTier) account.planTier = planTier;
    if (isRecord(source.account.usage)) {
      const usage: NonNullable<typeof account.usage> = {};
      const imagesGenerated = sanitizeNumber(source.account.usage.imagesGenerated);
      const maxImagesAllowed = sanitizeNumber(source.account.usage.maxImagesAllowed);
      const hasByok = sanitizeBoolean(source.account.usage.hasByok);
      const isPremium = sanitizeBoolean(source.account.usage.isPremium);
      if (imagesGenerated !== undefined) usage.imagesGenerated = imagesGenerated;
      if (maxImagesAllowed !== undefined) usage.maxImagesAllowed = maxImagesAllowed;
      if (hasByok !== undefined) usage.hasByok = hasByok;
      if (isPremium !== undefined) usage.isPremium = isPremium;
      if (Object.keys(usage).length) account.usage = usage;
    }
    next.account = account;
  }

  if (isRecord(source.systemStatus)) {
    next.systemStatus = {
      status: sanitizeText(source.systemStatus.status, 32),
      geminiKeyPresent: sanitizeBoolean(source.systemStatus.geminiKeyPresent),
      pixazoKeyPresent: sanitizeBoolean(source.systemStatus.pixazoKeyPresent),
      message: sanitizeText(source.systemStatus.message, 220)
    };
  }

  if (isRecord(source.reportSummary)) {
    const report: UniversalAssistantContext['reportSummary'] = {};
    if (isRecord(source.reportSummary.cost)) {
      report.cost = {
        currency: sanitizeText(source.reportSummary.cost.currency, 12),
        totalCost: sanitizeNumber(source.reportSummary.cost.totalCost),
        estimatedArtifacts: sanitizeNumber(source.reportSummary.cost.estimatedArtifacts)
      };
    }
    if (isRecord(source.reportSummary.storage)) {
      report.storage = {
        imageCount: sanitizeNumber(source.reportSummary.storage.imageCount),
        imageBytes: sanitizeNumber(source.reportSummary.storage.imageBytes),
        panelsCount: sanitizeNumber(source.reportSummary.storage.panelsCount),
        artifactsCount: sanitizeNumber(source.reportSummary.storage.artifactsCount),
        indexedDb: sanitizeLooseValue(source.reportSummary.storage.indexedDb) as AssistantMap | undefined
      };
    }
    if (isRecord(source.reportSummary.aiUsage)) {
      report.aiUsage = {
        totalTokens: sanitizeNumber(source.reportSummary.aiUsage.totalTokens),
        totalArtifacts: sanitizeNumber(source.reportSummary.aiUsage.totalArtifacts)
      };
    }
    if (Object.keys(report).length) next.reportSummary = report;
  }

  if (isRecord(source.artifactSummary)) {
    next.artifactSummary = {
      total: sanitizeNumber(source.artifactSummary.total),
      byStage: sanitizeStringRecord(source.artifactSummary.byStage),
      byType: sanitizeStringRecord(source.artifactSummary.byType),
      lastPrompts: Array.isArray(source.artifactSummary.lastPrompts)
        ? source.artifactSummary.lastPrompts
          .slice(0, 8)
          .filter(isRecord)
          .map((item) => ({
            stage: sanitizeText(item.stage, 64),
            model: sanitizeText(item.model, 64)
          }))
        : undefined
    };
  }

  if (isRecord(source.panelPlanSummary)) {
    next.panelPlanSummary = {
      plannedPanels: sanitizeNumber(source.panelPlanSummary.plannedPanels),
      generatedPanels: sanitizeNumber(source.panelPlanSummary.generatedPanels),
      textLayout: sanitizeText(source.panelPlanSummary.textLayout, 64)
    };
  }

  if (Array.isArray(source.allProjectsSummary)) {
    const projects = source.allProjectsSummary
      .map((item) => sanitizeProjectSummary(item))
      .filter((item): item is AssistantProjectSummary => !!item)
      .slice(0, 30);
    if (projects.length) next.allProjectsSummary = projects;
  }

  const projectSnapshot = sanitizeLooseValue(source.projectSnapshot) as AssistantMap | undefined;
  if (projectSnapshot) next.projectSnapshot = projectSnapshot;

  const appSnapshot = sanitizeLooseValue(source.appSnapshot) as AssistantMap | undefined;
  if (appSnapshot) next.appSnapshot = appSnapshot;

  const testLabSummary = sanitizeLooseValue(source.testLabSummary) as AssistantMap | undefined;
  if (testLabSummary) next.testLabSummary = testLabSummary;

  if (Array.isArray(source.testLabRecentRuns)) {
    const runs = source.testLabRecentRuns
      .map((item) => sanitizeLooseValue(item) as AssistantMap | undefined)
      .filter((item): item is AssistantMap => !!item)
      .slice(0, 10);
    if (runs.length) next.testLabRecentRuns = runs;
  }

  return next;
};

export const isPlatformScopedMessage = (input: string): boolean => {
  const message = input.trim().toLowerCase();
  if (!message) return false;

  const hasPlatformSignal =
    PLATFORM_KEYWORDS.some((keyword) => message.includes(keyword)) ||
    PLATFORM_HELP_PATTERNS.some((pattern) => pattern.test(message));
  const isClearlyOffTopic = LIKELY_OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(message));

  if (isClearlyOffTopic && !hasPlatformSignal) return false;
  // Allow broader phrasing by default, while still blocking explicit off-topic patterns above.
  return true;
};

export const buildOffTopicResponse = (): string => {
  const tips = OFF_TOPIC_REDIRECT_TIPS.map((tip, index) => `${index + 1}. ${tip}`).join('\n');
  return [
    '**Summary:** I can only help with DreamStream Comic Studio features, projects, account, and workflow questions.',
    '**Warnings:** I cannot answer unrelated general-knowledge questions.',
    '**Next:**',
    tips
  ].join('\n');
};

export const ASSISTANT_POLICY_SCOPE = PLATFORM_SCOPE;
