// Nango — 800+ API connectors as agent tools.
//
// Three deliberately SMALL meta-tools (not 800 raw tools, which would blow the model's tool
// budget and wreck selection): discover integrations, start a per-user OAuth connect flow, and
// proxy an authenticated request to any connected provider. They talk to a *self-hosted* Nango
// over its REST API with the operator's secret key — see docs/studio/INTEGRATIONS-NANGO.md.
//
// Nango is Elastic License v2: self-hosting it to power our product is fine; reselling Nango as a
// service is not. Endpoints/headers verified against nango.dev/docs (proxy uses Connection-Id +
// Provider-Config-Key; connect uses POST /connect/sessions; integrations via GET /integrations).

import type { ChatTool, ToolExecResult } from './types.js';

const NANGO_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 8_000; // cap proxied responses fed back to the model

/** Self-hosted Nango base URL (default the documented self-host port) + server secret key. */
const nangoHost = (): string => (process.env.NANGO_HOST || 'http://localhost:3003').replace(/\/+$/, '');
const nangoSecret = (): string => process.env.NANGO_SECRET_KEY || '';
const defaultConnectionId = (): string => process.env.NANGO_DEFAULT_CONNECTION_ID || '';

export const nangoEnabled = (): boolean => Boolean(nangoSecret());

const notConfigured = (): ToolExecResult => ({
  content:
    'Nango is not configured on this server, so external API connectors are unavailable. Set NANGO_SECRET_KEY (and NANGO_HOST) to enable OAuth + proxy for 800+ APIs.',
  notice: { level: 'warn', message: 'Nango not configured', fix: 'Set NANGO_SECRET_KEY / NANGO_HOST on the server.' },
});

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${nangoSecret()}`,
  'Content-Type': 'application/json',
  ...extra,
});

const withTimeout = async (
  fn: (signal: AbortSignal) => Promise<Response>,
  outer?: AbortSignal
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NANGO_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
};

const summarizeError = async (res: Response): Promise<string> => {
  const text = await res.text().catch(() => '');
  return `Nango returned ${res.status}. ${text.slice(0, 300)}`.trim();
};

const searchIntegrations: ChatTool = {
  name: 'nango_search_integrations',
  description:
    'List the third-party API integrations available to connect through Nango (Slack, Google, Notion, Stripe, GitHub, …, 800+ providers). Optionally filter by a query. Use this to discover which provider to connect before calling its API.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Optional filter, matched against provider/name/id (e.g. "google", "crm").' } },
  },
  execute: async (args, signal): Promise<ToolExecResult> => {
    if (!nangoEnabled()) return notConfigured();
    const query = String(args?.query || '').trim().toLowerCase();
    try {
      const res = await withTimeout(
        (s) => fetch(`${nangoHost()}/integrations`, { headers: authHeaders(), signal: s }),
        signal
      );
      if (!res.ok) return { content: await summarizeError(res) };
      const json = (await res.json()) as { data?: { unique_key?: string; display_name?: string; provider?: string }[] };
      let list = Array.isArray(json?.data) ? json.data : [];
      if (query) {
        list = list.filter((i) =>
          [i.unique_key, i.display_name, i.provider].filter(Boolean).some((v) => String(v).toLowerCase().includes(query))
        );
      }
      if (!list.length) {
        return { content: query ? `No Nango integrations match "${query}". Configure it in the Nango dashboard first, or try another query.` : 'No integrations are configured in this Nango instance yet.' };
      }
      const rows = list
        .slice(0, 50)
        .map((i) => `- ${i.display_name || i.provider} — id (provider_config_key): \`${i.unique_key}\``)
        .join('\n');
      return { content: `Available Nango integrations (${list.length}):\n${rows}\n\nUse the id as provider_config_key with nango_connect_integration / nango_call_api.` };
    } catch (err) {
      return { content: `Could not reach Nango: ${(err as Error)?.message || 'unknown error'}` };
    }
  },
};

const connectIntegration: ChatTool = {
  name: 'nango_connect_integration',
  description:
    'Start an OAuth/connect flow for a Nango integration so an end user can authorize access. Returns a short-lived connect session token + link the app hands to the user. Each user authorizes their own account; Nango stores and refreshes the tokens.',
  parameters: {
    type: 'object',
    properties: {
      integration: { type: 'string', description: 'The integration id (provider_config_key) from nango_search_integrations.' },
      endUserId: { type: 'string', description: 'A stable id for the end user authorizing (e.g. your app user id).' },
      endUserEmail: { type: 'string', description: 'Optional end-user email.' },
    },
    required: ['integration', 'endUserId'],
  },
  execute: async (args, signal): Promise<ToolExecResult> => {
    if (!nangoEnabled()) return notConfigured();
    const integration = String(args?.integration || '').trim();
    const endUserId = String(args?.endUserId || '').trim();
    if (!integration || !endUserId) return { content: 'Provide both an integration id and an endUserId.' };
    const endUserEmail = String(args?.endUserEmail || '').trim() || undefined;
    try {
      const res = await withTimeout(
        (s) =>
          fetch(`${nangoHost()}/connect/sessions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
              end_user: { id: endUserId, ...(endUserEmail ? { email: endUserEmail } : {}) },
              allowed_integrations: [integration],
            }),
            signal: s,
          }),
        signal
      );
      if (!res.ok) return { content: await summarizeError(res) };
      const json = (await res.json()) as { data?: { token?: string; expires_at?: string; connect_link?: string } };
      const d = json?.data || {};
      if (!d.token) return { content: 'Nango did not return a session token. Check the integration id and Nango configuration.' };
      return {
        content:
          `Created a Nango connect session for "${integration}" (expires ${d.expires_at || 'soon'}).\n` +
          `Hand this to the frontend Nango Connect UI:\n- session token: ${d.token}\n${d.connect_link ? `- connect link: ${d.connect_link}\n` : ''}` +
          `In generated apps, load @nangohq/frontend and call nango.openConnectUI({ sessionToken }). Tokens are minted server-side with the secret key — never expose the secret in client code.`,
      };
    } catch (err) {
      return { content: `Could not reach Nango: ${(err as Error)?.message || 'unknown error'}` };
    }
  },
};

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const callApi: ChatTool = {
  name: 'nango_call_api',
  description:
    "Make an authenticated request to a connected provider's API through the Nango proxy (Nango injects the user's credentials and handles token refresh). Use this to verify real response shapes at build time, or as the pattern generated apps follow at runtime.",
  parameters: {
    type: 'object',
    properties: {
      integration: { type: 'string', description: 'The integration id (provider_config_key).' },
      connectionId: { type: 'string', description: 'The connection id for the authorized user (defaults to NANGO_DEFAULT_CONNECTION_ID if set).' },
      method: { type: 'string', description: 'HTTP method (GET, POST, PUT, PATCH, DELETE). Default GET.' },
      path: { type: 'string', description: "Provider API path appended to its base URL, e.g. '/users/me' or 'v1/messages'." },
      query: { type: 'object', description: 'Optional query parameters as key/value pairs.' },
      body: { type: 'object', description: 'Optional JSON request body (for POST/PUT/PATCH).' },
      baseUrlOverride: { type: 'string', description: "Optional Base-Url-Override when the provider's base URL isn't preconfigured." },
    },
    required: ['integration', 'path'],
  },
  execute: async (args, signal): Promise<ToolExecResult> => {
    if (!nangoEnabled()) return notConfigured();
    const integration = String(args?.integration || '').trim();
    const connectionId = String(args?.connectionId || '').trim() || defaultConnectionId();
    const method = (String(args?.method || 'GET').trim().toUpperCase() || 'GET');
    const path = String(args?.path || '').trim();
    if (!integration || !path) return { content: 'Provide an integration id and a provider API path.' };
    if (!connectionId) return { content: 'No connectionId given and NANGO_DEFAULT_CONNECTION_ID is unset. Connect a user first with nango_connect_integration, then pass its connectionId.' };
    if (!ALLOWED_METHODS.has(method)) return { content: `Unsupported method "${method}". Use one of GET, POST, PUT, PATCH, DELETE.` };

    const url = new URL(`${nangoHost()}/proxy/${path.replace(/^\/+/, '')}`);
    const query = (args?.query && typeof args.query === 'object') ? (args.query as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const headers = authHeaders({ 'Connection-Id': connectionId, 'Provider-Config-Key': integration });
    const baseUrlOverride = String(args?.baseUrlOverride || '').trim();
    if (baseUrlOverride) headers['Base-Url-Override'] = baseUrlOverride;
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method) && args?.body && typeof args.body === 'object';

    try {
      const res = await withTimeout(
        (s) => fetch(url.toString(), { method, headers, body: hasBody ? JSON.stringify(args.body) : undefined, signal: s }),
        signal
      );
      const text = await res.text();
      const trimmed = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : text;
      if (!res.ok) return { content: `Provider responded ${res.status} via Nango proxy:\n${trimmed}` };
      return { content: `${method} ${path} → ${res.status}\n${trimmed || '(empty body)'}` };
    } catch (err) {
      return { content: `Nango proxy call failed: ${(err as Error)?.message || 'unknown error'}` };
    }
  },
};

/** The Nango connector toolset, registered into the global tool registry. */
export const NANGO_TOOLS: ChatTool[] = [searchIntegrations, connectIntegration, callApi];

export const NANGO_TOOL_NAMES = NANGO_TOOLS.map((t) => t.name);
