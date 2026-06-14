// ============================================================================
// Gmail connector (per-user OAuth)
// ============================================================================
//
// Messages, threads, search → normalized `document` items. Full backfill paginates
// via messages.list; incremental sync resumes from a Gmail historyId (users.history)
// so it's idempotent and resumable. Scope is least-privilege gmail.readonly.
//
// On top of the sync pipeline, fetch() also serves the Chat Studio EMAIL WIDGETS
// (the email "terminal"): the resources `inbox` / `unread` / `search` return rich
// EmailMessage rows (sender, flags, labels, link), `message` reads a single message's
// full decoded body, and `thread` reads a whole conversation. All read-only.
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
// Cap a decoded body so a giant email can't bloat a response/transport.
const MAX_BODY_CHARS = 20_000;

interface GmailMessageRef { id: string; threadId?: string }
interface GmailListResponse { messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }
interface GmailHeader { name: string; value: string }
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[] } & GmailPart;
}
interface GmailThreadResponse { id?: string; messages?: GmailMessage[] }
interface GmailProfile { emailAddress?: string; historyId?: string; messagesTotal?: number }
interface GmailHistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message?: { id: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

/** Rich email row consumed by the Chat Studio email widgets (mirrors apiTypes EmailMessage). */
interface EmailMessageView {
  id: string;
  threadId: string | null;
  subject: string;
  from: { name: string; email: string } | null;
  to: string | null;
  snippet: string | null;
  date: string | null;
  unread: boolean;
  starred: boolean;
  important: boolean;
  labels: string[];
  url: string;
  body?: string;
}

const header = (msg: GmailMessage, name: string): string | undefined =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

const safeIso = (s: string): string | null => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Parse a `"Name" <email>` header into its parts (falls back to the raw string). */
const parseAddress = (raw?: string): { name: string; email: string } | null => {
  if (!raw) return null;
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim() || m[2].trim(), email: m[2].trim() };
  const v = raw.trim();
  return v ? { name: v, email: v } : null;
};

const decodeB64Url = (data?: string): string => {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch {
    return '';
  }
};

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Walk a MIME tree, preferring text/plain, falling back to stripped text/html. */
const extractPlainText = (payload?: GmailPart): string => {
  if (!payload) return '';
  const walk = (part: GmailPart | undefined, prefer: string): string => {
    if (!part) return '';
    if (part.mimeType === prefer && part.body?.data) return decodeB64Url(part.body.data);
    for (const p of part.parts || []) {
      const r = walk(p, prefer);
      if (r) return r;
    }
    return '';
  };
  const plain = walk(payload, 'text/plain');
  const text = plain || stripHtml(walk(payload, 'text/html'));
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…` : text;
};

const clampMax = (v: unknown, fallback: number, cap: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(cap, Math.floor(n)) : fallback;
};

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
      `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      { accessToken: token, signal }
    );
  }

  private getFullMessage(token: string, id: string, signal?: AbortSignal): Promise<GmailMessage> {
    return googleApiFetch<GmailMessage>(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`, {
      accessToken: token,
      signal
    });
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

  /** Fetch full metadata for ids and normalize them into documents (sync pipeline). */
  private async fetchAndNormalize(token: string, ids: string[], signal?: AbortSignal): Promise<NormalizedItem[]> {
    const out: NormalizedItem[] = [];
    for (const id of ids) {
      if (signal?.aborted) break;
      const msg = await googleApiFetch<GmailMessage>(
        `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { accessToken: token, signal }
      );
      out.push(...this.normalize(msg));
    }
    return out;
  }

  // --- Email-widget data path (rich rows + bodies) ---

  /** Map a Gmail message to the rich row the email widgets render. */
  private toEmailView(msg: GmailMessage, withBody = false): EmailMessageView {
    const labels = msg.labelIds || [];
    const internalMs = msg.internalDate ? Number(msg.internalDate) : NaN;
    const date = Number.isFinite(internalMs)
      ? new Date(internalMs).toISOString()
      : header(msg, 'Date')
        ? safeIso(header(msg, 'Date') as string)
        : null;
    return {
      id: msg.id,
      threadId: msg.threadId || null,
      subject: header(msg, 'Subject') || '(no subject)',
      from: parseAddress(header(msg, 'From')),
      to: header(msg, 'To') || null,
      snippet: msg.snippet || null,
      date,
      unread: labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      important: labels.includes('IMPORTANT'),
      labels,
      url: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
      ...(withBody ? { body: extractPlainText(msg.payload) } : {})
    };
  }

  /** List messages matching `q` and hydrate each into a rich email row. */
  private async listEmails(
    token: string,
    opts: { q?: string; pageToken?: string; max?: number; signal?: AbortSignal }
  ): Promise<{ emails: EmailMessageView[]; nextCursor: string | null }> {
    const list = await this.listMessages(token, {
      q: opts.q,
      pageToken: opts.pageToken,
      maxResults: opts.max ?? 25,
      signal: opts.signal
    });
    const ids = (list.messages || []).map((m) => m.id);
    const emails: EmailMessageView[] = [];
    for (const id of ids) {
      if (opts.signal?.aborted) break;
      const msg = await this.getMessage(token, id, opts.signal);
      emails.push(this.toEmailView(msg));
    }
    return { emails, nextCursor: list.nextPageToken || null };
  }

  // --- Data lifecycle (sync) ---

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
    const resource = input.resource;
    const p = input.params || {};

    // Email widgets: an inbox / unread / search list of rich rows.
    if (resource === 'inbox' || resource === 'unread' || resource === 'list' || resource === 'search') {
      const extra = String(p.q ?? p.query ?? '').trim();
      const base = resource === 'unread' ? 'is:unread' : resource === 'search' ? '' : 'in:inbox';
      const q = [base, extra].filter(Boolean).join(' ') || undefined;
      const { emails, nextCursor } = await this.listEmails(token, {
        q,
        pageToken: typeof p.cursor === 'string' ? p.cursor : undefined,
        max: clampMax(p.max, 25, 50),
        signal: input.signal
      });
      const box = resource === 'unread' ? 'unread' : 'inbox';
      // Keep `items` for the legacy text tool (gmail_search) that reads NormalizedItem rows.
      const items: NormalizedItem[] = emails.map((e) => ({
        kind: 'document',
        externalId: e.id,
        title: e.subject,
        snippet: e.snippet,
        contentText: e.snippet,
        author: e.from?.name || e.from?.email || null,
        url: e.url,
        occurredAt: e.date,
        payload: { threadId: e.threadId, from: e.from, unread: e.unread }
      }));
      return { box, emails, nextCursor, items };
    }

    // A single message with its full decoded body (the reading pane).
    if (resource === 'message' || resource === 'body') {
      const id = String(p.id || '');
      if (!id) throw new Error('message id is required');
      const msg = await this.getFullMessage(token, id, input.signal);
      return { email: this.toEmailView(msg, true), items: this.normalize(msg) };
    }

    // A whole conversation, each message with its body.
    if (resource === 'thread') {
      const id = String(p.id ?? p.threadId ?? '');
      if (!id) throw new Error('thread id is required');
      const thread = await googleApiFetch<GmailThreadResponse>(
        `${GMAIL_BASE}/threads/${encodeURIComponent(id)}?format=full`,
        { accessToken: token, signal: input.signal }
      );
      const emails = (thread.messages || []).map((m) => this.toEmailView(m, true));
      return { threadId: id, emails, subject: emails[0]?.subject || null };
    }

    throw new Error(`Unsupported Gmail resource: ${resource}`);
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
