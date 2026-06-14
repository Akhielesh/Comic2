// ============================================================================
// Unified retrieval / query interface for the Chat Studio
// ============================================================================
//
// One scoped surface over normalized connector_items feeding all three consumers:
//   * context / RAG     → buildConnectorContextBlock (text block for the chat prompt)
//   * analysis          → retrieveItems (structured, filterable rows)
//   * dashboard         → connectorDashboardData (typed aggregates to chart)
//
// EVERY function takes a userId and filters by it. The Chat Studio can only ever
// read connections the requesting user owns (enforced here AND by RLS on the tables).
// ============================================================================

import { listConnections, queryItems, type ItemRow } from './store.js';
import type { NormalizedKind } from './types.js';

export interface RetrievalQuery {
  userId: string;
  query?: string;
  connectorId?: string;
  connectionId?: string;
  kind?: NormalizedKind;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/** Structured retrieval over a user's normalized items (analysis + generic reads). */
export const retrieveItems = async (q: RetrievalQuery): Promise<ItemRow[]> =>
  queryItems({
    userId: q.userId,
    connectorId: q.connectorId,
    connectionId: q.connectionId,
    kind: q.kind,
    search: q.query,
    since: q.since,
    until: q.until,
    limit: q.limit ?? 25,
    offset: q.offset
  });

const sourceLabel = (connectorId: string): string =>
  connectorId
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');

const oneLine = (s: string | null | undefined, max = 160): string =>
  (s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * RAG context block injected into the chat system prompt. Returns the top matches
 * across the user's connected sources, or null if nothing relevant exists. Kept
 * compact and clearly delimited so the model treats it as authorized context.
 */
export const buildConnectorContextBlock = async (
  userId: string,
  query: string,
  opts: { limit?: number } = {}
): Promise<string | null> => {
  const rows = await retrieveItems({ userId, query: query?.trim() || undefined, limit: opts.limit ?? 6 });
  if (!rows.length) return null;

  const lines = rows.map((r) => {
    const src = sourceLabel(r.connector_id);
    const when = r.occurred_at ? ` (${r.occurred_at.slice(0, 10)})` : '';
    const title = oneLine(r.title, 120) || '(untitled)';
    const snip = oneLine(r.snippet ?? r.content_text, 180);
    return `- [${src}] ${title}${when}${snip ? ` — ${snip}` : ''}`;
  });

  return (
    `\n\n## Connected account data (the user's authorized sources)\n` +
    `These items come from accounts the user connected to this app. Use them to answer ` +
    `when relevant, and say which source you used:\n${lines.join('\n')}\n`
  );
};

export interface ConnectorDashboardData {
  totalItems: number;
  connections: Array<{
    connectionId: string;
    connectorId: string;
    accountIdentifier: string;
    status: string;
    itemCount: number;
    byKind: Record<string, number>;
    lastSyncAt: string | null;
  }>;
}

/**
 * Typed aggregates for dashboard generation — per-connection item counts and a
 * kind breakdown. Scoped to the user. (Uses a bounded scan per connection; for very
 * large datasets this would move to a SQL rollup, but the shape stays identical.)
 */
export const connectorDashboardData = async (userId: string): Promise<ConnectorDashboardData> => {
  const connections = await listConnections(userId);
  const out: ConnectorDashboardData = { totalItems: 0, connections: [] };

  for (const conn of connections) {
    // Pull a bounded window of recent items to derive the kind breakdown + count.
    const rows = await queryItems({ userId, connectionId: conn.id, limit: 500 });
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    out.totalItems += rows.length;
    out.connections.push({
      connectionId: conn.id,
      connectorId: conn.connector_id,
      accountIdentifier: conn.account_identifier,
      status: conn.status,
      itemCount: rows.length,
      byKind,
      lastSyncAt: conn.last_sync_at
    });
  }
  return out;
};
