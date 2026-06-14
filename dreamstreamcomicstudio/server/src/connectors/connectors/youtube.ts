// ============================================================================
// YouTube connector (per-user OAuth — the user's OWN channel)
// ============================================================================
// Lists the signed-in user's channel uploads → normalized `document` items (videos).
// Least-privilege: youtube.readonly. (Public-data-by-API-key is a planned sibling
// connector; this one covers the user's own channel/analytics surface.)
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import { googleApiFetch } from '../googleClient.js';
import { CONNECTORS_SYNC_PAGE_SIZE } from '../../config.js';
import type { ConnectorMetadata, FetchInput, NormalizedItem, SyncContext, SyncResult } from '../types.js';

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

interface ChannelsResponse {
  items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
}
interface PlaylistItem {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelTitle?: string;
    videoOwnerChannelTitle?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
}
interface PlaylistItemsResponse {
  items?: PlaylistItem[];
  nextPageToken?: string;
}

export class YouTubeConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'youtube',
    displayName: 'YouTube',
    description: "Your channel's uploads — surfaced as documents for chat, analysis and dashboards.",
    icon: 'Youtube',
    category: 'media',
    authType: 'user_oauth',
    providerGroup: 'google',
    requiredScopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    capabilities: { searchable: false, syncable: true, realtime: false, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/youtube/v3'
  };

  private async uploadsPlaylistId(token: string, signal?: AbortSignal): Promise<string | null> {
    const res = await googleApiFetch<ChannelsResponse>(`${YT_BASE}/channels`, {
      accessToken: token,
      query: { part: 'contentDetails', mine: 'true' },
      signal
    });
    return res.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
  }

  private async page(token: string, playlistId: string, pageToken?: string, signal?: AbortSignal): Promise<PlaylistItemsResponse> {
    return googleApiFetch<PlaylistItemsResponse>(`${YT_BASE}/playlistItems`, {
      accessToken: token,
      query: { part: 'snippet,contentDetails', playlistId, maxResults: Math.min(50, CONNECTORS_SYNC_PAGE_SIZE), pageToken },
      signal
    });
  }

  async syncFull(ctx: SyncContext): Promise<SyncResult> {
    const token = await ctx.getAccessToken();
    const uploads = typeof ctx.cursor.uploads === 'string' ? ctx.cursor.uploads : await this.uploadsPlaylistId(token, ctx.signal);
    if (!uploads) return { items: [], cursor: {}, hasMore: false };
    const pageToken = typeof ctx.cursor.pageToken === 'string' ? ctx.cursor.pageToken : undefined;
    const res = await this.page(token, uploads, pageToken, ctx.signal);
    const items = (res.items || []).flatMap((it) => this.normalize(it));
    return res.nextPageToken
      ? { items, cursor: { uploads, pageToken: res.nextPageToken }, hasMore: true }
      : { items, cursor: { uploads }, hasMore: false };
  }

  // Re-list the newest uploads page (idempotent upsert dedups) — channels rarely need
  // a full delta API for "what's new on my own channel".
  async syncIncremental(ctx: SyncContext): Promise<SyncResult> {
    const token = await ctx.getAccessToken();
    const uploads = typeof ctx.cursor.uploads === 'string' ? ctx.cursor.uploads : await this.uploadsPlaylistId(token, ctx.signal);
    if (!uploads) return { items: [], cursor: ctx.cursor, hasMore: false };
    const res = await this.page(token, uploads, undefined, ctx.signal);
    return { items: (res.items || []).flatMap((it) => this.normalize(it)), cursor: { uploads }, hasMore: false };
  }

  async fetch(input: FetchInput): Promise<unknown> {
    const token = await input.getAccessToken();
    if (input.resource === 'uploads') {
      const uploads = await this.uploadsPlaylistId(token, input.signal);
      if (!uploads) return { items: [] };
      const res = await this.page(token, uploads, undefined, input.signal);
      return { items: (res.items || []).flatMap((it) => this.normalize(it)) };
    }
    throw new Error(`Unsupported YouTube resource: ${input.resource}`);
  }

  normalize(raw: unknown): NormalizedItem[] {
    const it = raw as PlaylistItem;
    const videoId = it?.contentDetails?.videoId;
    if (!videoId) return [];
    const sn = it.snippet || {};
    return [
      {
        kind: 'document',
        externalId: videoId,
        title: sn.title || '(untitled video)',
        snippet: sn.description || null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        author: sn.videoOwnerChannelTitle || sn.channelTitle || null,
        occurredAt: it.contentDetails?.videoPublishedAt || sn.publishedAt || null,
        payload: { videoId, thumbnail: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null }
      }
    ];
  }
}
