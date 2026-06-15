import React, { useState } from 'react';
import { CalendarPlus, Pencil, Trash2, Check, Loader2, MapPin, Users, Clock, ExternalLink, AlertTriangle, CalendarCheck } from 'lucide-react';
import type { CalendarEventDraftArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle } from './kit';
import { mutateEvent, type CalendarAction, type MutateResult } from '../../../services/calendarApi';

// The confirmation card a calendar WRITE tool emits. The model prepared an action;
// nothing changes until the user clicks confirm here, which calls the scoped mutate
// route. Honest states for not-connected / read-only / done so it never silently no-ops.

const ACTION_META: Record<CalendarAction, { label: string; verb: string; Icon: React.FC<{ className?: string }>; danger?: boolean }> = {
  create: { label: 'Create event', verb: 'Create', Icon: CalendarPlus },
  update: { label: 'Edit event', verb: 'Save changes', Icon: Pencil },
  delete: { label: 'Delete event', verb: 'Delete', Icon: Trash2, danger: true },
  rsvp: { label: 'RSVP', verb: 'Send RSVP', Icon: CalendarCheck }
};

const fmtWhen = (start?: string, end?: string, allDay?: boolean): string => {
  if (!start) return '';
  const s = new Date(start);
  if (!Number.isFinite(s.getTime())) return start;
  if (allDay) return s.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  const datePart = s.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric' });
  const startT = s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const e = end ? new Date(end) : null;
  const endT = e && Number.isFinite(e.getTime()) ? e.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  return `${datePart} · ${startT}${endT ? ` – ${endT}` : ''}`;
};

type RowStatus = 'idle' | 'busy' | 'done' | 'error';

// BATCH create: one card listing several events with an "Add all" action. Each row gets
// its own live status as they're created sequentially; rows can be removed before adding.
const BatchEventDraft: React.FC<{ data: CalendarEventDraftArtifact }> = ({ data }) => {
  const [events, setEvents] = useState(() => (data.events || []).filter((e) => e && e.title));
  const [statuses, setStatuses] = useState<RowStatus[]>(() => (data.events || []).filter((e) => e && e.title).map(() => 'idle'));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const blocked = !data.connectionId ? 'not_connected' : !data.canWrite ? 'read_only' : null;
  const doneCount = statuses.filter((s) => s === 'done').length;
  const failCount = statuses.filter((s) => s === 'error').length;
  const allSettled = events.length > 0 && statuses.every((s) => s === 'done' || s === 'error');

  const addAll = async () => {
    if (!data.connectionId || blocked || running) return;
    setRunning(true); setError(undefined);
    for (let i = 0; i < events.length; i++) {
      if (statuses[i] === 'done') continue;
      setStatuses((s) => s.map((v, j) => (j === i ? 'busy' : v)));
      try {
        const e = events[i];
        await mutateEvent(data.connectionId, 'create', {
          title: e.title,
          ...(e.start ? { start: e.start } : {}),
          ...(e.end ? { end: e.end } : {}),
          ...(e.allDay !== undefined ? { allDay: e.allDay } : {}),
          ...(e.location ? { location: e.location } : {}),
          ...(e.description ? { description: e.description } : {}),
          ...(e.attendees ? { attendees: e.attendees } : {}),
          ...(e.timeZone ? { timeZone: e.timeZone } : {})
        });
        setStatuses((s) => s.map((v, j) => (j === i ? 'done' : v)));
      } catch (err) {
        setStatuses((s) => s.map((v, j) => (j === i ? 'error' : v)));
        setError((err as Error)?.message || 'Some events couldn’t be added.');
      }
    }
    setRunning(false);
  };

  const removeRow = (i: number) => {
    if (running) return;
    setEvents((list) => list.filter((_, j) => j !== i));
    setStatuses((s) => s.filter((_, j) => j !== i));
  };

  const header = (
    <>
      <SurfaceTitle>Add {events.length} event{events.length === 1 ? '' : 's'}</SurfaceTitle>
      <SurfaceSubtitle>{data.account || 'Google Calendar'}{allSettled ? ` · ${doneCount} added${failCount ? `, ${failCount} failed` : ''}` : ''}</SurfaceSubtitle>
    </>
  );

  const rowIcon = (s: RowStatus) =>
    s === 'busy' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ds-accent)]" />
      : s === 'done' ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        : s === 'error' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
          : <CalendarPlus className="h-3.5 w-3.5 shrink-0 text-[var(--ds-faint)]" />;

  if (!events.length) {
    return (
      <Surface header={header} accent="#10b981">
        <div className="px-3.5 py-4 text-[13px] text-[var(--ds-muted)]">{doneCount ? `Added ${doneCount} event${doneCount === 1 ? '' : 's'} to your calendar.` : 'Nothing to add.'}</div>
      </Surface>
    );
  }

  return (
    <Surface header={header} accent={allSettled && !failCount ? '#10b981' : 'var(--ds-accent)'}>
      <div className="space-y-2.5 px-3.5 py-3">
        <ul className="max-h-72 space-y-1 overflow-y-auto [scrollbar-width:thin]">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2 rounded-lg border border-[var(--ds-hairline-soft)] px-2.5 py-1.5">
              <span className="mt-0.5">{rowIcon(statuses[i])}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--ds-ink)]">{e.title}</p>
                <p className="truncate text-[11px] tabular-nums text-[var(--ds-muted)]">{fmtWhen(e.start, e.end, e.allDay)}{e.location ? ` · ${e.location}` : ''}</p>
              </div>
              {!running && statuses[i] === 'idle' && (
                <button onClick={() => removeRow(i)} aria-label="Remove" className="shrink-0 rounded-md p-1 text-[var(--ds-faint)] hover:bg-[var(--ds-hover)] hover:text-rose-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {blocked === 'not_connected' && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-2 text-[12px] text-[var(--ds-muted)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" /><span>Connect Google Calendar in <span className="font-medium text-[var(--ds-ink)]">Settings → Connectors</span>, then ask again.</span>
          </div>
        )}
        {blocked === 'read_only' && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-2 text-[12px] text-[var(--ds-muted)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" /><span>This calendar is <span className="font-medium text-[var(--ds-ink)]">read-only</span>. Reconnect in Connectors to grant edit access.</span>
          </div>
        )}
        {error && <p className="text-[12px] text-rose-600">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-hairline-soft)] pt-2.5">
          {allSettled ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-600"><Check className="h-4 w-4" /> Added {doneCount} of {events.length}</span>
          ) : (
            <button
              onClick={addAll}
              disabled={running || !!blocked}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
              {running ? `Adding ${doneCount}/${events.length}…` : `Add all ${events.length}`}
            </button>
          )}
        </div>
      </div>
    </Surface>
  );
};

export const CalendarEventDraft: React.FC<{ data: CalendarEventDraftArtifact }> = ({ data }) => {
  // Batch create (an itinerary / multiple parsed events) → the "Add all" card.
  if (data.action === 'create' && Array.isArray(data.events) && data.events.length > 1) {
    return <BatchEventDraft data={data} />;
  }
  const meta = ACTION_META[data.action] || ACTION_META.create;
  const { Icon } = meta;
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<MutateResult | undefined>();

  const ev = data.event || {};
  const blocked = !data.connectionId ? 'not_connected' : !data.canWrite ? 'read_only' : null;

  const confirm = async () => {
    if (!data.connectionId || blocked) return;
    setStatus('busy'); setError(undefined);
    try {
      const params: Record<string, unknown> =
        data.action === 'rsvp'
          ? { eventId: ev.eventId, response: data.response || 'accepted' }
          : data.action === 'delete'
            ? { eventId: ev.eventId }
            : {
                ...(ev.eventId ? { eventId: ev.eventId } : {}),
                ...(ev.title !== undefined ? { title: ev.title } : {}),
                ...(ev.start ? { start: ev.start } : {}),
                ...(ev.end ? { end: ev.end } : {}),
                ...(ev.allDay !== undefined ? { allDay: ev.allDay } : {}),
                ...(ev.location !== undefined ? { location: ev.location } : {}),
                ...(ev.description !== undefined ? { description: ev.description } : {}),
                ...(ev.attendees ? { attendees: ev.attendees } : {}),
                ...(ev.timeZone ? { timeZone: ev.timeZone } : {})
              };
      const res = await mutateEvent(data.connectionId, data.action, params);
      setResult(res);
      setStatus('done');
    } catch (e) {
      setError((e as Error)?.message || 'That didn’t go through.');
      setStatus('error');
    }
  };

  const accent = meta.danger ? '#e11d48' : 'var(--ds-accent)';
  const header = (
    <>
      <SurfaceTitle>{meta.label}</SurfaceTitle>
      <SurfaceSubtitle>{data.account ? data.account : 'Google Calendar'}{data.response ? ` · responding "${data.response}"` : ''}</SurfaceSubtitle>
    </>
  );

  if (status === 'done') {
    const link = result?.event?.htmlLink;
    const doneMsg = data.action === 'delete' ? 'Event deleted.' : data.action === 'rsvp' ? `RSVP sent (${data.response || 'accepted'}).` : data.action === 'update' ? 'Event updated.' : 'Event added to your calendar.';
    return (
      <Surface header={header} accent="#10b981">
        <div className="flex items-center gap-2.5 px-3.5 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600"><Check className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--ds-ink)]">{doneMsg}</p>
            {ev.title && <p className="truncate text-[12px] text-[var(--ds-muted)]">{ev.title}</p>}
          </div>
          {link && <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--ds-accent)] hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Open</a>}
        </div>
      </Surface>
    );
  }

  return (
    <Surface header={header} accent={accent}>
      <div className="space-y-3 px-3.5 py-3">
        {/* Event summary */}
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#D97757]/10 text-[var(--ds-accent)]"><Icon className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1 space-y-1">
            {ev.title ? <p className="break-words text-[14px] font-semibold text-[var(--ds-ink)]">{ev.title}</p> : <p className="text-[13px] italic text-[var(--ds-muted)]">(this event)</p>}
            {ev.start && (
              <p className="flex items-center gap-1.5 text-[12px] tabular-nums text-[var(--ds-muted)]"><Clock className="h-3.5 w-3.5" />{fmtWhen(ev.start, ev.end, ev.allDay)}</p>
            )}
            {ev.location && <p className="flex items-center gap-1.5 text-[12px] text-[var(--ds-muted)]"><MapPin className="h-3.5 w-3.5" />{ev.location}</p>}
            {!!(ev.attendees && ev.attendees.length) && (
              <p className="flex items-center gap-1.5 text-[12px] text-[var(--ds-muted)]"><Users className="h-3.5 w-3.5" />{ev.attendees.join(', ')}</p>
            )}
            {ev.description && <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--ds-muted)]">{ev.description.slice(0, 300)}</p>}
          </div>
        </div>

        {/* Honest blocked states */}
        {blocked === 'not_connected' && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-2 text-[12px] text-[var(--ds-muted)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>Connect Google Calendar in <span className="font-medium text-[var(--ds-ink)]">Settings → Connectors</span> to use this, then ask again.</span>
          </div>
        )}
        {blocked === 'read_only' && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-2 text-[12px] text-[var(--ds-muted)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>This calendar is connected <span className="font-medium text-[var(--ds-ink)]">read-only</span>. Reconnect it in Connectors to grant edit access.</span>
          </div>
        )}
        {error && <p className="text-[12px] text-rose-600">{error}</p>}

        {/* Confirm */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-hairline-soft)] pt-2.5">
          <button
            onClick={confirm}
            disabled={status === 'busy' || !!blocked}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors disabled:opacity-50 ${meta.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-[var(--ds-accent)] hover:bg-[var(--ds-accent-hover)]'}`}
          >
            {status === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
            {meta.verb}
          </button>
        </div>
      </div>
    </Surface>
  );
};
