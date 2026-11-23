import type {
  AssistantMessage,
  AssistantMap,
  AssistantProjectSummary,
  UniversalAssistantContext
} from '../../../apiTypes.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_TEXT_VALUE = 800;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 48;
const MAX_DEPTH = 3;

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

  const next: AssistantMap = Object.create(null);
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

  // Identity, grants, billing and roles are never accepted from browser context.
  // The assistant route supplies the account summary from its authenticated request.

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

  return next;
};

export const ASSISTANT_POLICY_SCOPE = 'conversation' as const;
