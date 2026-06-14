// ============================================================================
// Google Calendar connector (per-user OAuth)
// ============================================================================
// Events + free/busy → normalized `event` items. Full sync captures a nextSyncToken
// so incremental sync is a true delta (re-baselines on 410 GONE). Least-privilege:
// calendar.events.readonly.
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import { googleApiFetch } from '../googleClient.js';
import { CONNECTORS_SYNC_PAGE_SIZE } from '../../config.js';
import type { ConnectorMetadata, FetchInput, NormalizedItem, SyncContext, SyncResult } from '../types.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface CalEventTime { date?: string; dateTime?: string }
interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: CalEventTime;
  end?: CalEventTime;
  attendees?: Array<{ email?: string }>;
  organizer?: { email?: string; displayName?: string };
}
interface CalList {
  items?: CalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

const whenOf = (t?: CalEventTime): string | null => t?.dateTime || (t?.date ? new Date(t.date).toISOString() : null);

export class GoogleCalendarConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'google_calendar',
    displayName: 'Google Calendar',
    description: 'Your calendar events and free/busy — surfaced as events for chat, analysis and dashboards.',
    icon: 'Calendar',
    category: 'google_workspace',
    authType: 'user_oauth',
    providerGroup: 'google',
    requiredScopes: [
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    capabilities: { searchable: true, syncable: true, realtime: true, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/calendar/api'
  };

  private list(
    token: string,
    query: Record<string, string | number | undefined>,
    signal?: AbortSignal
  ): Promise<CalList> {
    return googleApiFetch<CalList>(CAL_BASE, {
      accessToken: token,
      query: { maxResults: CONNECTORS_SYNC_PAGE_SIZE, singleEvents: 'true', ...query },
      signal
    });
  }

  async syncFull(ctx: SyncContext): Promise<SyncResult> {
    const token = await ctx.getAccessToken();
    const pageToken = typeof ctx.cursor.pageToken === 'string' ? ctx.cursor.pageToken : undefined;
    // Backfill from 30 days ago forward, ordered; capture the syncToken for deltas.
    const timeMin = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const res = await this.list(token, { pageToken, orderBy: 'startTime', timeMin }, ctx.signal);
    const items = (res.items || []).flatMap((e) => this.normalize(e));
    if (res.nextPageToken) return { items, cursor: { pageToken: res.nextPageToken, timeMin }, hasMore: true };
    return { items, cursor: res.nextSyncToken ? { syncToken: res.nextSyncToken } : {}, hasMore: false };
  }

  async syncIncremental(ctx: SyncContext): Promise<SyncResult> {
    const syncToken = typeof ctx.cursor.syncToken === 'string' ? ctx.cursor.syncToken : undefined;
    if (!syncToken) return this.syncFull(ctx);
    const token = await ctx.getAccessToken();
    const pageToken = typeof ctx.cursor.histPageToken === 'string' ? ctx.cursor.histPageToken : undefined;
    try {
      const res = await this.list(token, { syncToken, pageToken }, ctx.signal);
      const items = (res.items || []).flatMap((e) => this.normalize(e));
      if (res.nextPageToken) return { items, cursor: { syncToken, histPageToken: res.nextPageToken }, hasMore: true };
      return { items, cursor: res.nextSyncToken ? { syncToken: res.nextSyncToken } : { syncToken }, hasMore: false };
    } catch (err) {
      // 410 GONE → the syncToken expired; re-baseline with a full sync.
      if (/\b410\b/.test((err as Error)?.message || '')) return this.syncFull({ ...ctx, cursor: {} });
      throw err;
    }
  }

  async fetch(input: FetchInput): Promise<unknown> {
    const token = await input.getAccessToken();
    if (input.resource === 'search') {
      const res = await this.list(token, { q: String(input.params.q || input.params.query || ''), orderBy: 'startTime', timeMin: new Date().toISOString() }, input.signal);
      return { items: (res.items || []).flatMap((e) => this.normalize(e)) };
    }
    throw new Error(`Unsupported Calendar resource: ${input.resource}`);
  }

  normalize(raw: unknown): NormalizedItem[] {
    const e = raw as CalEvent;
    if (!e || !e.id || e.status === 'cancelled') return [];
    return [
      {
        kind: 'event',
        externalId: e.id,
        title: e.summary || '(busy)',
        snippet: e.description || e.location || null,
        url: e.htmlLink || null,
        author: e.organizer?.displayName || e.organizer?.email || null,
        occurredAt: whenOf(e.start),
        payload: {
          start: whenOf(e.start),
          end: whenOf(e.end),
          location: e.location || null,
          attendees: e.attendees?.length || 0,
          status: e.status || null
        }
      }
    ];
  }
}
