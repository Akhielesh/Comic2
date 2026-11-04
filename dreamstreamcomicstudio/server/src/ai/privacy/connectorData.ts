// Connected-account privacy (Google Limited Use): which model calls carry content from the user's
// connected accounts (Gmail, Drive, Calendar, Sheets, Maps, the unified connected-data search, and
// the Nango proxy to any other connected API), so those calls never reach a model endpoint that
// may log or train on what it receives.
//
// Pure: no I/O, no clock, no globals. Every agent path asks the same question here:
//   - routes/chat.ts prepareChat (POST /, /stream, /swarm, and /api/recipes via prepareChat),
//     plus the chat helpers that summarise a conversation (title, memory, follow-ups);
//   - ai/recipes/runRecipe.ts (a recipe's own tool list);
//   - ai/agents/orchestrator.ts (the swarm: planner, agents, synthesis; also run_agent_swarm).
//
// How connected-account content can enter a model call (each is a ConnectorDataSource):
//   'tools'   - a connector tool is OFFERED this turn: the model may call it, and its output is fed
//               back into the next round of the same turn. Offered is enough: the routing of the
//               whole turn (models chain, privacy flag) is fixed before the first call.
//   'context' - the connector RAG block (connectors/retrieval.ts buildConnectorContextBlock, injected
//               by ai/chat.ts when `connectorContext` is on) may be added to the system prompt.
//   'history' - the messages already carry connector output: an assistant tool call to a connector
//               tool, a tool result spotlighted as a connector tool's output, a JSON-protocol
//               TOOL_RESULT of a connector tool, the RAG block itself, or an explicit provenance
//               marker on a message (`connectorData: true`, or `toolEvents` naming a connector tool).
//   'inherited' - an enclosing call already decided this run carries connector content (the
//               caller's privacy scope, see ./scope.ts, or the decision bound to the request).
//
// What the chat client sends as history today is plain text (role + content), so 'history' only
// sees the markers above. Turns answered from connected content carry `connectorData: true` in
// their response; the client echoing it back on those assistant turns (wave note) makes 'history'
// exact for chat. Until then the conservative rules in routes/chat.ts apply (see
// docs/DATA_CONNECTORS.md, "Connected-account privacy").

import { hasFreeSuffix } from '../../../../shared/pricing.js';

/**
 * Tools whose output is the user's connected-account content. Kept beside the connector tool
 * factories by a parity test (connectorData.test.ts checks ai/tools/connectors.ts CONNECTOR_TOOL_NAMES
 * is a subset). `nango_call_api` proxies an authenticated request to any API the user connected
 * through Nango, so it counts too; Nango's discovery and connect-link tools return no account data.
 * User-configured MCP servers are the user's own third-party services, not connectors this app
 * holds OAuth grants for, so their tools are not listed (documented in docs/DATA_CONNECTORS.md).
 */
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

const CONNECTOR_TOOL_SET = new Set(CONNECTOR_DATA_TOOL_NAMES);
/** A future tool in one of the connector families counts even before this list is updated. */
const CONNECTOR_TOOL_PREFIXES = ['gmail_', 'drive_', 'calendar_', 'sheets_', 'connected_data_'];

export const isConnectorToolName = (name: unknown): boolean =>
  typeof name === 'string' && (CONNECTOR_TOOL_SET.has(name) || CONNECTOR_TOOL_PREFIXES.some((p) => name.startsWith(p)));

/** The heading connectors/retrieval.ts gives the RAG block (parity-tested). */
export const CONNECTOR_CONTEXT_HEADING = '## Connected account data';

/** True for a model id that is a free endpoint (`:free`), the endpoints that may log or train. */
export const isFreeModelId = (model: unknown): boolean => typeof model === 'string' && hasFreeSuffix(model);

export type ConnectorDataSource = 'tools' | 'context' | 'history' | 'inherited';

export interface ConnectorTurnInput {
  /** Tool names offered to the model (any agent path: chat, recipe, swarm agent). */
  toolNames?: readonly unknown[];
  /** The connector RAG block may be injected (connectorContext on for a user who may have synced items). */
  connectorContext?: boolean;
  /** Messages the call sends, or the raw request history (markers are read from either). */
  messages?: readonly unknown[];
  /** An enclosing scope or request-level decision already says this run carries connector content. */
  inherited?: boolean;
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const textOfContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = record(part);
        return p && typeof p.text === 'string' ? p.text : '';
      })
      .join('\n');
  }
  return '';
};

// ai/tools/spotlight.ts wraps every successful tool result fed back to the model this way.
const SPOTLIGHT_RE = /UNTRUSTED OUTPUT from the tool "([^"]+)"/g;
// ai/tools/jsonToolProtocol.ts formatToolResult (non-OpenRouter tool loop).
const JSON_TOOL_RESULT_RE = /TOOL_RESULT \(([^)\s]+)\):/g;

const textNamesConnectorOutput = (text: string): boolean => {
  if (!text) return false;
  if (text.includes(CONNECTOR_CONTEXT_HEADING)) return true;
  for (const re of [SPOTLIGHT_RE, JSON_TOOL_RESULT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (isConnectorToolName(m[1])) return true;
    }
  }
  return false;
};

/** One message (a provider ChatMessage or a raw request message) carries connector content. */
export const messageCarriesConnectorData = (message: unknown): boolean => {
  const m = record(message);
  if (!m) return false;
  // Explicit provenance marker (set by the client on assistant turns the server marked).
  if (m.connectorData === true) return true;
  if (Array.isArray(m.toolEvents) && m.toolEvents.some((e) => isConnectorToolName(record(e)?.tool))) return true;
  // An assistant turn that called a connector tool: its tool results follow in the same messages.
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      const fn = record(record(call)?.function);
      if (isConnectorToolName(fn?.name ?? record(call)?.name)) return true;
    }
  }
  return textNamesConnectorOutput(textOfContent(m.content));
};

/** Any of the messages carries connector content. */
export const messagesCarryConnectorData = (messages: readonly unknown[] | undefined): boolean =>
  Array.isArray(messages) && messages.some(messageCarriesConnectorData);

/** Every way connector content enters this call (empty: none). */
export const connectorDataSources = (input: ConnectorTurnInput): ConnectorDataSource[] => {
  const out: ConnectorDataSource[] = [];
  if (input.inherited) out.push('inherited');
  if ((input.toolNames || []).some(isConnectorToolName)) out.push('tools');
  if (input.connectorContext) out.push('context');
  if (messagesCarryConnectorData(input.messages)) out.push('history');
  return out;
};

/**
 * THE predicate: does this turn (or agent call) use connected-account content? When true, every
 * OpenRouter call of the turn sends `provider.data_collection: 'deny'` and no free model takes it.
 */
export const turnUsesConnectorData = (input: ConnectorTurnInput): boolean => connectorDataSources(input).length > 0;

/** The tool names a free-model turn may be offered: every connector tool removed. */
export const withoutConnectorTools = <T>(names: readonly T[], nameOf: (item: T) => unknown = (item) => item): T[] =>
  names.filter((item) => !isConnectorToolName(nameOf(item)));

// ── Copy (calm, honest, no provider jargon) ───────────────────────────────────────────────────

/** Error code of the free-model refusal (HTTP 409 from the chat routes). */
export const CONNECTED_DATA_FREE_MODEL_CODE = 'CONNECTED_DATA_NEEDS_STANDARD_MODEL';

/** A free-model turn whose conversation already carries connected-account content: what, why, two ways forward. */
export const CONNECTED_DATA_FREE_MODEL_MESSAGE =
  "This chat includes content from your connected accounts (such as Gmail, Drive or Calendar), so this message wasn't sent. " +
  'It was going to a free model, and free models may keep or learn from what they receive, so your connected content never goes to them. ' +
  'Nothing was sent and nothing was spent. To continue, switch to a standard model (turn off Free only), or start a new chat without connected content.';

/** Appended to a usage-budget refusal when the free re-plan is off because of connected content. */
export const CONNECTED_DATA_BUDGET_SENTENCE =
  "This chat includes content from your connected accounts, which is never sent to free models, so it can't continue on one. " +
  'Start a new chat without connected content to keep chatting on free models, or add your own API key in Settings → API keys.';

/**
 * Told to the model on a free-model turn for a user with connected accounts (they were withheld).
 * `freeOnly`: the user chose free models (the way forward is turning Free only off); otherwise the
 * free model came from a fallback (used-up usage, a busy shared service) and that advice would be wrong.
 */
export const connectedAccountsWithheldNote = (freeOnly: boolean): string =>
  "CONNECTED ACCOUNTS ARE OFF FOR THIS REPLY. It runs on a free model, and the user's connected accounts (Gmail, Drive, Calendar and other connectors) are never sent to free models, because free model endpoints may keep or learn from what they receive. " +
  `If the user asks about their email, files, calendar or other connected data, say so plainly in one sentence and give the two ways forward: ${
    freeOnly ? 'switch to a standard model (turn off Free only)' : 'try again on a standard model later'
  }, or ask without their connected content. Never guess or invent their data.`;

/** Shown to the user when a free-model turn asked about connected data and the tools were withheld. */
export const connectedAccountsWithheldNotice = (freeOnly: boolean): string =>
  "Your connected accounts weren't used for this reply: it ran on a free model, and connected content is only sent to standard models. " +
  (freeOnly ? 'Switch to a standard model (turn off Free only) to use them.' : 'They work again once replies come from a standard model.');

/** The free-only variants (the common case). */
export const CONNECTED_ACCOUNTS_WITHHELD_NOTE = connectedAccountsWithheldNote(true);
export const CONNECTED_ACCOUNTS_WITHHELD_NOTICE = connectedAccountsWithheldNotice(true);
