// Which text providers keep connected-account content out of logging / training, and how.
// Only OpenRouter gets a per-request control (openrouterPolicy.ts); the direct providers are
// covered (or not) by the terms of the account whose API key the request uses. Quotes were read on
// 2026-11-04; re-check them when a provider's terms change. Keep in sync with docs/DATA_CONNECTORS.md.
//
// The table routes in one way, and fails closed: a direct provider marked `owner_must_confirm`,
// used through the PLATFORM key (not the user's own key), gets no connected-account content until
// the owner lists it in CONNECTOR_PROVIDERS_CONFIRMED (docs/infrastructure/ENV_MATRIX.md). routes/chat.ts treats
// such a turn like a free turn (no connector tools, no connector context, no memory distilled from
// connected content, and a calm refusal when the history already carries connected content), and
// services/userMemory.ts stores memory distilled from connected content without a Gemini embedding
// until 'gemini' is listed. The memory query (the turn's last user message) is gated too: routes/chat.ts
// sets `noQueryEmbedding` for a conversation that may carry connected content until 'gemini' is listed,
// and on every withheld turn of a user with connections, so retrieval falls back to word search.

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
      'Unpaid Services (free quota, AI Studio keys without billing): Google "uses the content you submit … to provide, improve, and develop" and "human reviewers may read" it. Paid Services: "Google doesn\'t use your prompts … or responses to improve our products". The owner must confirm the platform Gemini keys are on a paid (billing-enabled) project: GEMINI_API_KEY (chat) and ASSISTANT_GEMINI_API_KEY (long-term memory embeddings, services/userMemory.ts; it falls back to GEMINI_API_KEY when unset, and may be a different project). A BYOK key is the user\'s own account.',
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

/**
 * Direct providers the owner confirmed for connected-account content through the platform key:
 * the comma-separated CONNECTOR_PROVIDERS_CONFIRMED env var (e.g. `gemini,nvidia`), read per call so
 * a deploy that sets it takes effect without code changes. Unknown names are ignored.
 */
export const confirmedConnectorProviders = (env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> =>
  new Set(
    String(env.CONNECTOR_PROVIDERS_CONFIRMED || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

/**
 * May connected-account content reach this provider through the PLATFORM key? Yes when its terms
 * cover it (a per-request control, or published API terms) or the owner listed it in
 * CONNECTOR_PROVIDERS_CONFIRMED; no for every `owner_must_confirm` provider until then (fail closed).
 * A user's own key (BYOK) is their own account and is not gated here.
 */
export const connectorProviderConfirmed = (provider: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const policy = (PROVIDER_PRIVACY_POLICIES as Record<string, ProviderPrivacyPolicy | undefined>)[provider];
  if (!policy) return false;
  return policy.coverage !== 'owner_must_confirm' || confirmedConnectorProviders(env).has(provider);
};

/**
 * Other places connected content can leave a connector turn, outside the text-provider routing above
 * (documentation, as docs/DATA_CONNECTORS.md "Known gaps"; nothing here routes). On a connector turn the
 * model writes these tools' arguments, so it can quote connected content into them.
 */
export const CONNECTOR_TURN_OTHER_EGRESS: readonly { path: string; reaches: string; coverage: string }[] = Object.freeze([
  {
    path: 'generate_image (ai/tools/imageGen.ts, offered by routes/chat.ts)',
    reaches: 'Gemini, Ideogram, Pixazo (Flux), OpenAI and xAI image APIs, called directly with the user\'s own image keys (or the platform keys where no usage budget applies)',
    coverage: 'Not routed by connected-account privacy. Ideogram and Pixazo data-use terms are NOT verified here; Gemini follows the note above.'
  },
  {
    path: 'Always-on reference MCP servers (Context7, DeepWiki; ai/studio/designSystem.ts ALWAYS_ON_STUDIO_MCP_SERVERS)',
    reaches: 'Third-party MCP endpoints, with the query the model writes',
    coverage: 'Not routed. Off when external MCP is disabled (externalMcpEnabled).'
  },
  {
    path: 'Web search and other keyless tools (web_search, read_url, …)',
    reaches: 'Search and page-fetch endpoints, with the query or URL the model writes',
    coverage: 'Not routed.'
  }
]);
