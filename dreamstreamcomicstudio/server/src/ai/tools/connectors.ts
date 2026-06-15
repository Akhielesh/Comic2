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
import { GoogleCalendarConnector } from '../../connectors/connectors/googleCalendar.js';

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

// ---- Gmail email widgets (the "email terminal") -----------------------------
// Read-only: we surface an interactive inbox/unread/compose widget. Compose builds a
// Gmail deep-link (we don't send on the user's behalf — the connection is read-only).

interface EmailRowLike {
  id?: string;
  subject?: string;
  snippet?: string | null;
  url?: string;
  unread?: boolean;
}

const enc = (s: string): string => encodeURIComponent(s || '');

/** Gmail web compose deep-link (prefilled). The user reviews + sends in Gmail. */
const buildGmailComposeUrl = (d: { to?: string; cc?: string; subject?: string; body?: string }): string => {
  const q = [
    `to=${enc(d.to || '')}`,
    d.cc ? `cc=${enc(d.cc)}` : '',
    `su=${enc(d.subject || '')}`,
    `body=${enc(d.body || '')}`
  ]
    .filter(Boolean)
    .join('&');
  return `https://mail.google.com/mail/?view=cm&fs=1&${q}`;
};

const buildMailto = (d: { to?: string; cc?: string; subject?: string; body?: string }): string => {
  const q = [d.cc ? `cc=${enc(d.cc)}` : '', `subject=${enc(d.subject || '')}`, `body=${enc(d.body || '')}`]
    .filter(Boolean)
    .join('&');
  return `mailto:${enc(d.to || '')}?${q}`;
};

const EMAIL_CATEGORIES = ['primary', 'social', 'promotions', 'updates', 'forums', 'all'] as const;
type EmailCat = (typeof EMAIL_CATEGORIES)[number];

/** Resolve Gmail, list a box (inbox/unread) as rich rows, and return an email-widget artifact.
 *  Defaults to the PRIMARY category (the relevant mail) — promos/social/updates are hidden
 *  unless the user asks for them; everything stays searchable. */
const emailWidget = async (
  ctx: ToolContext | undefined,
  box: 'inbox' | 'unread',
  opts: { q?: string; max?: number; category?: EmailCat }
): Promise<ToolExecResult> => {
  const r = await resolve(ctx, 'gmail', 'Gmail');
  if ('fail' in r) return r.fail;
  const category: EmailCat = EMAIL_CATEGORIES.includes(opts.category as EmailCat) ? (opts.category as EmailCat) : 'primary';
  // A free-text query searches ALL mail (category filter would fight it); otherwise scope
  // to the chosen category. 'all' means no category filter.
  const userQ = (opts.q || '').trim();
  const catQ = userQ || category === 'all' ? '' : `category:${category}`;
  const q = [catQ, userQ].filter(Boolean).join(' ');
  try {
    const data = (await r.connector.fetch({
      connection: toConnectionRef(r.connection),
      getAccessToken: () => getValidAccessToken(r.connection, r.connector),
      resource: box,
      params: { q, max: Math.min(50, opts.max || 25) }
    })) as { emails?: EmailRowLike[]; nextCursor?: string | null };
    const emails = data.emails || [];
    const artifactData = {
      box,
      category: userQ ? undefined : category === 'all' ? undefined : category,
      account: r.connection.account_identifier,
      accountLabel: r.connection.account_label,
      connectionId: r.connection.id,
      query: opts.q || '',
      emails,
      nextCursor: data.nextCursor ?? null
    };
    const noun = box === 'unread' ? 'unread message' : 'message';
    const summary = emails.length
      ? `Loaded ${emails.length} ${noun}${emails.length === 1 ? '' : 's'} from ${r.connection.account_identifier}${opts.q ? ` matching "${opts.q}"` : ''}. An interactive email widget is shown — the user can search, open and reply from it. Briefly note the top senders/subjects; don't dump the whole list.`
      : `No ${noun}s${opts.q ? ` matching "${opts.q}"` : ''} in ${r.connection.account_identifier}.`;
    return {
      content: summary,
      artifacts: [{ type: box === 'unread' ? 'email_unread' : 'email_inbox', data: artifactData }],
      citations: emails
        .filter((e) => e.url)
        .slice(0, 10)
        .map((e) => ({ url: e.url as string, title: e.subject || undefined }))
    };
  } catch (err) {
    if (err instanceof ConnectorAuthError) return needsAuth('Gmail');
    return { content: `Gmail request failed: ${(err as Error)?.message || 'unknown error'}.`, notice: { level: 'warn', message: 'Gmail error' } };
  }
};

const makeGmailInbox = (ctx?: ToolContext): ChatTool => ({
  name: 'gmail_inbox',
  description:
    "Open the signed-in user's Gmail as an interactive INBOX widget — a large email terminal with a searchable message list, a reading pane, and per-message open/reply actions. Use for 'show/open my email', 'my inbox', 'go through my emails', 'check my mail'. Optional `query` pre-filters with Gmail operators (from:, subject:, has:attachment, newer_than:7d).",
  parameters: obj({
    query: { type: 'string', description: 'Optional Gmail search to pre-filter the inbox (e.g. "from:bob newer_than:7d"). Searches ALL mail.' },
    category: { type: 'string', enum: [...EMAIL_CATEGORIES], description: 'Which inbox category to show. Default "primary" (the relevant mail; hides promotions/social/updates). Use "promotions"/"social"/"updates"/"forums" or "all" when asked.' },
    max: { type: 'number', description: 'Messages to load (default 25, cap 50).' }
  }),
  execute: (args) => emailWidget(ctx, 'inbox', { q: String(args.query || ''), category: args.category as EmailCat, max: Number(args.max) || 25 })
});

const makeGmailUnread = (ctx?: ToolContext): ChatTool => ({
  name: 'gmail_unread',
  description:
    "Show the signed-in user's UNREAD Gmail as an interactive widget (an unread-only email terminal, Primary category by default). Use for 'unread emails', 'what's new in my inbox', 'do I have new mail', 'any new emails'.",
  parameters: obj({
    category: { type: 'string', enum: [...EMAIL_CATEGORIES], description: 'Inbox category (default "primary").' },
    max: { type: 'number', description: 'Messages to load (default 25, cap 50).' }
  }),
  execute: (args) => emailWidget(ctx, 'unread', { category: args.category as EmailCat, max: Number(args.max) || 25 })
});

const makeGmailCompose = (ctx?: ToolContext): ChatTool => ({
  name: 'gmail_compose',
  description:
    "Draft an email and show a COMPOSE widget the user can review and open in Gmail to send. The connection is read-only, so this prepares the draft + a one-click Gmail compose link — it does NOT send on the user's behalf. Use for 'write/draft an email to…', 'compose a message', 'draft a reply to…'. Write a complete, well-formed `body`.",
  parameters: obj(
    {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'The full email body to draft for the user.' },
      cc: { type: 'string', description: 'Optional cc address(es).' }
    },
    ['body']
  ),
  execute: async (args): Promise<ToolExecResult> => {
    const to = String(args.to || '');
    const cc = String(args.cc || '');
    const subject = String(args.subject || '');
    const body = String(args.body || '');
    let account: string | undefined;
    const r = await resolve(ctx, 'gmail', 'Gmail');
    if (!('fail' in r)) account = r.connection.account_identifier;
    return {
      content: `Prepared an email draft${to ? ` to ${to}` : ''}${subject ? ` — "${subject}"` : ''}. A compose widget is shown; the user can edit it and click “Open in Gmail” to send (the connection is read-only, so it isn't sent automatically).`,
      artifacts: [
        {
          type: 'email_compose',
          data: { to, cc, subject, body, account, gmailUrl: buildGmailComposeUrl({ to, cc, subject, body }), mailto: buildMailto({ to, cc, subject, body }) }
        }
      ]
    };
  }
});

const makeDriveSearch = (ctx?: ToolContext): ChatTool => ({
  name: 'drive_search',
  description:
    "Search the signed-in user's OWN Google Drive files by name and return matches (name, type, link, modified date). Use for 'my files', 'find my doc/sheet/slide', 'my Drive'.",
  parameters: obj({ query: { type: 'string', description: 'Text to match in file names.' } }, ['query']),
  execute: (args) => fetchAndFormat(ctx, 'google_drive', 'Google Drive', 'search', { q: String(args.query || '') }, String(args.query || ''))
});

// ---- Google Calendar (read agenda widget + confirmed writes) ----------------
// The agenda is an interactive widget (month/week/agenda views + click-to-detail).
// Writes (create/update/delete/RSVP) NEVER fire from the model — each returns a draft
// artifact the user reviews and confirms; the confirm button calls the scoped
// /connections/:id/mutate route. The draft carries the resolved connection so the
// widget knows whether write access is granted (and can prompt to reconnect if not).

interface CalEventView {
  id: string;
  title: string;
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
  responseStatus?: string | null;
  htmlLink?: string | null;
  attendees?: { email?: string; name?: string; responseStatus?: string; self?: boolean }[];
}

const calendarAgendaWidget = async (
  ctx: ToolContext | undefined,
  opts: { q?: string; days?: number }
): Promise<ToolExecResult> => {
  const r = await resolve(ctx, 'google_calendar', 'Calendar');
  if ('fail' in r) return r.fail;
  try {
    const data = (await r.connector.fetch({
      connection: toConnectionRef(r.connection),
      getAccessToken: () => getValidAccessToken(r.connection, r.connector),
      resource: 'agenda',
      params: { q: opts.q || '', days: opts.days || 14 }
    })) as { events?: CalEventView[]; timezone?: string | null; window?: { timeMin: string; timeMax: string } };
    const events = data.events || [];
    const canWrite = GoogleCalendarConnector.hasWriteScope(r.connection.granted_scopes);
    const tz = data.timezone || ctx?.timezone || undefined;
    const artifactData = {
      account: r.connection.account_identifier,
      accountLabel: r.connection.account_label,
      connectionId: r.connection.id,
      canWrite,
      timezone: tz || null,
      query: opts.q || '',
      window: data.window,
      events
    };
    // Give the MODEL the actual events (not just a count) so it can answer "what do I
    // have" — the widget shows the same detail visually. Times render in the user's tz.
    const fmtWhen = (ev: CalEventView): string => {
      if (!ev.start) return 'TBD';
      const d = new Date(ev.start);
      if (!Number.isFinite(d.getTime())) return 'TBD';
      const optsFmt: Intl.DateTimeFormatOptions = ev.allDay
        ? { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) }
        : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) };
      try { return d.toLocaleString('en-US', optsFmt); } catch { return d.toISOString(); }
    };
    const lines = events.slice(0, 25).map((e) => {
      const rsvp = e.responseStatus && e.responseStatus !== 'accepted' ? ` [${e.responseStatus}]` : '';
      const loc = e.location ? ` @ ${e.location}` : '';
      return `- ${fmtWhen(e)} — ${e.title}${loc}${rsvp} (id: ${e.id})`;
    });
    const summary = events.length
      ? `The user's calendar (${r.connection.account_identifier}) — ${events.length} event${events.length === 1 ? '' : 's'}${opts.q ? ` matching "${opts.q}"` : ''}. An interactive calendar widget is shown (agenda / week / month views; click an event for details${canWrite ? '; you can create/RSVP/edit from chat — those need the user to confirm a card' : ''}).\n\n${lines.join('\n')}\n\nAnswer the user's question from these events (next commitments, free time, conflicts). Reference events by their title/time, not the id.`
      : `No events${opts.q ? ` matching "${opts.q}"` : ''} in the next ${opts.days || 14} days on ${r.connection.account_identifier}. The user looks free in that window.`;
    return {
      content: summary,
      artifacts: [{ type: 'calendar_agenda', data: artifactData }],
      citations: events
        .filter((e) => (e as { htmlLink?: string }).htmlLink)
        .slice(0, 8)
        .map((e) => ({ url: (e as { htmlLink?: string }).htmlLink as string, title: e.title }))
    };
  } catch (err) {
    if (err instanceof ConnectorAuthError) return needsAuth('Calendar');
    return { content: `Calendar request failed: ${(err as Error)?.message || 'unknown error'}.`, notice: { level: 'warn', message: 'Calendar error' } };
  }
};

const makeCalendarAgenda = (ctx?: ToolContext): ChatTool => ({
  name: 'calendar_agenda',
  description:
    "Open the signed-in user's OWN Google Calendar as an interactive AGENDA widget (agenda/week/month views, click an event for details). Use for 'my schedule', 'what's on my calendar', 'my next meeting', 'am I free…', 'this week'. Optional `query` filters events; `days` sets the look-ahead window (default 14).",
  parameters: obj({
    query: { type: 'string', description: 'Optional free-text filter, e.g. "standup" or "with Alice".' },
    days: { type: 'number', description: 'Days ahead to include (default 14, max 90).' }
  }),
  execute: (args) => calendarAgendaWidget(ctx, { q: String(args.query || ''), days: Number(args.days) || 14 })
});

/** Build a calendar write-DRAFT artifact (the user confirms it; the model never writes). */
const calendarDraft = async (
  ctx: ToolContext | undefined,
  action: 'create' | 'update' | 'delete' | 'rsvp',
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<ToolExecResult> => {
  const r = await resolve(ctx, 'google_calendar', 'Calendar');
  const connected = !('fail' in r);
  const connection = connected ? r.connection : undefined;
  const canWrite = connection ? GoogleCalendarConnector.hasWriteScope(connection.granted_scopes) : false;
  const verb = action === 'create' ? 'create' : action === 'update' ? 'update' : action === 'delete' ? 'delete' : 'RSVP to';
  const title = typeof event.title === 'string' && event.title ? `"${event.title}"` : 'the event';
  const note = !connected
    ? ' (Calendar isn’t connected yet — the user can connect it in Connectors, then confirm.)'
    : !canWrite
      ? ' (This Calendar connection is read-only — the user needs to reconnect to grant edit access, then confirm.)'
      : '';
  return {
    content: `Prepared a request to ${verb} ${title}. A confirmation card is shown — nothing changes until the user clicks confirm.${note}`,
    artifacts: [
      {
        type: 'calendar_event_draft',
        data: {
          action,
          connectionId: connection?.id,
          account: connection?.account_identifier,
          canWrite,
          event,
          ...extra
        }
      }
    ]
  };
};

const makeCalendarCreateEvent = (ctx?: ToolContext): ChatTool => ({
  name: 'calendar_create_event',
  description:
    "Prepare a NEW event on the user's Google Calendar. Shows a confirmation card the user reviews and confirms — it does NOT create the event itself. Use for 'add/schedule/create … on my calendar', 'book a meeting', 'put X on my calendar'. Give ISO 8601 `start` (and `end`); set `allDay` for date-only events. Resolve relative dates ('tomorrow 3pm') to absolute ISO using the user's timezone.",
  parameters: obj(
    {
      title: { type: 'string', description: 'Event title / summary.' },
      start: { type: 'string', description: 'Start in ISO 8601 (e.g. 2026-06-16T15:00:00). For all-day, a date 2026-06-16.' },
      end: { type: 'string', description: 'End in ISO 8601. Optional — defaults to +1h (or same day for all-day).' },
      allDay: { type: 'boolean', description: 'True for an all-day event (use dates, not times).' },
      location: { type: 'string', description: 'Optional location.' },
      description: { type: 'string', description: 'Optional notes/agenda for the event body.' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Optional attendee email addresses to invite.' }
    },
    ['title', 'start']
  ),
  execute: (args) =>
    calendarDraft(ctx, 'create', {
      title: String(args.title || ''),
      start: String(args.start || ''),
      end: args.end ? String(args.end) : undefined,
      allDay: Boolean(args.allDay),
      location: args.location ? String(args.location) : undefined,
      description: args.description ? String(args.description) : undefined,
      attendees: Array.isArray(args.attendees) ? args.attendees.map(String) : undefined,
      timeZone: ctx?.timezone
    })
});

const makeCalendarUpdateEvent = (ctx?: ToolContext): ChatTool => ({
  name: 'calendar_update_event',
  description:
    "Prepare an EDIT to an existing calendar event (reschedule, rename, change location/notes/attendees). Shows a confirmation card; it does NOT edit until confirmed. Requires the `eventId` (from the agenda widget — call calendar_agenda first if you don't have it). Only include the fields that change.",
  parameters: obj(
    {
      eventId: { type: 'string', description: 'The id of the event to edit (from calendar_agenda).' },
      title: { type: 'string', description: 'New title (optional).' },
      start: { type: 'string', description: 'New start in ISO 8601 (optional).' },
      end: { type: 'string', description: 'New end in ISO 8601 (optional).' },
      allDay: { type: 'boolean', description: 'Set true if making it all-day.' },
      location: { type: 'string', description: 'New location (optional).' },
      description: { type: 'string', description: 'New description (optional).' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Replacement attendee email list (optional).' }
    },
    ['eventId']
  ),
  execute: (args) =>
    calendarDraft(ctx, 'update', {
      eventId: String(args.eventId || ''),
      title: args.title !== undefined ? String(args.title) : undefined,
      start: args.start ? String(args.start) : undefined,
      end: args.end ? String(args.end) : undefined,
      allDay: args.allDay !== undefined ? Boolean(args.allDay) : undefined,
      location: args.location !== undefined ? String(args.location) : undefined,
      description: args.description !== undefined ? String(args.description) : undefined,
      attendees: Array.isArray(args.attendees) ? args.attendees.map(String) : undefined,
      timeZone: ctx?.timezone
    })
});

const makeCalendarDeleteEvent = (ctx?: ToolContext): ChatTool => ({
  name: 'calendar_delete_event',
  description:
    "Prepare to DELETE/cancel an event from the user's calendar. Shows a confirmation card; it does NOT delete until confirmed. Requires the `eventId` (from calendar_agenda) — pass the event `title` too so the confirmation is clear.",
  parameters: obj(
    {
      eventId: { type: 'string', description: 'The id of the event to delete (from calendar_agenda).' },
      title: { type: 'string', description: 'The event title, for the confirmation card.' }
    },
    ['eventId']
  ),
  execute: (args) =>
    calendarDraft(ctx, 'delete', { eventId: String(args.eventId || ''), title: args.title ? String(args.title) : undefined })
});

const makeCalendarRsvp = (ctx?: ToolContext): ChatTool => ({
  name: 'calendar_rsvp',
  description:
    "Prepare an RSVP (accept / decline / tentative) to an event the user was invited to. Shows a confirmation card; it does NOT send the response until confirmed. Requires the `eventId` (from calendar_agenda).",
  parameters: obj(
    {
      eventId: { type: 'string', description: 'The id of the event to respond to (from calendar_agenda).' },
      response: { type: 'string', enum: ['accepted', 'declined', 'tentative'], description: 'The RSVP response.' },
      title: { type: 'string', description: 'The event title, for the confirmation card.' }
    },
    ['eventId', 'response']
  ),
  execute: (args) =>
    calendarDraft(
      ctx,
      'rsvp',
      { eventId: String(args.eventId || ''), title: args.title ? String(args.title) : undefined },
      { response: args.response === 'declined' ? 'declined' : args.response === 'tentative' ? 'tentative' : 'accepted' }
    )
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
  gmail_inbox: makeGmailInbox,
  gmail_unread: makeGmailUnread,
  gmail_compose: makeGmailCompose,
  drive_search: makeDriveSearch,
  calendar_agenda: makeCalendarAgenda,
  calendar_create_event: makeCalendarCreateEvent,
  calendar_update_event: makeCalendarUpdateEvent,
  calendar_delete_event: makeCalendarDeleteEvent,
  calendar_rsvp: makeCalendarRsvp,
  sheets_read: makeSheetsRead,
  maps_lookup: makeMapsLookup,
  connected_data_search: makeConnectedSearch
};

/** The connector tool names (registered as contextual tools in the registry). */
export const CONNECTOR_TOOL_NAMES = Object.keys(FACTORIES);

// connector_id (as stored on a user_connections row) → its PRIMARY tool name. Used to
// force-include the right tool when a user actually has that account linked, so the
// keyword router can't silently drop e.g. gmail_search just because the message didn't
// literally say "gmail"/"email". Kept beside FACTORIES so the two stay in sync.
const CONNECTOR_PRIMARY_TOOL: Record<string, string> = {
  gmail: 'gmail_search',
  google_drive: 'drive_search',
  google_calendar: 'calendar_agenda',
  google_sheets: 'sheets_read',
  google_maps: 'maps_lookup'
};

/**
 * Given the connector ids a user has linked, return the connector tool names to ALWAYS
 * offer the model this turn: each linked connector's primary tool, plus the unified
 * `connected_data_search` whenever the user has at least one linked account.
 */
export const primaryConnectorToolNames = (connectorIds: string[]): string[] => {
  const names = new Set<string>();
  for (const id of connectorIds) {
    const tool = CONNECTOR_PRIMARY_TOOL[id];
    if (tool) names.add(tool);
  }
  if (names.size) names.add('connected_data_search');
  return Array.from(names);
};

/** Build a connector tool by name with the per-request context, or null if unknown. */
export const buildConnectorTool = (name: string, ctx?: ToolContext): ChatTool | null => {
  const factory = FACTORIES[name];
  return factory ? factory(ctx) : null;
};
