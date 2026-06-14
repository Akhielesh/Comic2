// ============================================================================
// Google Drive connector (per-user OAuth)
// ============================================================================
// File list + metadata (+ content read on demand) → normalized `document` items.
// Least-privilege: drive.readonly.
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import { googleApiFetch } from '../googleClient.js';
import { CONNECTORS_SYNC_PAGE_SIZE } from '../../config.js';
import type { ConnectorMetadata, FetchInput, NormalizedItem, SyncContext, SyncResult } from '../types.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,iconLink,size,owners(displayName,emailAddress)';

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  iconLink?: string;
  size?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}
interface DriveList {
  files?: DriveFile[];
  nextPageToken?: string;
}

export class GoogleDriveConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'google_drive',
    displayName: 'Google Drive',
    description: 'Your Drive files and metadata — surfaced as documents for chat, analysis and dashboards.',
    icon: 'HardDrive',
    category: 'storage',
    authType: 'user_oauth',
    providerGroup: 'google',
    requiredScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    capabilities: { searchable: true, syncable: true, realtime: true, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/drive/api'
  };

  private list(token: string, opts: { pageToken?: string; q?: string; signal?: AbortSignal }): Promise<DriveList> {
    return googleApiFetch<DriveList>(DRIVE_FILES, {
      accessToken: token,
      query: {
        pageSize: CONNECTORS_SYNC_PAGE_SIZE,
        pageToken: opts.pageToken,
        q: opts.q,
        orderBy: 'modifiedTime desc',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        spaces: 'drive'
      },
      signal: opts.signal
    });
  }

  async syncFull(ctx: SyncContext): Promise<SyncResult> {
    const token = await ctx.getAccessToken();
    const pageToken = typeof ctx.cursor.pageToken === 'string' ? ctx.cursor.pageToken : undefined;
    const res = await this.list(token, { pageToken, signal: ctx.signal });
    const items = (res.files || []).flatMap((f) => this.normalize(f));
    return res.nextPageToken
      ? { items, cursor: { pageToken: res.nextPageToken }, hasMore: true }
      : { items, cursor: {}, hasMore: false };
  }

  // Drive lacks a cheap delta without the changes API + a saved startPageToken; v1 does a
  // bounded re-list of the most-recently-modified files (idempotent upsert dedups).
  async syncIncremental(ctx: SyncContext): Promise<SyncResult> {
    const token = await ctx.getAccessToken();
    const res = await this.list(token, { signal: ctx.signal });
    return { items: (res.files || []).flatMap((f) => this.normalize(f)), cursor: ctx.cursor, hasMore: false };
  }

  async fetch(input: FetchInput): Promise<unknown> {
    const token = await input.getAccessToken();
    if (input.resource === 'search') {
      const q = String(input.params.q || input.params.query || '');
      const res = await this.list(token, { q: q ? `name contains '${q.replace(/'/g, "\\'")}'` : undefined, signal: input.signal });
      return { items: (res.files || []).flatMap((f) => this.normalize(f)) };
    }
    if (input.resource === 'content') {
      const id = String(input.params.id || '');
      const text = await googleApiFetch<string>(`${DRIVE_FILES}/${encodeURIComponent(id)}?alt=media`, {
        accessToken: token,
        signal: input.signal
      }).catch(() => '');
      return { id, content: text };
    }
    throw new Error(`Unsupported Drive resource: ${input.resource}`);
  }

  normalize(raw: unknown): NormalizedItem[] {
    const f = raw as DriveFile;
    if (!f || !f.id) return [];
    return [
      {
        kind: 'document',
        externalId: f.id,
        title: f.name || '(untitled)',
        snippet: f.mimeType || null,
        url: f.webViewLink || null,
        author: f.owners?.[0]?.displayName || f.owners?.[0]?.emailAddress || null,
        occurredAt: f.modifiedTime || null,
        payload: { mimeType: f.mimeType || null, size: f.size ? Number(f.size) : null, iconLink: f.iconLink || null }
      }
    ];
  }
}
