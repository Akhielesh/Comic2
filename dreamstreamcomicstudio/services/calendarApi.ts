// Client API for the Chat Studio calendar widgets. Thin wrappers over the authenticated
// connectors endpoints (scoped server-side to the signed-in owner of the connection):
//   * READ  → POST /api/connectors/connections/:id/fetch  { resource:'agenda', params }
//   * WRITE → POST /api/connectors/connections/:id/mutate { action, params }
// The agenda widget self-fetches its window without a model round-trip; the write path
// is only ever called from an explicit user "confirm" in the draft card.

import { post } from './apiClient';
import type { CalendarEventView } from '../apiTypes';

interface Envelope<T> {
  ok: boolean;
  data: T;
}

export interface AgendaResult {
  events: CalendarEventView[];
  timezone: string | null;
  window?: { timeMin: string; timeMax: string };
}

/** Fetch the agenda for a window (default: server picks ~14 days ahead). */
export const fetchAgenda = (
  connectionId: string,
  opts: { q?: string; days?: number; timeMin?: string; timeMax?: string } = {}
): Promise<AgendaResult> =>
  post<{ resource: string; params: Record<string, unknown> }, Envelope<AgendaResult>>(
    `/api/connectors/connections/${encodeURIComponent(connectionId)}/fetch`,
    {
      resource: 'agenda',
      params: {
        ...(opts.q ? { q: opts.q } : {}),
        ...(opts.days ? { days: opts.days } : {}),
        ...(opts.timeMin ? { timeMin: opts.timeMin } : {}),
        ...(opts.timeMax ? { timeMax: opts.timeMax } : {})
      }
    }
  ).then((r) => r.data);

export type CalendarAction = 'create' | 'update' | 'delete' | 'rsvp';

export interface MutateResult {
  action: CalendarAction;
  event?: CalendarEventView;
  eventId?: string;
  response?: string;
}

/** Apply a confirmed calendar write (create/update/delete/RSVP). */
export const mutateEvent = (
  connectionId: string,
  action: CalendarAction,
  params: Record<string, unknown>
): Promise<MutateResult> =>
  post<{ action: CalendarAction; params: Record<string, unknown> }, Envelope<MutateResult>>(
    `/api/connectors/connections/${encodeURIComponent(connectionId)}/mutate`,
    { action, params }
  ).then((r) => r.data);
