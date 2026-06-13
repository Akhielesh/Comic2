import type { AgentConfirmPolicy, AgentOutputTarget, ComicAgentSettings } from '../types';

const VALID_CONFIRM_POLICIES = new Set<AgentConfirmPolicy>(['always', 'big_spends', 'never']);
const VALID_OUTPUT_TARGETS = new Set<AgentOutputTarget>(['comic', 'book', 'html']);

export const DEFAULT_AGENT_OUTPUT_TARGETS: AgentOutputTarget[] = ['comic', 'book', 'html'];

export const makeDefaultComicAgentSettings = (): ComicAgentSettings => ({
  confirmPolicy: 'big_spends',
  outputTargets: [...DEFAULT_AGENT_OUTPUT_TARGETS],
  autoPageCount: true,
  updatedAt: Date.now()
});

export const normalizeComicAgentSettings = (settings?: Partial<ComicAgentSettings> | null): ComicAgentSettings => {
  const outputTargets = Array.isArray(settings?.outputTargets)
    ? settings.outputTargets.filter((target): target is AgentOutputTarget => VALID_OUTPUT_TARGETS.has(target as AgentOutputTarget))
    : [];

  const confirmPolicy = VALID_CONFIRM_POLICIES.has(settings?.confirmPolicy as AgentConfirmPolicy)
    ? settings!.confirmPolicy as AgentConfirmPolicy
    : 'big_spends';

  return {
    confirmPolicy,
    outputTargets: outputTargets.length > 0 ? Array.from(new Set(outputTargets)) : [...DEFAULT_AGENT_OUTPUT_TARGETS],
    autoPageCount: settings?.autoPageCount !== false,
    budgetCapUsd: typeof settings?.budgetCapUsd === 'number' && Number.isFinite(settings.budgetCapUsd) && settings.budgetCapUsd > 0
      ? Math.round(settings.budgetCapUsd * 100) / 100
      : undefined,
    updatedAt: typeof settings?.updatedAt === 'number' ? settings.updatedAt : Date.now()
  };
};

export const agentConfirmLabel = (policy: AgentConfirmPolicy) => {
  switch (policy) {
    case 'always':
      return 'Always confirm';
    case 'never':
      return 'Auto spend';
    case 'big_spends':
    default:
      return 'Big spends confirm';
  }
};

export const shouldAutoRunComicAgent = (settings?: Partial<ComicAgentSettings> | null): boolean =>
  normalizeComicAgentSettings(settings).confirmPolicy === 'never';

export const outputTargetLabel = (target: AgentOutputTarget) => {
  switch (target) {
    case 'book':
      return 'Book/PDF';
    case 'html':
      return 'HTML';
    case 'comic':
    default:
      return 'Comic';
  }
};
