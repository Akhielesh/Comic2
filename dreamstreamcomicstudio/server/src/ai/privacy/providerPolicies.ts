// Which text providers keep connected-account content out of logging / training, and how.
// Documentation for the owner and reviewers: this table changes NO routing. Only OpenRouter gets a
// per-request control (openrouterPolicy.ts); the direct providers are covered (or not) by the
// terms of the account whose API key the request uses. Quotes were read on 2026-11-04; re-check
// them when a provider's terms change. Keep in sync with docs/DATA_CONNECTORS.md.

import type { ProviderId } from '../../../../shared/providers.js';

export type ProviderPrivacyCoverage =
  /** We set a per-request control on every connector call. */
  | 'per_request_control'
  /** The provider's published API terms say API data is not used for training by default. */
  | 'api_terms_no_training'
  /** Depends on the account / tier behind the key: the owner must confirm a paid, no-training tier. */
  | 'owner_must_confirm';

export interface ProviderPrivacyPolicy {
  coverage: ProviderPrivacyCoverage;
  /** What covers it, or what the owner has to confirm. */
  note: string;
  /** Where the statement comes from ('' when nothing was verified). */
  source: string;
}

export const PROVIDER_PRIVACY_POLICIES: Record<ProviderId, ProviderPrivacyPolicy> = {
  openrouter: {
    coverage: 'per_request_control',
    note:
      "Connector turns send provider.data_collection 'deny' (\"use only providers which do not collect user data\") and never use a :free model. The OpenRouter account's own privacy settings (a training opt-out, separate for paid and free models) are an optional second layer the owner sets.",
    source: 'https://openrouter.ai/docs/features/provider-routing ; https://openrouter.ai/docs/features/privacy-and-logging'
  },
  openai: {
    coverage: 'api_terms_no_training',
    note: '"data sent to the OpenAI API is not used to train or improve OpenAI models"; abuse-monitoring logs are kept "for up to 30 days" by default.',
    source: 'https://developers.openai.com/api/docs/guides/your-data'
  },
  anthropic: {
    coverage: 'api_terms_no_training',
    note: '"By default, we will not use your inputs or outputs from our commercial products" to train models (the API is a commercial product).',
    source: 'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training'
  },
  gemini: {
    coverage: 'owner_must_confirm',
    note:
      'Unpaid Services (free quota, AI Studio keys without billing): Google "uses the content you submit … to provide, improve, and develop" and "human reviewers may read" it. Paid Services: "Google doesn\'t use your prompts … or responses to improve our products". The owner must confirm the platform Gemini key is on a paid (billing-enabled) project; a BYOK key is the user\'s own account.',
    source: 'https://aistudio.google.com/docs/terms'
  },
  nvidia: {
    coverage: 'owner_must_confirm',
    note: 'NVIDIA API catalog (build.nvidia.com) trial/free credits: data-use terms NOT verified here. Owner to confirm before connector content is used with an NVIDIA key.',
    source: ''
  },
  deepseek: {
    coverage: 'owner_must_confirm',
    note: 'DeepSeek platform API data-use terms NOT verified here. Owner to confirm.',
    source: ''
  },
  zai: {
    coverage: 'owner_must_confirm',
    note: 'Z.ai (GLM) API data-use terms NOT verified here. Owner to confirm.',
    source: ''
  },
  minimax: {
    coverage: 'owner_must_confirm',
    note: 'MiniMax API data-use terms NOT verified here. Owner to confirm.',
    source: ''
  },
  tencent: {
    coverage: 'owner_must_confirm',
    note: 'Tencent (Hunyuan) API data-use terms NOT verified here. Owner to confirm.',
    source: ''
  },
  xai: {
    coverage: 'owner_must_confirm',
    note: 'xAI API data-use terms NOT verified here. Owner to confirm.',
    source: ''
  }
};
