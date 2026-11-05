// Chat client side of connected-account privacy (docs/DATA_CONNECTORS.md, "Connected-account
// privacy and model routing"). The server decides; this module only helps the client tell it what it
// knows and show its refusals calmly:
//   - the provenance echo: an assistant turn that connected-account content entered is sent back
//     with `connectorData: true` (the server marked the reply, or a connector tool ran on it), so a
//     later free-model turn of that conversation is refused exactly, without a lookup;
//   - the long-term memory flag: memory the server distilled from such a conversation is never
//     composed into a turn that may run on a free model;
//   - the calm notice: the free-model refusal (409) and the usage refusal that cannot fall back to
//     free models (402) become an info card with two ways forward, never an error turn.
//
// Pure: no React, no storage, no network. The code strings and the tool list are server constants
// (server/src/ai/privacy/connectorData.ts, openrouterPolicy.ts) duplicated here because the client
// bundle never imports server code; connectorPrivacy.parity.test.ts reads both and fails on drift.

import { hasFreeSuffix } from '../../shared/pricing';

/** Error code of the free-model refusal (server CONNECTED_DATA_FREE_MODEL_CODE, HTTP 409). */
export const CONNECTED_DATA_FREE_MODEL_CODE = 'CONNECTED_DATA_NEEDS_STANDARD_MODEL';

/**
 * The sentence the server appends to a usage refusal (HTTP 402) when the free re-plan is off because
 * the conversation carries connected-account content (server CONNECTED_DATA_BUDGET_SENTENCE).
 */
export const CONNECTED_DATA_BUDGET_SENTENCE =
  "This chat includes content from your connected accounts, which is never sent to free models, so it can't continue on one. " +
  'Start a new chat without connected content to keep chatting on free models, or add your own API key in Settings → API keys.';

/**
 * The clause both free-model refusals share: the chat routes' 409 (connectedDataFreeModelMessage) and
 * the provider backstop's (connectorFreeModelRefusal). A refusal raised mid-stream reaches the client
 * as a message with no code, so this is how it is recognised there.
 */
export const CONNECTED_DATA_REFUSAL_CLAUSE = 'free models may keep or learn from what they receive';

/** Tools whose output is the user's connected-account content (server CONNECTOR_DATA_TOOL_NAMES). */
export const CONNECTOR_DATA_TOOL_NAMES: readonly string[] = Object.freeze([
  'gmail_search',
  'gmail_inbox',
  'gmail_unread',
  'gmail_compose',
  'drive_search',
  'calendar_agenda',
  'calendar_create_event',
  'calendar_create_events',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_rsvp',
  'sheets_read',
  'maps_lookup',
  'connected_data_search',
  'nango_call_api'
]);

/**
 * Connector tool families: a future tool in one of them counts before the list above is updated, and
 * `mcp_nango_` is the operator's Nango MCP, which proxies the user's own connections.
 */
export const CONNECTOR_TOOL_PREFIXES: readonly string[] = Object.freeze([
  'gmail_',
  'drive_',
  'calendar_',
  'sheets_',
  'connected_data_',
  'mcp_nango_'
]);

const CONNECTOR_TOOL_SET = new Set(CONNECTOR_DATA_TOOL_NAMES);

export const isConnectorToolName = (name: unknown): boolean =>
  typeof name === 'string' && (CONNECTOR_TOOL_SET.has(name) || CONNECTOR_TOOL_PREFIXES.some((p) => name.startsWith(p)));

/** What the client knows about one stored turn's provenance. */
export interface ConnectorProvenance {
  role?: string;
  connectorData?: boolean;
  toolEvents?: readonly { tool?: unknown }[];
}

/**
 * An assistant turn that connected-account content entered: the server said so on its reply
 * (`connectorData: true`), or one of its tool events names a connector tool.
 */
export const turnCarriesConnectorData = (turn: ConnectorProvenance): boolean =>
  turn.role === 'assistant' &&
  (turn.connectorData === true || (turn.toolEvents || []).some((e) => isConnectorToolName(e?.tool)));

/** The provenance marker a request message carries for that turn (nothing for every other turn). */
export const connectorMarkerFor = (turn: ConnectorProvenance): { connectorData?: true } =>
  turnCarriesConnectorData(turn) ? { connectorData: true } : {};

const recordOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A live trace artifact (agent_activity steps, swarm_trace agents' tool events) names a connector tool. */
const traceNamesConnectorTool = (artifacts: readonly { type?: unknown; data?: unknown }[] | undefined): boolean =>
  (artifacts || []).some((a) => {
    const data = recordOf(a?.data);
    if (!data) return false;
    if (a.type === 'agent_activity') {
      return Array.isArray(data.steps) && data.steps.some((step) => isConnectorToolName(recordOf(step)?.tool));
    }
    if (a.type === 'swarm_trace') {
      return (
        Array.isArray(data.agents) &&
        data.agents.some((agent) => {
          const events = recordOf(agent)?.toolEvents;
          return Array.isArray(events) && events.some((e) => isConnectorToolName(recordOf(e)?.tool));
        })
      );
    }
    return false;
  });

/**
 * The marker a reply the user STOPPED keeps. A stopped reply has no `final` payload (no server mark,
 * no tool events), but its partial text is kept and sent back as history, so it is marked when the
 * stream's `meta` said the turn may carry connected content (`metaConnectorPrivacy`), or when its live
 * trace already shows a connector tool. Over-marking a connected user's stopped reply is safe: a later
 * free-model turn of that chat is refused instead of receiving it.
 */
export const stoppedTurnMarker = (input: {
  metaConnectorPrivacy?: boolean;
  artifacts?: readonly { type?: unknown; data?: unknown }[];
}): { connectorData?: true } =>
  input.metaConnectorPrivacy === true || traceNamesConnectorTool(input.artifacts) ? { connectorData: true } : {};

// ── Free-model turns and the long-term memory flag ───────────────────────────────────────────

/** A model id that is a free endpoint: the catalog says so, or the `:free` suffix. */
export const isFreeModel = (model: string | null | undefined, catalogIsFree?: boolean): boolean =>
  Boolean(model) && (catalogIsFree === true || hasFreeSuffix(model));

/**
 * The client's view of whether a turn may run on a free model. Only OpenRouter has free models, so a
 * turn whose source is a direct provider never does (its key is the user's own, or the server
 * withholds flagged memory itself for an unconfirmed platform key). An OpenRouter turn (or Auto, no
 * source yet) may: Free only is on (every Free only turn, whatever model is pinned), or the model it
 * names is free. Flagged memory stays out of these turns.
 */
export const mayRunOnFreeModel = (input: {
  freeOnly: boolean;
  model?: string | null;
  modelIsFree?: boolean;
  /** The turn's source (ModelSourceId); unset = Auto, which runs on OpenRouter. */
  source?: string | null;
}): boolean => {
  if (input.source && input.source !== 'openrouter') return false;
  return input.freeOnly || isFreeModel(input.model, input.modelIsFree);
};

// ── The calm notice ───────────────────────────────────────────────────────────────────────────

/**
 * Which refusal a notice turn stands for:
 *  - 'standard-model': the turn would have run on a free model and the chat carries connected content (409);
 *  - 'budget': the usage is used up and the free fallback is off for this chat (402).
 */
export type ConnectedDataNoticeKind = 'standard-model' | 'budget';

/** The actions a notice offers. */
export type ConnectedDataAction = 'standard-model' | 'new-chat' | 'api-keys';

/** Each notice's two ways forward, primary first (the server copy names exactly these). */
export const CONNECTED_DATA_ACTIONS: Record<ConnectedDataNoticeKind, readonly [ConnectedDataAction, ConnectedDataAction]> = {
  'standard-model': ['standard-model', 'new-chat'],
  budget: ['new-chat', 'api-keys']
};

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The error code a failed request carries: an ApiError keeps the response body (or its `details`). */
const errorCodeOf = (err: unknown): unknown => {
  const e = record(err);
  const details = record(e?.details);
  return e?.code ?? details?.code ?? record(details?.error)?.code;
};

/**
 * The calm notice a failed chat request stands for, or null for every other failure:
 *  - HTTP 409 with code CONNECTED_DATA_NEEDS_STANDARD_MODEL (the chat routes and /api/recipes);
 *  - the same refusal raised mid-stream, which arrives as its message alone;
 *  - HTTP 402 whose message carries CONNECTED_DATA_BUDGET_SENTENCE.
 * The message is the server's own copy, shown as it is.
 */
export const connectedDataNoticeOf = (err: unknown): { kind: ConnectedDataNoticeKind; message: string } | null => {
  const e = record(err);
  if (!e) return null;
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  if (!message) return null;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (errorCodeOf(err) === CONNECTED_DATA_FREE_MODEL_CODE) return { kind: 'standard-model', message };
  if (status === undefined && message.includes(CONNECTED_DATA_REFUSAL_CLAUSE)) return { kind: 'standard-model', message };
  if (status === 402 && message.includes(CONNECTED_DATA_BUDGET_SENTENCE)) return { kind: 'budget', message };
  return null;
};

/**
 * What "Use a standard model" does, from the model the resend WOULD use (the client resolves it the
 * way a send does: Auto's pick, the chat's pinned model, or the model locked in Settings):
 *  - 'resend-paid': Auto picked a free model. Resend on Auto's best standard (non-free) pick instead;
 *    Free only is left as it is (Free only with a named paid model is a paid turn).
 *  - 'pick-model': the user chose that free model (pinned, or locked in Settings), or the turn ran on
 *    a direct provider the server will not send connected content to: the model picker names another.
 *  - 'free-only-off': no model is named and Free only is on, so Free only chose the free model: turn
 *    it off, then resend.
 *  - 'resend': the model is already standard (say the user just picked one in the picker): resend.
 * Only 'free-only-off' changes Free only.
 */
export type StandardModelStep = 'resend-paid' | 'pick-model' | 'free-only-off' | 'resend';

export const standardModelStep = (input: {
  freeOnly: boolean;
  /** The model the resend would use (undefined: none named, the server picks). */
  model?: string | null;
  modelIsFree?: boolean;
  /** The chat is on Auto and nothing locked the model: Auto chose it. */
  auto?: boolean;
  /** The resend's source; a direct provider never runs connected content on the shared key unconfirmed. */
  source?: string | null;
}): StandardModelStep => {
  if (input.source && input.source !== 'openrouter') return 'pick-model';
  if (input.model && isFreeModel(input.model, input.modelIsFree)) return input.auto ? 'resend-paid' : 'pick-model';
  if (!input.model && input.freeOnly) return 'free-only-off';
  return 'resend';
};
