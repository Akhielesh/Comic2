// ============================================================================
// Connector AI tools — let the chat model act on the user's CONNECTED accounts
// ============================================================================
//
// These are the "AI consumption layer" over the account-connector framework: the
// model can live-call the signed-in user's own Gmail / Drive / Calendar / Sheets /
// Maps, plus a unified RAG search over everything synced. Each tool is scoped to
// `ctx.userId` (never another user's data) and degrades honestly:
//   * no userId on the turn  → "sign in"
//   * connector not connected → "connect it in Connectors"
//   * token revoked/expired   → "reconnect"
//
// They're registered as CONTEXTUAL tools (built per-request with ctx) in registry.ts.
// ============================================================================

import type { ChatTool, ToolContext, ToolExecResult } from './types.js';
import { connectorRegistry } from '../../connectors/index.js';
import { getActiveConnection, toConnectionRef, type ConnectionRow } from '../../connectors/store.js';
import { getValidAccessToken } from '../../connectors/credentials.js';
import { retrieveItems } from '../../connectors/retrieval.js';
import { ConnectorAuthError, type AccountConnector, type NormalizedItem } from '../../connectors/types.js';

interface DisplayItem {
  title?: string | null;
  snippet?: string | null;
  url?: string | null;
  author?: string | null;
  occurredAt?: string | null;
}

const notConnected = (label: string): ToolExecResult => ({
  content: `No ${label} connection found for this account. Ask the user to connect ${label} in the Connectors section, then try again.`,
  notice: { level: 'info', message: `${label} isn't connected`, fix: `Open Connectors → connect ${label}.` }
});

const needsAuth = (label: string): ToolExecResult => ({
  content: `The ${label} connection's authorization has expired or was revoked. Ask the user to reconnect ${label} in Connectors.`,
  notice: { level: 'warn', message: `${label} needs reconnect`, fix: `Open Connectors → reconnect ${label}.` }
});

const signInFirst = (): ToolExecResult => ({
  content: 'This tool reads the signed-in user\'s connected accounts, but no user is signed in this turn.',
  notice: { level: 'info', message: 'Sign in to use connected-account tools' }
});

const formatItems = (label: string, items: DisplayItem[], query?: string): ToolExecResult => {
  if (!items.length) {
    return {
      content: `No ${label} results${query ? ` for "${query}"` : ''}. Tell the user nothing matched and suggest a different query.`
    };
  }
  const lines = items.slice(0, 15).map((it, i) => {
    const when = it.occurredAt ? ` · ${it.occurredAt.slice(0, 10)}` : '';
    const who = it.author ? ` · ${it.author}` : '';
    const snip = (it.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return `${i + 1}. ${it.title || '(untitled)'}${who}${when}${snip ? `\n   ${snip}` : ''}`;
  });
  const citations = items
    .filter((it) => it.url)
    .slice(0, 15)
    .map((it) => ({ url: it.url as string, title: it.title || undefined }));
  return {
    content: `${label} results${query ? ` for "${query}"` : ''} (${items.length}). Synthesize a concise answer and cite the sources:\n${lines.join('\n')}`,
    citations
  };
};

/** Resolve the user's connection + connector instance, or a friendly failure result. */
const resolve = async (
  ctx: ToolContext | undefined,
  connectorId: string,
  label: string
): Promise<{ connection: ConnectionRow; connector: AccountConnector } | { fail: ToolExecResult }> => {
  if (!ctx?.userId) return { fail: signInFirst() };
  const connector = connectorRegistry.get(connectorId);
  if (!connector) return { fail: notConnected(label) };
  let connection: ConnectionRow | null = null;
  try {
    connection = await getActiveConnection(ctx.userId, connectorId);
  } catch {
    return { fail: { content: `Could not look up the ${label} connection right now.`, notice: { level: 'warn', message: 'lookup failed' } } };
  }
  if (!connection) return { fail: notConnected(label) };
  return { connection, connector };
};

/** Run a connector.fetch() and format it, mapping auth errors to a reconnect prompt. */
const fetchAndFormat = async (
  ctx: ToolContext | undefined,
  connectorId: string,
  label: string,
  resource: string,
  params: Record<string, unknown>,
  query?: string
): Promise<ToolExecResult> => {
  const r = await resolve(ctx, connectorId, label);
  if ('fail' in r) return r.fail;
  try {
    const data = (await r.connector.fetch({
      connection: toConnectionRef(r.connection),
      getAccessToken: () => getValidAccessToken(r.connection, r.connector),
      resource,
      params
    })) as { items?: NormalizedItem[] };
    return formatItems(label, (data?.items || []) as DisplayItem[], query);
  } catch (err) {
    if (err instanceof ConnectorAuthError) return needsAuth(label);
    return { content: `${label} request failed: ${(err as Error)?.message || 'unknown error'}.`, notice: { level: 'warn', message: `${label} error` } };
  }
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required
});

// ---- Tool factories (one per connector capability) --------------------------

const makeGmailSearch = (ctx?: ToolContext): ChatTool => ({
  name: 'gmail_search',
  description:
    "Search the signed-in user's OWN Gmail (their connected account) and return matching messages. Use for 'my email', 'find the email from…', 'search my inbox'. Supports Gmail search operators in `query` (from:, subject:, newer_than:7d, has:attachment).",
  parameters: obj(
    {
      query: { type: 'string', description: 'Gmail search query, e.g. "from:bob subject:invoice newer_than:30d".' },
      max: { type: 'number', description: 'Max messages to return (default 10, cap 25).' }
    },
    ['query']
  ),
  execute: (args) =>
    fetchAndFormat(ctx, 'gmail', 'Gmail', 'search', { q: String(args.query || ''), maxResults: Number(args.max) || 10 }, String(args.query || ''))
});

const makeDriveSearch = (ctx?: ToolContext): ChatTool => ({
  name: 'drive_search',
  description:
    "Search the signed-in user's OWN Google Drive files by name and return matches (name, type, link, modified date). Use for 'my files', 'find my doc/sheet/slide', 'my Drive'.",
  parameters: obj({ query: { type: 'string', description: 'Text to match in file names.' } }, ['query']),
  execute: (args) => fetchAndFormat(ctx, 'google_drive', 'Google Drive', 'search', { q: String(args.query || '') }, String(args.query || ''))
});

const makeCalendarAgenda = (ctx?: ToolContext): ChatTool => ({
  name: 'calendar_agenda',
  description:
    "Look at the signed-in user's OWN Google Calendar (their connected account) for upcoming events. Use for 'my schedule', 'what's on my calendar', 'my next meeting', 'am I free…'.",
  parameters: obj({ query: { type: 'string', description: 'Optional free-text filter, e.g. "standup" or "with Alice".' } }),
  execute: (args) => fetchAndFormat(ctx, 'google_calendar', 'Calendar', 'search', { q: String(args.query || '') }, String(args.query || ''))
});

const makeSheetsRead = (ctx?: ToolContext): ChatTool => ({
  name: 'sheets_read',
  description:
    "Read a range of cells from one of the signed-in user's OWN Google Sheets as structured rows. Provide the spreadsheetId (from its URL) and an A1 range. Use to analyze/summarize the user's sheet data.",
  parameters: obj(
    {
      spreadsheetId: { type: 'string', description: 'The spreadsheet ID from its URL (the long token between /d/ and /edit).' },
      range: { type: 'string', description: 'A1 range, e.g. "Sheet1!A1:F100". Defaults to A1:Z1000.' }
    },
    ['spreadsheetId']
  ),
  execute: async (args): Promise<ToolExecResult> => {
    const r = await resolve(ctx, 'google_sheets', 'Google Sheets');
    if ('fail' in r) return r.fail;
    try {
      const data = (await r.connector.fetch({
        connection: toConnectionRef(r.connection),
        getAccessToken: () => getValidAccessToken(r.connection, r.connector),
        resource: 'values',
        params: { spreadsheetId: String(args.spreadsheetId || ''), range: String(args.range || 'A1:Z1000') }
      })) as { items?: NormalizedItem[] };
      const rows = (data?.items || []) as NormalizedItem[];
      if (!rows.length) return { content: 'The sheet range returned no rows (it may be empty or the range/ID is wrong).' };
      const preview = rows.slice(0, 30).map((it) => JSON.stringify((it.payload as any)?.fields ?? {})).join('\n');
      return { content: `Read ${rows.length} row(s) from the sheet. Analyze/summarize as asked:\n${preview}` };
    } catch (err) {
      if (err instanceof ConnectorAuthError) return needsAuth('Google Sheets');
      return { content: `Sheets read failed: ${(err as Error)?.message || 'unknown error'}.`, notice: { level: 'warn', message: 'Sheets error' } };
    }
  }
});

const makeMapsLookup = (ctx?: ToolContext): ChatTool => ({
  name: 'maps_lookup',
  description:
    'Geocode an address or find places via the connected Google Maps key. Use mode "geocode" for address→coordinates, or "places" to search businesses/points of interest by text.',
  parameters: obj(
    {
      query: { type: 'string', description: 'An address (geocode) or a place text search (places).' },
      mode: { type: 'string', enum: ['geocode', 'places'], description: 'Default "places".' }
    },
    ['query']
  ),
  execute: (args) => {
    const mode = args.mode === 'geocode' ? 'geocode' : 'places';
    const params = mode === 'geocode' ? { address: String(args.query || '') } : { query: String(args.query || '') };
    return fetchAndFormat(ctx, 'google_maps', 'Google Maps', mode, params, String(args.query || ''));
  }
});

const makeConnectedSearch = (ctx?: ToolContext): ChatTool => ({
  name: 'connected_data_search',
  description:
    "Search ACROSS everything the user has connected and synced (their Gmail, Drive, Calendar, YouTube) in one query — a unified RAG search over their connected accounts. Use when the source isn't specified: 'what do I have about X', 'search my stuff', 'across my accounts'.",
  parameters: obj(
    {
      query: { type: 'string', description: 'What to look for across the user\'s connected data.' },
      kind: { type: 'string', enum: ['document', 'record', 'event'], description: 'Optional: restrict to documents, records, or events.' }
    },
    ['query']
  ),
  execute: async (args): Promise<ToolExecResult> => {
    if (!ctx?.userId) return signInFirst();
    try {
      const rows = await retrieveItems({
        userId: ctx.userId,
        query: String(args.query || ''),
        kind: typeof args.kind === 'string' ? (args.kind as any) : undefined,
        limit: 15
      });
      // Map the stored row shape (occurred_at) to the formatter's DisplayItem (occurredAt).
      const display: DisplayItem[] = rows.map((r) => ({
        title: r.title,
        snippet: r.snippet,
        url: r.url,
        author: r.author,
        occurredAt: r.occurred_at
      }));
      return formatItems('Connected data', display, String(args.query || ''));
    } catch (err) {
      return { content: `Connected-data search failed: ${(err as Error)?.message || 'unknown error'}.`, notice: { level: 'warn', message: 'search error' } };
    }
  }
});

const FACTORIES: Record<string, (ctx?: ToolContext) => ChatTool> = {
  gmail_search: makeGmailSearch,
  drive_search: makeDriveSearch,
  calendar_agenda: makeCalendarAgenda,
  sheets_read: makeSheetsRead,
  maps_lookup: makeMapsLookup,
  connected_data_search: makeConnectedSearch
};

/** The connector tool names (registered as contextual tools in the registry). */
export const CONNECTOR_TOOL_NAMES = Object.keys(FACTORIES);

/** Build a connector tool by name with the per-request context, or null if unknown. */
export const buildConnectorTool = (name: string, ctx?: ToolContext): ChatTool | null => {
  const factory = FACTORIES[name];
  return factory ? factory(ctx) : null;
};
