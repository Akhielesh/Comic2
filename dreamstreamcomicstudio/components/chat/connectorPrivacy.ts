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

// ── Free-model turns and the long-term memory flag ───────────────────────────────────────────

/** A model id that is a free endpoint: the catalog says so, or the `:free` suffix. */
export const isFreeModel = (model: string | null | undefined, catalogIsFree?: boolean): boolean =>
  Boolean(model) && (catalogIsFree === true || hasFreeSuffix(model));

/**
 * The client's view of whether a turn may run on a free model: Free only is on (every Free only turn,
 * whatever model is pinned), or the model it names is free. Flagged memory stays out of these turns.
 */
export const mayRunOnFreeModel = (input: { freeOnly: boolean; model?: string | null; modelIsFree?: boolean }): boolean =>
  input.freeOnly || isFreeModel(input.model, input.modelIsFree);

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
 * What "Use a standard model" does: a free model pinned on the chat (or locked in Settings) is
 * replaced in the model picker; otherwise Free only is what chose the free model, so it is turned off.
 * With Free only already off and nothing pinned, the picker is the one way to name a standard model.
 */
export const standardModelStep = (input: {
  freeOnly: boolean;
  pinnedModel?: string | null;
  pinnedIsFree?: boolean;
}): 'pick-model' | 'free-only-off' => {
  if (input.pinnedModel && isFreeModel(input.pinnedModel, input.pinnedIsFree)) return 'pick-model';
  return input.freeOnly ? 'free-only-off' : 'pick-model';
};
