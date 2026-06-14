// ============================================================================
// Google Sheets connector (per-user OAuth)
// ============================================================================
// Reads sheet ranges as structured data → normalized `record` items (one per row).
// Query-on-demand (you point it at a spreadsheet + range), so it isn't background-
// synced. Least-privilege: spreadsheets.readonly.
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import { googleApiFetch } from '../googleClient.js';
import type { ConnectorMetadata, FetchInput, NormalizedItem, SyncContext, SyncResult } from '../types.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

interface ValuesResponse {
  range?: string;
  values?: unknown[][];
}

export class GoogleSheetsConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'google_sheets',
    displayName: 'Google Sheets',
    description: 'Read sheet ranges as structured rows — feeds analysis and dashboards on demand.',
    icon: 'Table',
    category: 'google_workspace',
    authType: 'user_oauth',
    providerGroup: 'google',
    requiredScopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    // Query-on-demand (no list-all without Drive), so not background-synced.
    capabilities: { searchable: false, syncable: false, realtime: false, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/sheets/api'
  };

  async syncFull(_ctx: SyncContext): Promise<SyncResult> {
    return { items: [], cursor: {}, hasMore: false };
  }
  async syncIncremental(_ctx: SyncContext): Promise<SyncResult> {
    return { items: [], cursor: {}, hasMore: false };
  }

  async fetch(input: FetchInput): Promise<unknown> {
    const token = await input.getAccessToken();
    if (input.resource === 'values') {
      const spreadsheetId = String(input.params.spreadsheetId || '');
      const range = String(input.params.range || 'A1:Z1000');
      if (!spreadsheetId) throw new Error('spreadsheetId is required');
      const res = await googleApiFetch<ValuesResponse>(
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        { accessToken: token, signal: input.signal }
      );
      return { raw: res, items: this.normalize({ spreadsheetId, ...res }) };
    }
    throw new Error(`Unsupported Sheets resource: ${input.resource}`);
  }

  // Treat row 1 as headers; each subsequent row becomes a record keyed by header.
  normalize(raw: unknown): NormalizedItem[] {
    const r = raw as ValuesResponse & { spreadsheetId?: string };
    const rows = r?.values;
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const headers = (rows[0] || []).map((h) => String(h ?? ''));
    const out: NormalizedItem[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const record: Record<string, unknown> = {};
      headers.forEach((h, idx) => {
        record[h || `col${idx + 1}`] = row[idx] ?? null;
      });
      out.push({
        kind: 'record',
        externalId: `${r.spreadsheetId || 'sheet'}:${r.range || ''}:${i}`,
        title: String(row[0] ?? `Row ${i}`),
        snippet: headers.slice(0, 3).map((h, idx) => `${h}: ${row[idx] ?? ''}`).join(', ') || null,
        occurredAt: null,
        payload: { row: i, fields: record }
      });
    }
    return out;
  }
}
