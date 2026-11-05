import React, { useState } from 'react';
import { CalendarPlus, Pencil, Trash2, Check, Loader2, MapPin, Users, Clock, ExternalLink, AlertTriangle, CalendarCheck, Dot } from 'lucide-react';
import type { CalendarEventDraftArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle } from './kit';
import { mutateEvent, type CalendarAction } from '../../../services/calendarApi';
import { beginArtifactWrite, endArtifactWrite } from '../../../services/chatStreams';
import type { ChatArtifactState } from '../../../services/chatStorage';
import type { ArtifactTurn } from './ChatArtifacts';
import { FOCUS_RING, TONE_TEXT } from '../studioDesign';

// The confirmation card a calendar WRITE tool emits. The model prepared an action;
// nothing changes until the user clicks confirm here, which calls the scoped mutate
// route. Honest states for not-connected / read-only / done so it never silently no-ops.
//
// NEVER TWICE (CHAT-0, bug B5). What the card did is recorded on its chat turn (`turn.settle`,
// ChatTurn.artifactState), not in component state: before the write a `pending` mark, after it the
// outcome. So a reload, a remounted chat or another device shows the outcome instead of Confirm /
// Add all again. A write whose answer never came back (the page went away mid-request) is shown as
// "may already be in your calendar", never offered again. Once the conversation moves on, an
// untouched card settles too (lead decision D3): one line, no controls.

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

type RowStatus = 'idle' | 'busy' | 'pending' | 'done' | 'error';

// --- Settled: one line, no controls (D3) ----------------------------------------------------------

/**
 * One quiet line for a card the conversation has moved past or whose action finished: what happened,
 * and at most a plain link to where it lives. No buttons, no inputs.
 */
export const SettledArtifactLine: React.FC<{
  type: string;
  tone: 'success' | 'neutral' | 'warning';
  text: string;
  detail?: string;
  link?: { href: string; label: string };
}> = ({ type, tone, text, detail, link }) => (
  <div
    data-settled={type}
    role="group"
    aria-label={detail ? `${text} · ${detail}` : text}
    aria-live="off"
    className="my-1 flex min-h-7 coarse:min-h-11 min-w-0 items-center gap-2 text-[13px] text-[var(--ds-ink)]"
  >
    {tone === 'success' ? (
      <Check aria-hidden className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.success}`} />
    ) : tone === 'warning' ? (
      <AlertTriangle aria-hidden className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.warning}`} />
    ) : (
      <Dot aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
    )}
    <span className={`min-w-0 truncate ${tone === 'neutral' ? 'text-[var(--ds-muted)]' : ''}`}>
      {text}
      {detail && <span className="text-[var(--ds-muted)]"> · {detail}</span>}
    </span>
    {link && (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`ml-auto inline-flex shrink-0 items-center gap-1 coarse:min-h-11 coarse:px-2 text-[12px] font-medium text-[var(--ds-muted)] underline-offset-2 hover:text-[var(--ds-ink)] hover:underline ${FOCUS_RING}`}
      >
        <ExternalLink aria-hidden className="h-3.5 w-3.5" /> {link.label}
      </a>
    )}
  </div>
);

const isBatch = (data: CalendarEventDraftArtifact): boolean =>
  data.action === 'create' && Array.isArray(data.events) && data.events.length > 1;

const batchEvents = (data: CalendarEventDraftArtifact) => (data.events || []).filter((e) => e && e.title);

/** Each listed row's recorded outcome (`busy` never survives: an unanswered write reads `pending`). */
const storedRows = (data: CalendarEventDraftArtifact, state?: ChatArtifactState): RowStatus[] =>
  batchEvents(data).map((_, i) => state?.result?.rows?.[i] ?? 'idle');

const storedRemoved = (state?: ChatArtifactState): Set<number> => new Set(state?.result?.removed ?? []);

/**
 * True when the card shows its settled line: its action finished (or may have: a `pending` mark whose
 * write is no longer in flight), or the conversation moved on. Never while a write is in flight.
 */
export const calendarDraftSettled = (data: CalendarEventDraftArtifact, turn?: ArtifactTurn): boolean => {
  if (!turn || turn.writing) return false;
  const st = turn.state;
  if (isBatch(data)) {
    if (st?.status === 'done' || turn.passed) return true;
    // Nothing left that is safe to add (every row added, or may already be): finished.
    if (!st) return false;
    const removed = storedRemoved(st);
    return storedRows(data, st).every((r, i) => removed.has(i) || r === 'done' || r === 'pending');
  }
  if (st?.status === 'done' || st?.status === 'pending') return true;
  return turn.passed;
};

const PASSED_TEXT: Record<CalendarAction, string> = {
  create: 'Not added — you moved on',
  update: 'Not changed — you moved on',
  delete: 'Not deleted — you moved on',
  rsvp: 'No RSVP sent — you moved on'
};

const DONE_TEXT = (data: CalendarEventDraftArtifact): string =>
  data.action === 'delete' ? 'Event deleted' : data.action === 'rsvp' ? `RSVP sent (${data.response || 'accepted'})` : data.action === 'update' ? 'Event updated' : 'Added to your calendar';

const PENDING_TEXT: Record<CalendarAction, string> = {
  create: 'This may already be in your calendar — check it before asking again',
  update: 'This change may already be saved — check your calendar',
  delete: 'This may already be deleted — check your calendar',
  rsvp: 'Your RSVP may already be sent — check your calendar'
};

const CalendarSettled: React.FC<{ data: CalendarEventDraftArtifact; turn: ArtifactTurn }> = ({ data, turn }) => {
  const st = turn.state;
  if (isBatch(data)) {
    const removed = storedRemoved(st);
    const rows = storedRows(data, st).filter((_, i) => !removed.has(i));
    const added = rows.filter((r) => r === 'done').length;
    const unsure = rows.filter((r) => r === 'pending').length;
    const total = rows.length;
    const unsureText = unsure ? `${unsure} may already be in your calendar` : undefined;
    if (st?.status === 'done' || (total > 0 && added === total)) {
      return <SettledArtifactLine type="calendar_event_draft" tone="success" text={`Added ${added} event${added === 1 ? '' : 's'} to your calendar`} />;
    }
    if (added > 0) {
      const rest = rows.some((r) => r === 'idle' || r === 'error');
      return <SettledArtifactLine type="calendar_event_draft" tone="success" text={`Added ${added} of ${total} events${rest ? ' — you moved on' : ''}`} detail={unsureText} />;
    }
    if (unsure > 0) return <SettledArtifactLine type="calendar_event_draft" tone="warning" text={`${unsure === 1 ? 'An event' : `${unsure} events`} may already be in your calendar — check it before asking again`} />;
    return <SettledArtifactLine type="calendar_event_draft" tone="neutral" text={PASSED_TEXT.create} />;
  }
  const title = data.event?.title || undefined;
  if (st?.status === 'done') {
    const link = st.result?.htmlLink;
    return (
      <SettledArtifactLine
        type="calendar_event_draft"
        tone="success"
        text={DONE_TEXT(data)}
        detail={title}
        link={link && /^https:\/\//i.test(link) ? { href: link, label: 'Open' } : undefined}
      />
    );
  }
  if (st?.status === 'pending') return <SettledArtifactLine type="calendar_event_draft" tone="warning" text={PENDING_TEXT[data.action] || PENDING_TEXT.create} detail={title} />;
  return <SettledArtifactLine type="calendar_event_draft" tone="neutral" text={PASSED_TEXT[data.action] || PASSED_TEXT.create} detail={title} />;
};

// BATCH create: one card listing several events with an "Add all" action. Each row gets
// its own live status as they're created sequentially; rows can be removed before adding.
// Every row's outcome is recorded on the turn as it lands (`pending` just before its write), so
// nothing is ever added twice: a reload restores the rows and offers only the ones still to add.
const BatchEventDraft: React.FC<{ data: CalendarEventDraftArtifact; turn?: ArtifactTurn }> = ({ data, turn }) => {
  const events = batchEvents(data);
  const [statuses, setStatuses] = useState<RowStatus[]>(() => storedRows(data, turn?.state));
  const [removed, setRemoved] = useState<Set<number>>(() => storedRemoved(turn?.state));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const blocked = !data.connectionId ? 'not_connected' : !data.canWrite ? 'read_only' : null;
  const shown = events.map((e, i) => ({ e, i })).filter(({ i }) => !removed.has(i));
  const doneCount = shown.filter(({ i }) => statuses[i] === 'done').length;
  const failCount = shown.filter(({ i }) => statuses[i] === 'error').length;
  const unsureCount = shown.filter(({ i }) => statuses[i] === 'pending').length;
  // Rows that may still be added: never one that is added, or may already be.
  const toAdd = shown.filter(({ i }) => statuses[i] === 'idle' || statuses[i] === 'error');
  const started = shown.some(({ i }) => statuses[i] !== 'idle');

  const record = (rows: RowStatus[], removedRows: Set<number>) => {
    if (!turn) return;
    const persisted = rows.map((r) => (r === 'busy' ? 'pending' : r));
    const live = persisted.filter((_, i) => !removedRows.has(i));
    const allDone = live.length > 0 && live.every((r) => r === 'done');
    turn.settle({
      status: allDone ? 'done' : 'pending',
      at: Date.now(),
      result: { rows: persisted as Array<'idle' | 'pending' | 'done' | 'error'>, removed: Array.from(removedRows) }
    });
  };

  const addAll = async () => {
    if (!data.connectionId || blocked || running || turn?.writing) return;
    setRunning(true); setError(undefined);
    if (turn) beginArtifactWrite(turn.writeKey);
    // Local copy: React state lags inside this loop.
    const rows = [...statuses];
    try {
      for (const { e, i } of toAdd) {
        rows[i] = 'busy';
        setStatuses([...rows]);
        record(rows, removed);
        try {
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
          rows[i] = 'done';
        } catch (err) {
          rows[i] = 'error';
          setError((err as Error)?.message || 'Some events couldn’t be added.');
        }
        setStatuses([...rows]);
        record(rows, removed);
      }
    } finally {
      if (turn) endArtifactWrite(turn.writeKey);
      setRunning(false);
    }
  };

  const removeRow = (i: number) => {
    if (running || statuses[i] !== 'idle') return;
    const next = new Set(removed).add(i);
    setRemoved(next);
    if (started) record(statuses, next);
  };

  const header = (
    <>
      <SurfaceTitle>Add {shown.length} event{shown.length === 1 ? '' : 's'}</SurfaceTitle>
      <SurfaceSubtitle>{data.account || 'Google Calendar'}{started && !running ? ` · ${doneCount} added${failCount ? `, ${failCount} failed` : ''}` : ''}</SurfaceSubtitle>
    </>
  );

  const rowIcon = (s: RowStatus) =>
    s === 'busy' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ds-accent)]" />
      : s === 'done' ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        : s === 'error' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
          : s === 'pending' ? <Clock className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.warning}`} />
            : <CalendarPlus className="h-3.5 w-3.5 shrink-0 text-[var(--ds-faint)]" />;

  if (!shown.length) {
    return (
      <Surface header={header} accent="#10b981">
        <div className="px-3.5 py-4 text-[13px] text-[var(--ds-muted)]">{doneCount ? `Added ${doneCount} event${doneCount === 1 ? '' : 's'} to your calendar.` : 'Nothing to add.'}</div>
      </Surface>
    );
  }

  return (
    <Surface header={header} accent="var(--ds-accent)">
      <div className="space-y-2.5 px-3.5 py-3">
        <ul className="max-h-72 space-y-1 overflow-y-auto [scrollbar-width:thin]">
          {shown.map(({ e, i }) => (
            <li key={i} className="flex items-start gap-2 rounded-lg border border-[var(--ds-hairline-soft)] px-2.5 py-1.5">
              <span className="mt-0.5">{rowIcon(statuses[i])}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--ds-ink)]">{e.title}</p>
                <p className="truncate text-[11px] tabular-nums text-[var(--ds-muted)]">
                  {statuses[i] === 'pending' ? 'May already be in your calendar' : `${fmtWhen(e.start, e.end, e.allDay)}${e.location ? ` · ${e.location}` : ''}`}
                </p>
              </div>
              {!running && statuses[i] === 'idle' && (
                <button onClick={() => removeRow(i)} aria-label={`Remove ${e.title}`} className="shrink-0 rounded-md p-1 text-[var(--ds-faint)] hover:bg-[var(--ds-hover)] hover:text-rose-500">
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
        {!running && unsureCount > 0 && (
          <p className={`text-[12px] ${TONE_TEXT.warning}`}>
            {unsureCount === 1 ? 'One event' : `${unsureCount} events`} may already be in your calendar — they won’t be added again.
          </p>
        )}

        {(toAdd.length > 0 || running) && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-hairline-soft)] pt-2.5">
            <button
              onClick={addAll}
              disabled={running || !!blocked || !!turn?.writing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
              {running ? `Adding ${doneCount}/${shown.length}…` : started ? `Add the ${toAdd.length} left` : `Add all ${shown.length}`}
            </button>
          </div>
        )}
      </div>
    </Surface>
  );
};

/** The single-event card (create, edit, delete, RSVP). */
const SingleEventDraft: React.FC<{ data: CalendarEventDraftArtifact; turn?: ArtifactTurn }> = ({ data, turn }) => {
  const meta = ACTION_META[data.action] || ACTION_META.create;
  const { Icon } = meta;
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  // Outside a chat (the Gallery) there is no turn to record on: the done line is local.
  const [done, setDone] = useState<string | null>(null);

  const ev = data.event || {};
  const blocked = !data.connectionId ? 'not_connected' : !data.canWrite ? 'read_only' : null;
  const busy = status === 'busy' || !!turn?.writing;

  const confirm = async () => {
    if (!data.connectionId || blocked || busy) return;
    setStatus('busy'); setError(undefined);
    // Recorded BEFORE the write: if the answer never comes back here, the card must not offer the
    // write again. The registry tells a remounted card the write is still in flight.
    if (turn) {
      beginArtifactWrite(turn.writeKey);
      turn.settle({ status: 'pending', at: Date.now() });
    }
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
      const htmlLink = res?.event?.htmlLink;
      if (turn) turn.settle({ status: 'done', at: Date.now(), ...(htmlLink ? { result: { htmlLink } } : {}) });
      else setDone(htmlLink ?? '');
      setStatus('idle');
    } catch (e) {
      // Nothing was written: the card stays live (unless the chat moved on) and Confirm can be tried again.
      if (turn) turn.settle(null);
      setError((e as Error)?.message || 'That didn’t go through.');
      setStatus('error');
    } finally {
      if (turn) endArtifactWrite(turn.writeKey);
    }
  };

  if (done !== null) {
    return (
      <SettledArtifactLine
        type="calendar_event_draft"
        tone="success"
        text={DONE_TEXT(data)}
        detail={ev.title || undefined}
        link={done && /^https:\/\//i.test(done) ? { href: done, label: 'Open' } : undefined}
      />
    );
  }

  const accent = meta.danger ? '#e11d48' : 'var(--ds-accent)';
  const header = (
    <>
      <SurfaceTitle>{meta.label}</SurfaceTitle>
      <SurfaceSubtitle>{data.account ? data.account : 'Google Calendar'}{data.response ? ` · responding "${data.response}"` : ''}</SurfaceSubtitle>
    </>
  );

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
            disabled={busy || !!blocked}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors disabled:opacity-50 ${meta.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-[var(--ds-accent)] hover:bg-[var(--ds-accent-hover)]'}`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
            {meta.verb}
          </button>
        </div>
      </div>
    </Surface>
  );
};

export const CalendarEventDraft: React.FC<{ data: CalendarEventDraftArtifact; turn?: ArtifactTurn }> = ({ data, turn }) => {
  if (turn && calendarDraftSettled(data, turn)) return <CalendarSettled data={data} turn={turn} />;
  // Batch create (an itinerary / multiple parsed events) → the "Add all" card.
  if (isBatch(data)) return <BatchEventDraft data={data} turn={turn} />;
  return <SingleEventDraft data={data} turn={turn} />;
};
