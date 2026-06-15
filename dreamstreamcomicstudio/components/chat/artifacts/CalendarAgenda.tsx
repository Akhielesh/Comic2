import React, { useCallback, useMemo, useState } from 'react';
import {
  CalendarPlus, ChevronLeft, ChevronRight, Clock, ExternalLink, MapPin, Pencil, Trash2, Users, Video, Loader2, Check
} from 'lucide-react';
import type { CalendarAgendaArtifact, CalendarEventView } from '../../../apiTypes';
import {
  Surface, SurfaceTitle, SurfaceSubtitle, Badge, useCompact, DetailPopover, anchorFromEvent,
  type PopoverAnchor, BULL, BEAR, NEUTRAL, withAlpha
} from './kit';
import { fetchAgenda, mutateEvent, type CalendarAction } from '../../../services/calendarApi';

// The connected Google Calendar, as a calm-studio widget.
//  • detailed — Agenda / Week / Month views with a click-to-detail popover per event;
//    when the connection has write access you can create, edit, RSVP and delete inline
//    (each calls the scoped mutate route — the same confirmed path the chat draft uses).
//  • compact — the next three upcoming events as glance rows.

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const startOfDay = (t: number): number => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const ms = (iso?: string | null): number => (iso ? new Date(iso).getTime() : NaN);
const localTz = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
};

const dayLabel = (t: number, now: number): string => {
  const diff = Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const timeLabel = (ev: CalendarEventView): string => {
  if (ev.allDay) return 'All day';
  const s = ms(ev.start);
  if (!Number.isFinite(s)) return '';
  const start = new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const e = ms(ev.end);
  if (!Number.isFinite(e)) return start;
  const end = new Date(e).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${start} – ${end}`;
};

// Google calendarColorId → a tasteful hex; default to the brand accent.
const COLOR_BY_ID: Record<string, string> = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73', '5': '#f6bf26',
  '6': '#f4511e', '7': '#039be5', '8': '#616161', '9': '#3f51b5', '10': '#0b8043', '11': '#d50000'
};
const eventColor = (ev: CalendarEventView): string => (ev.colorId && COLOR_BY_ID[ev.colorId]) || 'var(--ds-accent)';

const RSVP_TINT: Record<string, string> = { accepted: BULL, declined: BEAR, tentative: '#f59e0b' };
const rsvpLabel: Record<string, string> = { accepted: 'Going', declined: 'Declined', tentative: 'Maybe', needsAction: 'Invited' };

type View = 'agenda' | 'week' | 'month';

type Popover =
  | { kind: 'event'; anchor: PopoverAnchor; event: CalendarEventView }
  | { kind: 'day'; anchor: PopoverAnchor; date: number }
  | { kind: 'create'; anchor: PopoverAnchor }
  | { kind: 'edit'; anchor: PopoverAnchor; event: CalendarEventView }
  | null;

const sortByStart = (a: CalendarEventView, b: CalendarEventView): number => (ms(a.start) || 0) - (ms(b.start) || 0);

// ---------------------------------------------------------------- Event form --
// One compact form drives both "create" and "edit" (seeded from an event).
interface FormProps {
  initial?: CalendarEventView;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (params: Record<string, unknown>) => void;
}
const toDateInput = (iso?: string | null): string => {
  const t = ms(iso);
  if (!Number.isFinite(t)) return new Date().toISOString().slice(0, 10);
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const toTimeInput = (iso?: string | null, fallbackHour = 9): string => {
  const t = ms(iso);
  const d = Number.isFinite(t) ? new Date(t) : (() => { const x = new Date(); x.setHours(fallbackHour, 0, 0, 0); return x; })();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const EventForm: React.FC<FormProps> = ({ initial, busy, error, onCancel, onSubmit }) => {
  const nextHour = useMemo(() => { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d; }, []);
  const [title, setTitle] = useState(initial?.title && initial.title !== '(busy)' ? initial.title : '');
  const [allDay, setAllDay] = useState(Boolean(initial?.allDay));
  const [date, setDate] = useState(toDateInput(initial?.start ?? nextHour.toISOString()));
  const [start, setStart] = useState(toTimeInput(initial?.start ?? nextHour.toISOString(), nextHour.getHours()));
  const [end, setEnd] = useState(toTimeInput(initial?.end ?? new Date(nextHour.getTime() + DAY_MS / 24).toISOString(), nextHour.getHours() + 1));
  const [location, setLocation] = useState(initial?.location ?? '');
  const [attendees, setAttendees] = useState((initial?.attendees || []).map((a) => a.email).filter(Boolean).join(', '));

  const submit = () => {
    if (!title.trim()) return;
    const tz = localTz();
    const startIso = allDay ? date : `${date}T${start}:00`;
    const endIso = allDay ? date : `${date}T${end}:00`;
    onSubmit({
      title: title.trim(),
      start: startIso,
      end: endIso,
      allDay,
      location: location.trim() || undefined,
      attendees: attendees.split(',').map((s) => s.trim()).filter(Boolean),
      timeZone: tz
    });
  };

  const inputCls = 'w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-2.5 py-1.5 text-[13px] text-[var(--ds-ink)] outline-none focus:border-[var(--ds-accent)]';
  return (
    <div className="w-[20rem] max-w-full space-y-2.5">
      <input className={inputCls} placeholder="Event title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
      <label className="flex items-center gap-2 text-[12px] text-[var(--ds-muted)]">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[var(--ds-accent)]" />
        All-day
      </label>
      <div className="flex gap-2">
        <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        {!allDay && (
          <>
            <input type="time" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
            <input type="time" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} />
          </>
        )}
      </div>
      <input className={inputCls} placeholder="Location (optional)" value={location} onChange={(e) => setLocation(e.target.value)} />
      <input className={inputCls} placeholder="Guests — emails, comma-separated (optional)" value={attendees} onChange={(e) => setAttendees(e.target.value)} />
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button onClick={onCancel} className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">Cancel</button>
        <button
          onClick={submit}
          disabled={busy || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {initial ? 'Save changes' : 'Create event'}
        </button>
      </div>
    </div>
  );
};

// --------------------------------------------------------------- Event detail --
const Detail: React.FC<{
  event: CalendarEventView;
  now: number;
  canWrite: boolean;
  busy: boolean;
  error?: string;
  onEdit: () => void;
  onDelete: () => void;
  onRsvp: (r: 'accepted' | 'declined' | 'tentative') => void;
}> = ({ event, now, canWrite, busy, error, onEdit, onDelete, onRsvp }) => {
  const invited = (event.attendees || []).some((a) => a.self) || Boolean(event.responseStatus && event.responseStatus !== 'accepted');
  const isPast = Number.isFinite(ms(event.end)) ? ms(event.end) < now : ms(event.start) < now;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 text-[12px] text-[var(--ds-muted)]">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        <span className="tabular-nums">{dayLabel(ms(event.start) || now, now)} · {timeLabel(event)}</span>
      </div>
      {event.location && (
        <div className="flex items-start gap-1.5 text-[12px] text-[var(--ds-ink)]">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
          <span className="break-words">{event.location}</span>
        </div>
      )}
      {event.hangoutLink && (
        <a href={event.hangoutLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#D97757]/10 px-2.5 py-1.5 text-[12px] font-medium text-[var(--ds-accent)] hover:bg-[#D97757]/20">
          <Video className="h-3.5 w-3.5" /> Join video call
        </a>
      )}
      {event.description && <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--ds-muted)]">{event.description.slice(0, 600)}</p>}
      {!!(event.attendees && event.attendees.length) && (
        <div className="flex items-start gap-1.5 text-[12px] text-[var(--ds-muted)]">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{event.attendees.length} guest{event.attendees.length === 1 ? '' : 's'}{event.organizer?.name ? ` · ${event.organizer.name}` : ''}</span>
        </div>
      )}
      {error && <p className="text-[11px] text-rose-600">{error}</p>}

      {canWrite && invited && !isPast && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {(['accepted', 'tentative', 'declined'] as const).map((r) => {
            const active = event.responseStatus === r;
            return (
              <button
                key={r}
                disabled={busy}
                onClick={() => onRsvp(r)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50 ${active ? 'border-transparent text-white' : 'border-[var(--ds-hairline)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]'}`}
                style={active ? { backgroundColor: RSVP_TINT[r] } : undefined}
              >
                {r === 'accepted' ? 'Yes' : r === 'tentative' ? 'Maybe' : 'No'}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-[var(--ds-hairline-soft)] pt-2.5">
        {event.htmlLink ? (
          <a href={event.htmlLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ds-accent)] hover:underline">
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </a>
        ) : <span />}
        {canWrite && (
          <div className="flex items-center gap-1">
            <button disabled={busy} onClick={onEdit} title="Edit" className="rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /></button>
            <button disabled={busy} onClick={onDelete} title="Delete" className="rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-rose-600 disabled:opacity-50">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</button>
          </div>
        )}
      </div>
    </div>
  );
};

// --------------------------------------------------------------------- Widget --
export const CalendarAgenda: React.FC<{ data: CalendarAgendaArtifact; initialView?: View }> = ({ data, initialView }) => {
  const compact = useCompact();
  const now = Date.now();
  const [view, setView] = useState<View>(initialView ?? 'agenda');
  const [events, setEvents] = useState<CalendarEventView[]>((data.events || []).filter((e) => e?.id).slice().sort(sortByStart));
  const [popover, setPopover] = useState<Popover>(null);
  const [cursor, setCursor] = useState<number>(now); // month/week navigation anchor
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [flash, setFlash] = useState<string | undefined>();

  const canWrite = Boolean(data.canWrite && data.connectionId);

  const reload = useCallback(async () => {
    if (!data.connectionId) return;
    try {
      const r = await fetchAgenda(data.connectionId, {
        ...(data.window?.timeMin ? { timeMin: data.window.timeMin } : {}),
        ...(data.window?.timeMax ? { timeMax: data.window.timeMax } : { days: 45 })
      });
      setEvents((r.events || []).filter((e) => e?.id).slice().sort(sortByStart));
    } catch { /* keep the last good list */ }
  }, [data.connectionId, data.window?.timeMin, data.window?.timeMax]);

  const runWrite = useCallback(async (action: CalendarAction, params: Record<string, unknown>, okMsg: string) => {
    if (!data.connectionId) { setError('Calendar isn’t connected.'); return; }
    setBusy(true); setError(undefined);
    try {
      await mutateEvent(data.connectionId, action, params);
      await reload();
      setPopover(null);
      setFlash(okMsg);
      window.setTimeout(() => setFlash(undefined), 2400);
    } catch (e) {
      setError((e as Error)?.message || 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  }, [data.connectionId, reload]);

  const openEvent = (e: React.MouseEvent, event: CalendarEventView) => setPopover({ kind: 'event', anchor: anchorFromEvent(e.currentTarget as HTMLElement), event });

  const title = data.accountLabel || data.account || 'Calendar';
  const headerRight = (
    <div className="flex items-center gap-1.5">
      {flash && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600"><Check className="h-3 w-3" />{flash}</span>}
      {canWrite && !compact && (
        <button
          onClick={(e) => setPopover({ kind: 'create', anchor: anchorFromEvent(e.currentTarget as HTMLElement) })}
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-medium text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
        >
          <CalendarPlus className="h-3.5 w-3.5" /> New
        </button>
      )}
    </div>
  );

  // ── Compact: next three upcoming events. ───────────────────────────────────
  if (compact) {
    const upcoming = events.filter((e) => (ms(e.end) || ms(e.start)) >= now);
    const picks = (upcoming.length ? upcoming : events).slice(0, 3);
    return (
      <Surface header={<SurfaceTitle>{title}</SurfaceTitle>} right={<SurfaceSubtitle>{events.length} event{events.length === 1 ? '' : 's'}</SurfaceSubtitle>}>
        {picks.length ? (
          <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
            {picks.map((ev) => (
              <div key={ev.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: eventColor(ev) }} />
                <span className="w-28 shrink-0 truncate text-[11px] tabular-nums text-[var(--ds-muted)]">{dayLabel(ms(ev.start) || now, now)} {ev.allDay ? '' : new Date(ms(ev.start)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ds-ink)]">{ev.title}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-4 text-center text-xs text-[var(--ds-muted)]">Nothing scheduled — you’re free.</div>
        )}
      </Surface>
    );
  }

  // ── Detailed: view switcher + the selected view. ───────────────────────────
  const tabs: View[] = ['agenda', 'week', 'month'];
  const header = (
    <>
      <SurfaceTitle>{title}</SurfaceTitle>
      <SurfaceSubtitle>{events.length} event{events.length === 1 ? '' : 's'}{data.timezone ? ` · ${data.timezone}` : ''}</SurfaceSubtitle>
    </>
  );

  return (
    <Surface header={header} right={headerRight}>
      <div className="flex items-center gap-1 border-y border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-2 py-1.5">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setView(t)}
            className={`rounded-lg px-2.5 py-1 text-[12px] font-medium capitalize transition-colors ${view === t ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'}`}
          >
            {t}
          </button>
        ))}
        {(view === 'week' || view === 'month') && (
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setCursor((c) => c - (view === 'week' ? 7 * DAY_MS : 28 * DAY_MS))} className="rounded-md p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]"><ChevronLeft className="h-4 w-4" /></button>
            <button onClick={() => setCursor(now)} className="rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]">Today</button>
            <button onClick={() => setCursor((c) => c + (view === 'week' ? 7 * DAY_MS : 28 * DAY_MS))} className="rounded-md p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]"><ChevronRight className="h-4 w-4" /></button>
          </div>
        )}
      </div>

      {view === 'agenda' && <AgendaView events={events} now={now} onOpen={openEvent} />}
      {view === 'week' && <WeekView events={events} now={now} cursor={cursor} onOpen={openEvent} />}
      {view === 'month' && (
        <MonthView
          events={events}
          now={now}
          cursor={cursor}
          onOpenDay={(e, date) => setPopover({ kind: 'day', anchor: anchorFromEvent(e.currentTarget as HTMLElement), date })}
        />
      )}

      {popover && (
        <DetailPopover
          anchor={popover.anchor}
          onClose={() => { setPopover(null); setError(undefined); }}
          accent={popover.kind === 'event' ? eventColor(popover.event) : undefined}
          title={popover.kind === 'event' ? popover.event.title : popover.kind === 'create' ? 'New event' : popover.kind === 'edit' ? 'Edit event' : new Date(popover.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        >
          {popover.kind === 'event' && (
            <Detail
              event={popover.event}
              now={now}
              canWrite={canWrite}
              busy={busy}
              error={error}
              onEdit={() => setPopover({ kind: 'edit', anchor: popover.anchor, event: popover.event })}
              onDelete={() => runWrite('delete', { eventId: popover.event.id }, 'Deleted')}
              onRsvp={(r) => runWrite('rsvp', { eventId: popover.event.id, response: r }, 'RSVP sent')}
            />
          )}
          {popover.kind === 'day' && (
            <DayList
              date={popover.date}
              events={events}
              onPick={(event) => setPopover({ kind: 'event', anchor: popover.anchor, event })}
            />
          )}
          {(popover.kind === 'create' || popover.kind === 'edit') && (
            <EventForm
              initial={popover.kind === 'edit' ? popover.event : undefined}
              busy={busy}
              error={error}
              onCancel={() => { setPopover(null); setError(undefined); }}
              onSubmit={(params) =>
                popover.kind === 'edit'
                  ? runWrite('update', { eventId: popover.event.id, ...params }, 'Saved')
                  : runWrite('create', params, 'Event created')
              }
            />
          )}
        </DetailPopover>
      )}
    </Surface>
  );
};

// ----------------------------------------------------------------- Subviews ---
const EventRow: React.FC<{ ev: CalendarEventView; onOpen: (e: React.MouseEvent, ev: CalendarEventView) => void }> = ({ ev, onOpen }) => (
  <button
    onClick={(e) => onOpen(e, ev)}
    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--ds-well)]"
  >
    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: eventColor(ev) }} />
    <span className="w-24 shrink-0 truncate text-[11px] tabular-nums text-[var(--ds-muted)]">{ev.allDay ? 'All day' : new Date(ms(ev.start)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ds-ink)]">{ev.title}</span>
    {ev.responseStatus && ev.responseStatus !== 'accepted' && (
      <Badge color={RSVP_TINT[ev.responseStatus] || NEUTRAL}>{rsvpLabel[ev.responseStatus] || ev.responseStatus}</Badge>
    )}
    {ev.location && <MapPin className="h-3 w-3 shrink-0 text-[var(--ds-faint)]" />}
  </button>
);

const AgendaView: React.FC<{ events: CalendarEventView[]; now: number; onOpen: (e: React.MouseEvent, ev: CalendarEventView) => void }> = ({ events, now, onOpen }) => {
  const groups = useMemo(() => {
    const map: { label: string; key: number; events: CalendarEventView[] }[] = [];
    for (const ev of events) {
      const t = ms(ev.start);
      if (!Number.isFinite(t)) continue;
      const key = startOfDay(t);
      const last = map[map.length - 1];
      if (last && last.key === key) last.events.push(ev);
      else map.push({ label: dayLabel(key, now), key, events: [ev] });
    }
    return map;
  }, [events, now]);

  if (!groups.length) return <div className="px-3 py-8 text-center text-sm text-[var(--ds-muted)]">Nothing scheduled in this window.</div>;
  return (
    <div className="max-h-[28rem] overflow-y-auto [scrollbar-width:thin]">
      {groups.map((g) => (
        <section key={g.key}>
          <div className="sticky top-0 z-[1] border-b border-[var(--ds-hairline-soft)] bg-[color-mix(in_srgb,var(--ds-well)_92%,transparent)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] backdrop-blur-sm">{g.label}</div>
          <ul className="divide-y divide-[var(--ds-hairline-soft)]">
            {g.events.map((ev) => <li key={ev.id}><EventRow ev={ev} onOpen={onOpen} /></li>)}
          </ul>
        </section>
      ))}
    </div>
  );
};

const WeekView: React.FC<{ events: CalendarEventView[]; now: number; cursor: number; onOpen: (e: React.MouseEvent, ev: CalendarEventView) => void }> = ({ events, now, cursor, onOpen }) => {
  const weekStart = useMemo(() => { const d = new Date(startOfDay(cursor)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }, [cursor]);
  const days = Array.from({ length: 7 }, (_, i) => weekStart + i * DAY_MS);
  const byDay = useMemo(() => {
    const m = new Map<number, CalendarEventView[]>();
    for (const ev of events) { const t = ms(ev.start); if (Number.isFinite(t)) { const k = startOfDay(t); (m.get(k) || m.set(k, []).get(k)!).push(ev); } }
    return m;
  }, [events]);
  return (
    <div className="grid grid-cols-7 gap-px bg-[var(--ds-hairline-soft)]">
      {days.map((d) => {
        const isToday = startOfDay(now) === d;
        const list = (byDay.get(d) || []).slice().sort(sortByStart);
        return (
          <div key={d} className="min-h-[8rem] bg-[var(--ds-surface)] p-1.5">
            <div className={`mb-1 text-center text-[10px] font-semibold uppercase ${isToday ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-muted)]'}`}>
              {WEEKDAYS[new Date(d).getDay()]}<br />
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${isToday ? 'bg-[var(--ds-accent)] text-white' : 'text-[var(--ds-ink)]'}`}>{new Date(d).getDate()}</span>
            </div>
            <div className="space-y-1">
              {list.slice(0, 6).map((ev) => (
                <button
                  key={ev.id}
                  onClick={(e) => onOpen(e, ev)}
                  className="block w-full truncate rounded-md px-1.5 py-1 text-left text-[10px] font-medium text-white"
                  style={{ backgroundColor: withAlpha(typeof eventColor(ev) === 'string' && eventColor(ev).startsWith('#') ? eventColor(ev) : '#D97757', 0.92) }}
                  title={`${timeLabel(ev)} · ${ev.title}`}
                >
                  {ev.allDay ? '' : `${new Date(ms(ev.start)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} `}{ev.title}
                </button>
              ))}
              {list.length > 6 && <div className="px-1 text-[10px] text-[var(--ds-muted)]">+{list.length - 6}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const MonthView: React.FC<{ events: CalendarEventView[]; now: number; cursor: number; onOpenDay: (e: React.MouseEvent, date: number) => void }> = ({ events, now, cursor, onOpenDay }) => {
  const { gridStart, monthIdx, label } = useMemo(() => {
    const c = new Date(cursor);
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const gs = new Date(first); gs.setDate(1 - first.getDay());
    return { gridStart: gs.getTime(), monthIdx: c.getMonth(), label: c.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
  }, [cursor]);
  const countByDay = useMemo(() => {
    const m = new Map<number, CalendarEventView[]>();
    for (const ev of events) { const t = ms(ev.start); if (Number.isFinite(t)) { const k = startOfDay(t); (m.get(k) || m.set(k, []).get(k)!).push(ev); } }
    return m;
  }, [events]);
  const cells = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY_MS);
  return (
    <div>
      <div className="px-3 py-1.5 text-center text-[12px] font-semibold text-[var(--ds-ink)]">{label}</div>
      <div className="grid grid-cols-7 border-b border-[var(--ds-hairline-soft)] text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-faint)]">
        {WEEKDAYS.map((w) => <div key={w} className="py-1">{w[0]}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px bg-[var(--ds-hairline-soft)]">
        {cells.map((d) => {
          const inMonth = new Date(d).getMonth() === monthIdx;
          const isToday = startOfDay(now) === d;
          const list = (countByDay.get(d) || []).slice().sort(sortByStart);
          return (
            <button
              key={d}
              onClick={list.length ? (e) => onOpenDay(e, d) : undefined}
              className={`min-h-[3.6rem] p-1 text-left align-top transition-colors ${inMonth ? 'bg-[var(--ds-surface)]' : 'bg-[var(--ds-well)]'} ${list.length ? 'cursor-pointer hover:bg-[var(--ds-hover)]' : 'cursor-default'}`}
            >
              <div className={`text-[11px] tabular-nums ${isToday ? 'font-bold text-[var(--ds-accent)]' : inMonth ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-faint)]'}`}>{new Date(d).getDate()}</div>
              <div className="mt-0.5 space-y-0.5">
                {list.slice(0, 2).map((ev) => (
                  <div key={ev.id} className="flex items-center gap-1 truncate text-[9px] text-[var(--ds-muted)]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: eventColor(ev) }} />
                    <span className="truncate">{ev.title}</span>
                  </div>
                ))}
                {list.length > 2 && <div className="text-[9px] font-medium text-[var(--ds-faint)]">+{list.length - 2} more</div>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const DayList: React.FC<{ date: number; events: CalendarEventView[]; onPick: (ev: CalendarEventView) => void }> = ({ date, events, onPick }) => {
  const list = events.filter((e) => startOfDay(ms(e.start)) === date).slice().sort(sortByStart);
  if (!list.length) return <p className="text-[12px] text-[var(--ds-muted)]">No events.</p>;
  return (
    <ul className="space-y-1">
      {list.map((ev) => (
        <li key={ev.id}>
          <button onClick={() => onPick(ev)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--ds-hover)]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: eventColor(ev) }} />
            <span className="w-20 shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">{ev.allDay ? 'All day' : new Date(ms(ev.start)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ds-ink)]">{ev.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
};
