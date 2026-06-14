// ============================================================================
// Gmail connector (per-user OAuth)
// ============================================================================
//
// Messages, threads, search → normalized `document` items. Full backfill paginates
// via messages.list; incremental sync resumes from a Gmail historyId (users.history)
// so it's idempotent and resumable. Scope is least-privilege gmail.readonly.
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import { googleApiFetch } from '../googleClient.js';
import { CONNECTORS_SYNC_PAGE_SIZE } from '../../config.js';
import type {
  ConnectorMetadata,
  FetchInput,
  NormalizedItem,
  SyncContext,
  SyncResult
} from '../types.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailMessageRef { id: string; threadId?: string }
interface GmailListResponse { messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }
interface GmailHeader { name: string; value: string }
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[] };
}
interface GmailProfile { emailAddress?: string; historyId?: string; messagesTotal?: number }
interface GmailHistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message?: { id: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

const header = (msg: GmailMessage, name: string): string | undefined =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export class GmailConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'gmail',
    displayName: 'Gmail',
    description: 'Read your Gmail messages, threads and search — surfaced as documents for chat, analysis and dashboards.',
    icon: 'Mail',
    category: 'google_workspace',
    authType: 'user_oauth',
    providerGroup: 'google',
    requiredScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    capabilities: { searchable: true, syncable: true, realtime: true, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/gmail/api'
  };

  // --- Gmail REST primitives ---

  private listMessages(
    token: string,
    opts: { pageToken?: string; q?: string; maxResults?: number; signal?: AbortSignal }
  ): Promise<GmailListResponse> {
    return googleApiFetch<GmailListResponse>(`${GMAIL_BASE}/messages`, {
      accessToken: token,
      query: { maxResults: opts.maxResults ?? CONNECTORS_SYNC_PAGE_SIZE, pageToken: opts.pageToken, q: opts.q },
      signal: opts.signal
    });
  }

  private getMessage(token: string, id: string, signal?: AbortSignal): Promise<GmailMessage> {
    // metadataHeaders repeats, so pass it via an explicit query string.
    return googleApiFetch<GmailMessage>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { accessToken: token, signal }
    );
  }

  private getProfile(token: string, signal?: AbortSignal): Promise<GmailProfile> {
    return googleApiFetch<GmailProfile>(`${GMAIL_BASE}/profile`, { accessToken: token, signal });
  }

  private listHistory(
    token: string,
    opts: { startHistoryId: string; pageToken?: string; signal?: AbortSignal }
  ): Promise<GmailHistoryResponse> {
    return googleApiFetch<GmailHistoryResponse>(`${GMAIL_BASE}/history`, {
      accessToken: token,
      query: { startHistoryId: opts.startHistoryId, pageToken: opts.pageToken, historyTypes: 'messageAdded' },
      signal: opts.signal
    });
  }

  /** Fetch full metadata for ids and normalize them into documents. */
  private async fetchAndNormalize(token: string, ids: string[], signal?: AbortSignal): Promise<NormalizedItem[]> {
    const out: NormalizedItem[] = [];
    for (const id of ids) {
      if (signal?.aborted) break;
      // Request the headers we render via an explicit metadataHeaders list.
      const msg = await googleApiFetch<GmailMessage>(
        `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { accessToken: token, signal }
      );
      out.push(...this.normalize(msg));
    }
    return out;
  }

  // --- Data lifecycle ---

  async syncFull(ctx: SyncContext): Promise<SyncResult> {
    const token = await ctx.getAccessToken();
    const cursor = ctx.cursor || {};
    // Capture the mailbox historyId at the START so incremental never misses backfill-era mail.
    let historyId = typeof cursor.historyId === 'string' ? cursor.historyId : undefined;
    if (!historyId) {
      const profile = await this.getProfile(token, ctx.signal);
      historyId = profile.historyId;
    }
    const pageToken = typeof cursor.pageToken === 'string' ? cursor.pageToken : undefined;
    const list = await this.listMessages(token, {
      pageToken,
      maxResults: ctx.limit ?? CONNECTORS_SYNC_PAGE_SIZE,
      signal: ctx.signal
    });
    const items = await this.fetchAndNormalize(token, (list.messages || []).map((m) => m.id), ctx.signal);

    if (list.nextPageToken) {
      return { items, cursor: { pageToken: list.nextPageToken, historyId }, hasMore: true };
    }
    return { items, cursor: historyId ? { historyId } : {}, hasMore: false };
  }

  async syncIncremental(ctx: SyncContext): Promise<SyncResult> {
    const cursor = ctx.cursor || {};
    const startHistoryId = typeof cursor.historyId === 'string' ? cursor.historyId : undefined;
    // No baseline yet → behave like a (bounded) full sync.
    if (!startHistoryId) return this.syncFull(ctx);

    const token = await ctx.getAccessToken();
    const pageToken = typeof cursor.histPageToken === 'string' ? cursor.histPageToken : undefined;

    let hist: GmailHistoryResponse;
    try {
      hist = await this.listHistory(token, { startHistoryId, pageToken, signal: ctx.signal });
    } catch (err) {
      // A 404 means the historyId is too old (Gmail prunes history) → re-baseline via full sync.
      if (/\b404\b/.test((err as Error)?.message || '')) {
        return this.syncFull({ ...ctx, cursor: {} });
      }
      throw err;
    }

    const ids = new Set<string>();
    for (const h of hist.history || []) {
      for (const added of h.messagesAdded || []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }
    const items = await this.fetchAndNormalize(token, [...ids], ctx.signal);

    if (hist.nextPageToken) {
      return { items, cursor: { historyId: startHistoryId, histPageToken: hist.nextPageToken }, hasMore: true };
    }
    return { items, cursor: { historyId: hist.historyId || startHistoryId }, hasMore: false };
  }

  async fetch(input: FetchInput): Promise<unknown> {
    const token = await input.getAccessToken();
    if (input.resource === 'search') {
      const q = String((input.params.q ?? input.params.query) || '');
      const maxResults = Math.min(25, Number(input.params.maxResults) || 10);
      const list = await this.listMessages(token, { q, maxResults, signal: input.signal });
      const items = await this.fetchAndNormalize(token, (list.messages || []).map((m) => m.id), input.signal);
      return { items };
    }
    if (input.resource === 'message') {
      const id = String(input.params.id || '');
      const msg = await this.getMessage(token, id, input.signal);
      return { message: msg, items: this.normalize(msg) };
    }
    throw new Error(`Unsupported Gmail resource: ${input.resource}`);
  }

  normalize(raw: unknown): NormalizedItem[] {
    const msg = raw as GmailMessage;
    if (!msg || !msg.id) return [];
    const from = header(msg, 'From');
    const subject = header(msg, 'Subject');
    const dateHeader = header(msg, 'Date');
    const internalMs = msg.internalDate ? Number(msg.internalDate) : NaN;
    const occurredAt = Number.isFinite(internalMs)
      ? new Date(internalMs).toISOString()
      : dateHeader
        ? safeIso(dateHeader)
        : null;
    return [
      {
        kind: 'document',
        externalId: msg.id,
        title: subject || '(no subject)',
        snippet: msg.snippet || null,
        contentText: msg.snippet || null,
        author: from || null,
        url: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
        occurredAt,
        payload: {
          threadId: msg.threadId || null,
          labelIds: msg.labelIds || [],
          from: from || null,
          subject: subject || null
        }
      }
    ];
  }
}

const safeIso = (s: string): string | null => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
