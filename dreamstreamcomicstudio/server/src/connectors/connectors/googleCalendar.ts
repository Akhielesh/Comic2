// ============================================================================
// Google Calendar connector (per-user OAuth) — read + write
// ============================================================================
// Events + free/busy → normalized `event` items for sync/RAG. On-demand `fetch`
// powers the live agenda widget (rich event views in a time window), and `mutate`
// lets the user act on their calendar (create / update / delete / RSVP) — always
// behind an explicit in-product confirmation, never silently from a model turn.
//
// Full sync captures a nextSyncToken so incremental sync is a true delta
// (re-baselines on 410 GONE). Scope: calendar.events (read + write to events;
// not full calendar administration — least privilege for what we expose).
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import { googleApiFetch } from '../googleClient.js';
import { CONNECTORS_SYNC_PAGE_SIZE } from '../../config.js';
import type { ConnectorMetadata, FetchInput, MutateInput, NormalizedItem, SyncContext, SyncResult } from '../types.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface CalEventTime { date?: string; dateTime?: string; timeZone?: string }
interface CalAttendee { email?: string; displayName?: string; responseStatus?: string; self?: boolean; organizer?: boolean; optional?: boolean }
interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  colorId?: string;
  recurringEventId?: string;
  start?: CalEventTime;
  end?: CalEventTime;
  attendees?: CalAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
}
interface CalList {
  items?: CalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
  timeZone?: string;
}

/** The rich event shape the agenda widget renders (mirrors apiTypes CalendarEventView). */
export interface CalendarEventView {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO 8601 start/end. */
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  status?: string | null;
  htmlLink?: string | null;
  /** Google Meet / video link, when the event has one. */
  hangoutLink?: string | null;
  organizer?: { email?: string; name?: string } | null;
  attendees?: { email?: string; name?: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
  /** The signed-in user's own RSVP for this event ('accepted'|'declined'|'tentative'|'needsAction'). */
  responseStatus?: string | null;
  colorId?: string | null;
  recurring?: boolean;
}

const whenOf = (t?: CalEventTime): string | null => t?.dateTime || (t?.date ? new Date(t.date).toISOString() : null);

/** Map a raw Calendar event to the rich view shape the widget renders. */
const toView = (e: CalEvent): CalendarEventView => {
  const self = e.attendees?.find((a) => a.self);
  return {
    id: e.id,
    title: e.summary || '(busy)',
    description: e.description || null,
    location: e.location || null,
    start: whenOf(e.start),
    end: whenOf(e.end),
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    status: e.status || null,
    htmlLink: e.htmlLink || null,
    hangoutLink: e.hangoutLink || null,
    organizer: e.organizer ? { email: e.organizer.email, name: e.organizer.displayName } : null,
    attendees: (e.attendees || []).map((a) => ({
      email: a.email,
      name: a.displayName,
      responseStatus: a.responseStatus,
      self: a.self,
      organizer: a.organizer
    })),
    responseStatus: self?.responseStatus || (e.organizer?.self ? 'accepted' : null),
    colorId: e.colorId || null,
    recurring: Boolean(e.recurringEventId)
  };
};

/** Build a Calendar API time object from an ISO string (`allDay` → date, else dateTime). */
const toCalTime = (iso: string, allDay?: boolean, timeZone?: string): CalEventTime => {
  if (allDay) return { date: iso.slice(0, 10) };
  return { dateTime: new Date(iso).toISOString(), ...(timeZone ? { timeZone } : {}) };
};

/** The day after a YYYY-MM-DD date (Google all-day `end.date` is EXCLUSIVE). */
const nextDay = (dateStr: string): string => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class GoogleCalendarConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'google_calendar',
    displayName: 'Google Calendar',
    description: 'Your calendar events and free/busy — read your agenda and create, edit, RSVP to or delete events from chat, agents and dashboards.',
    icon: 'Calendar',
    category: 'google_workspace',
    authType: 'user_oauth',
    providerGroup: 'google',
    // calendar.events = read + write to events (lets the user act on their schedule).
    // userinfo.* identify the connected account. (Was calendar.events.readonly — write
    // needs the broader scope, so reconnecting re-consents to it.)
    requiredScopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    capabilities: { searchable: true, syncable: true, realtime: true, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/calendar/api'
  };

  /** A connection can write only when it granted a non-readonly calendar scope. */
  static hasWriteScope(grantedScopes: string[]): boolean {
    return (grantedScopes || []).some((s) => /\/auth\/calendar(\.events)?$/.test(s));
  }

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
    const p = input.params;
    if (input.resource === 'search') {
      const res = await this.list(
        token,
        { q: str(p.q || p.query), orderBy: 'startTime', timeMin: new Date().toISOString() },
        input.signal
      );
      return { items: (res.items || []).flatMap((e) => this.normalize(e)) };
    }
    // Rich agenda for the live widget: events in a [timeMin, timeMax] window as views.
    if (input.resource === 'agenda') {
      const now = Date.now();
      const days = Number(p.days) > 0 ? Math.min(90, Number(p.days)) : 14;
      const timeMin = str(p.timeMin) || new Date(now - 6 * 3600_000).toISOString();
      const timeMax = str(p.timeMax) || new Date(now + days * 24 * 3600_000).toISOString();
      const q = str(p.q || p.query);
      const res = await this.list(
        token,
        { orderBy: 'startTime', timeMin, timeMax, maxResults: Number(p.max) > 0 ? Math.min(50, Number(p.max)) : 25, ...(q ? { q } : {}) },
        input.signal
      );
      const events = (res.items || [])
        .filter((e) => e && e.id && e.status !== 'cancelled')
        .map(toView);
      return { events, timezone: res.timeZone || null, window: { timeMin, timeMax } };
    }
    throw new Error(`Unsupported Calendar resource: ${input.resource}`);
  }

  // ---- Writes (create / update / delete / RSVP) -----------------------------
  // Every call here is the result of an explicit user confirmation in the UI; the
  // route additionally enforces that the connection granted a write scope.
  async mutate(input: MutateInput): Promise<unknown> {
    const token = await input.getAccessToken();
    const p = input.params;
    const action = input.action;

    if (action === 'create' || action === 'update') {
      const body: Record<string, unknown> = {};
      if (typeof p.title === 'string') body.summary = p.title;
      if (typeof p.description === 'string') body.description = p.description;
      if (typeof p.location === 'string') body.location = p.location;
      const allDay = Boolean(p.allDay);
      const tz = str(p.timeZone) || undefined;
      if (typeof p.start === 'string' && p.start) body.start = toCalTime(p.start, allDay, tz);
      if (typeof p.end === 'string' && p.end) body.end = toCalTime(p.end, allDay, tz);
      else if (typeof p.start === 'string' && p.start && !p.end) {
        // No end given → default a 1-hour timed block (or the same all-day day).
        body.end = allDay ? toCalTime(p.start, true) : toCalTime(new Date(new Date(p.start).getTime() + 3600_000).toISOString(), false, tz);
      }
      // Google all-day events use an EXCLUSIVE end date — bump end to at least start+1 day.
      const bStart = body.start as CalEventTime | undefined;
      const bEnd = body.end as CalEventTime | undefined;
      if (allDay && bStart?.date && bEnd?.date && bEnd.date <= bStart.date) {
        body.end = { date: nextDay(bStart.date) };
      }
      if (Array.isArray(p.attendees) && p.attendees.length) {
        body.attendees = (p.attendees as unknown[])
          .map((a) => (typeof a === 'string' ? a.trim() : ''))
          .filter(Boolean)
          .map((email) => ({ email }));
      }
      if (action === 'create') {
        const created = await googleApiFetch<CalEvent>(CAL_BASE, {
          accessToken: token,
          method: 'POST',
          query: { sendUpdates: 'all' },
          body,
          signal: input.signal
        });
        return { event: toView(created), action: 'create' };
      }
      const id = str(p.eventId || p.id);
      if (!id) throw new Error('update requires an eventId');
      const updated = await googleApiFetch<CalEvent>(`${CAL_BASE}/${encodeURIComponent(id)}`, {
        accessToken: token,
        method: 'PATCH',
        query: { sendUpdates: 'all' },
        body,
        signal: input.signal
      });
      return { event: toView(updated), action: 'update' };
    }

    if (action === 'delete') {
      const id = str(p.eventId || p.id);
      if (!id) throw new Error('delete requires an eventId');
      await googleApiFetch(`${CAL_BASE}/${encodeURIComponent(id)}`, {
        accessToken: token,
        method: 'DELETE',
        query: { sendUpdates: 'all' },
        signal: input.signal
      });
      return { action: 'delete', eventId: id };
    }

    if (action === 'rsvp') {
      const id = str(p.eventId || p.id);
      if (!id) throw new Error('rsvp requires an eventId');
      const response = str(p.response) || 'accepted'; // accepted | declined | tentative
      // Read → update the SELF attendee's responseStatus → patch the attendee list back,
      // so we don't clobber the other guests (Calendar replaces, not merges, attendees).
      const event = await googleApiFetch<CalEvent>(`${CAL_BASE}/${encodeURIComponent(id)}`, { accessToken: token, signal: input.signal });
      const selfEmail = (input.connection.accountIdentifier || '').toLowerCase();
      const attendees = (event.attendees || []).map((a) =>
        a.self || (a.email || '').toLowerCase() === selfEmail ? { ...a, responseStatus: response } : a
      );
      if (!attendees.some((a) => a.self || (a.email || '').toLowerCase() === selfEmail)) {
        // Not yet on the guest list (e.g. the organizer) — add self so the RSVP takes.
        attendees.push({ email: selfEmail, responseStatus: response, self: true });
      }
      const updated = await googleApiFetch<CalEvent>(`${CAL_BASE}/${encodeURIComponent(id)}`, {
        accessToken: token,
        method: 'PATCH',
        query: { sendUpdates: 'all' },
        body: { attendees },
        signal: input.signal
      });
      return { event: toView(updated), action: 'rsvp', response };
    }

    throw new Error(`Unsupported Calendar action: ${action}`);
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
