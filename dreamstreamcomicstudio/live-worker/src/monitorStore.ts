/**
 * MonitorStore — a nursery's history, kept in its MonitorRoom Durable
 * Object's own SQLite database: one database per nursery, strongly
 * consistent, living right next to the alert engine that writes it.
 *
 *   mon_events     every log line (sounds, vision, noise, care logs, people…)
 *   mon_minutes    per-camera, per-minute measurements (dB, motion, light, state)
 *   mon_sleep      sleep sessions and their summaries
 *   mon_incidents  alerts that need a person: open → acknowledged → resolved
 *
 * Never stores audio or video. Retention: events & incidents 90 days,
 * minutes 31 days, sleep sessions ~13 months.
 */

/** The slice of Durable Object `SqlStorage` the store uses (sql.js in tests). */
export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export type Severity = 'urgent' | 'warn' | 'info' | 'care';

export interface StoredEvent {
  id: string;
  at: number;
  kind: string;
  sev: Severity;
  msg: string;
  dev?: string | null;
  by?: string | null;
  secs?: number | null;
  conf?: number | null;
  db?: number | null;
  incident?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface MinuteRow {
  dev: string;
  /** Minute start, epoch ms. */
  m: number;
  laeq: number | null;
  lmax: number | null;
  l10: number | null;
  l50: number | null;
  l90: number | null;
  lpk: number | null;
  /** 1 = the phone's sound meter is calibrated. */
  cal: number;
  motion: number | null;
  mmax: number | null;
  crib: number | null;
  outside: number | null;
  light: number | null;
  /** Worst baby-state rank seen in the minute (1 calm … 5 crying). */
  state: number | null;
  /** Seconds each sound category was heard. */
  sounds: Record<string, number>;
  visit: number;
}

export type IncidentStatus = 'open' | 'acked' | 'resolved';

export interface IncidentRow {
  id: string;
  at: number;
  kind: string;
  sev: Severity;
  title: string;
  dev: string | null;
  status: IncidentStatus;
  ack_by: string | null;
  ack_at: number | null;
  resolved_at: number | null;
  pushes: number;
  /** When the escalation engine should look at it next (null = never). */
  next_at: number | null;
}

export interface SleepRow {
  id: string;
  start: number;
  end: number | null;
  /** Fell asleep (first minute of the first quiet run). */
  onset: number | null;
  kind: 'night' | 'nap';
  source: 'auto' | 'manual';
  asleep_min: number;
  awake_min: number;
  wakings: number;
  longest_min: number;
  cry_min: number;
  laeq: number | null;
  summary: Record<string, unknown> | null;
}

export const RETAIN = {
  events: 90 * 24 * 60 * 60_000,
  incidents: 90 * 24 * 60 * 60_000,
  minutes: 31 * 24 * 60 * 60_000,
  sleep: 400 * 24 * 60 * 60_000,
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mon_events (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, sev TEXT NOT NULL, msg TEXT NOT NULL,
    dev TEXT, who TEXT, secs INTEGER, conf INTEGER, db REAL, incident TEXT, meta TEXT)`,
  `CREATE INDEX IF NOT EXISTS mon_events_at ON mon_events(at)`,
  `CREATE INDEX IF NOT EXISTS mon_events_kind_at ON mon_events(kind, at)`,
  `CREATE TABLE IF NOT EXISTS mon_minutes (
    dev TEXT NOT NULL, m INTEGER NOT NULL,
    laeq REAL, lmax REAL, l10 REAL, l50 REAL, l90 REAL, lpk REAL, cal INTEGER NOT NULL DEFAULT 0,
    motion REAL, mmax REAL, crib REAL, outside REAL, light REAL, state INTEGER, sounds TEXT, visit INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dev, m))`,
  `CREATE INDEX IF NOT EXISTS mon_minutes_m ON mon_minutes(m)`,
  `CREATE TABLE IF NOT EXISTS mon_sleep (
    id TEXT PRIMARY KEY, start INTEGER NOT NULL, end_at INTEGER, onset INTEGER, kind TEXT NOT NULL, source TEXT NOT NULL,
    asleep_min INTEGER NOT NULL DEFAULT 0, awake_min INTEGER NOT NULL DEFAULT 0, wakings INTEGER NOT NULL DEFAULT 0,
    longest_min INTEGER NOT NULL DEFAULT 0, cry_min INTEGER NOT NULL DEFAULT 0, laeq REAL, summary TEXT)`,
  `CREATE INDEX IF NOT EXISTS mon_sleep_start ON mon_sleep(start)`,
  `CREATE TABLE IF NOT EXISTS mon_incidents (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, sev TEXT NOT NULL, title TEXT NOT NULL, dev TEXT,
    status TEXT NOT NULL, ack_by TEXT, ack_at INTEGER, resolved_at INTEGER, pushes INTEGER NOT NULL DEFAULT 0, next_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS mon_incidents_open ON mon_incidents(status, next_at)`,
  `CREATE INDEX IF NOT EXISTS mon_incidents_at ON mon_incidents(at)`,
];

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const parse = <T>(v: unknown): T | null => {
  if (typeof v !== 'string' || !v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};
const placeholders = (k: number) => Array.from({ length: k }, () => '?').join(',');

function toEvent(r: Record<string, unknown>): StoredEvent {
  return {
    id: String(r.id),
    at: Number(r.at),
    kind: String(r.kind),
    sev: String(r.sev) as Severity,
    msg: String(r.msg),
    dev: (r.dev as string | null) ?? null,
    by: (r.who as string | null) ?? null,
    secs: n(r.secs),
    conf: n(r.conf),
    db: n(r.db),
    incident: (r.incident as string | null) ?? null,
    meta: parse<Record<string, unknown>>(r.meta),
  };
}

function toMinute(r: Record<string, unknown>): MinuteRow {
  return {
    dev: String(r.dev),
    m: Number(r.m),
    laeq: n(r.laeq),
    lmax: n(r.lmax),
    l10: n(r.l10),
    l50: n(r.l50),
    l90: n(r.l90),
    lpk: n(r.lpk),
    cal: Number(r.cal ?? 0),
    motion: n(r.motion),
    mmax: n(r.mmax),
    crib: n(r.crib),
    outside: n(r.outside),
    light: n(r.light),
    state: n(r.state),
    sounds: parse<Record<string, number>>(r.sounds) ?? {},
    visit: Number(r.visit ?? 0),
  };
}

function toIncident(r: Record<string, unknown>): IncidentRow {
  return {
    id: String(r.id),
    at: Number(r.at),
    kind: String(r.kind),
    sev: String(r.sev) as Severity,
    title: String(r.title),
    dev: (r.dev as string | null) ?? null,
    status: String(r.status) as IncidentStatus,
    ack_by: (r.ack_by as string | null) ?? null,
    ack_at: n(r.ack_at),
    resolved_at: n(r.resolved_at),
    pushes: Number(r.pushes ?? 0),
    next_at: n(r.next_at),
  };
}

function toSleep(r: Record<string, unknown>): SleepRow {
  return {
    id: String(r.id),
    start: Number(r.start),
    end: n(r.end_at),
    onset: n(r.onset),
    kind: String(r.kind) as SleepRow['kind'],
    source: String(r.source) as SleepRow['source'],
    asleep_min: Number(r.asleep_min ?? 0),
    awake_min: Number(r.awake_min ?? 0),
    wakings: Number(r.wakings ?? 0),
    longest_min: Number(r.longest_min ?? 0),
    cry_min: Number(r.cry_min ?? 0),
    laeq: n(r.laeq),
    summary: parse<Record<string, unknown>>(r.summary),
  };
}

export class MonitorStore {
  constructor(private sql: SqlExec) {}

  private q(query: string, ...b: unknown[]): Record<string, unknown>[] {
    return this.sql.exec(query, ...b.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v))).toArray();
  }

  init(): void {
    for (const s of SCHEMA) this.q(s);
  }

  /* -------------------------------------------------------------- events */

  addEvent(e: StoredEvent): void {
    this.q(
      `INSERT OR REPLACE INTO mon_events (id, at, kind, sev, msg, dev, who, secs, conf, db, incident, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      e.id, e.at, e.kind, e.sev, e.msg, e.dev, e.by, e.secs, e.conf, e.db, e.incident, e.meta ? JSON.stringify(e.meta) : null,
    );
  }

  setEventIncident(id: string, incident: string): void {
    this.q(`UPDATE mon_events SET incident = ? WHERE id = ?`, incident, id);
  }

  getEvent(id: string): StoredEvent | null {
    const r = this.q(`SELECT * FROM mon_events WHERE id = ?`, id)[0];
    return r ? toEvent(r) : null;
  }

  /** Newest first, paged by time. */
  events(opts: { before?: number; limit?: number; kinds?: string[]; since?: number } = {}): StoredEvent[] {
    const where: string[] = [];
    const b: unknown[] = [];
    if (opts.before != null) {
      where.push('at < ?');
      b.push(opts.before);
    }
    if (opts.since != null) {
      where.push('at >= ?');
      b.push(opts.since);
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${placeholders(opts.kinds.length)})`);
      b.push(...opts.kinds);
    }
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    return this.q(`SELECT * FROM mon_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ${limit}`, ...b).map(toEvent);
  }

  /** Oldest first, for reports and export. */
  eventsBetween(from: number, to: number, kinds?: string[]): StoredEvent[] {
    const k = kinds?.length ? ` AND kind IN (${placeholders(kinds.length)})` : '';
    return this.q(`SELECT * FROM mon_events WHERE at >= ? AND at < ?${k} ORDER BY at ASC LIMIT 20000`, from, to, ...(kinds ?? [])).map(toEvent);
  }

  /** How many of each kind, and their total seconds, in a window. */
  tally(from: number, to: number): Record<string, { n: number; secs: number }> {
    const out: Record<string, { n: number; secs: number }> = {};
    for (const r of this.q(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(secs), 0) AS secs FROM mon_events WHERE at >= ? AND at < ? GROUP BY kind`, from, to)) {
      out[String(r.kind)] = { n: Number(r.n), secs: Number(r.secs) };
    }
    return out;
  }

  /* ------------------------------------------------------------- minutes */

  putMinute(r: MinuteRow): void {
    this.q(
      `INSERT OR REPLACE INTO mon_minutes (dev, m, laeq, lmax, l10, l50, l90, lpk, cal, motion, mmax, crib, outside, light, state, sounds, visit)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.dev, r.m, r.laeq, r.lmax, r.l10, r.l50, r.l90, r.lpk, r.cal, r.motion, r.mmax, r.crib, r.outside, r.light, r.state,
      JSON.stringify(r.sounds ?? {}), r.visit,
    );
  }

  minutes(from: number, to: number, dev?: string): MinuteRow[] {
    return (dev
      ? this.q(`SELECT * FROM mon_minutes WHERE dev = ? AND m >= ? AND m < ? ORDER BY m ASC LIMIT 50000`, dev, from, to)
      : this.q(`SELECT * FROM mon_minutes WHERE m >= ? AND m < ? ORDER BY m ASC, dev ASC LIMIT 50000`, from, to)
    ).map(toMinute);
  }

  /** Device ids that reported minutes since a time, busiest first. */
  activeDevs(since: number): string[] {
    return this.q(`SELECT dev, COUNT(*) AS c FROM mon_minutes WHERE m >= ? GROUP BY dev ORDER BY c DESC`, since).map((r) => String(r.dev));
  }

  /* ----------------------------------------------------------- incidents */

  addIncident(r: IncidentRow): void {
    this.q(
      `INSERT INTO mon_incidents (id, at, kind, sev, title, dev, status, ack_by, ack_at, resolved_at, pushes, next_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.id, r.at, r.kind, r.sev, r.title, r.dev, r.status, r.ack_by, r.ack_at, r.resolved_at, r.pushes, r.next_at,
    );
  }

  incident(id: string): IncidentRow | null {
    const r = this.q(`SELECT * FROM mon_incidents WHERE id = ?`, id)[0];
    return r ? toIncident(r) : null;
  }

  /** The newest still-open incident of a kind for a device (one episode = one incident). */
  openIncident(kind: string, dev: string | null): IncidentRow | null {
    const r = this.q(
      `SELECT * FROM mon_incidents WHERE kind = ? AND status != 'resolved' AND (dev IS ? OR dev = ?) ORDER BY at DESC LIMIT 1`,
      kind, dev, dev,
    )[0];
    return r ? toIncident(r) : null;
  }

  activeIncidents(): IncidentRow[] {
    return this.q(`SELECT * FROM mon_incidents WHERE status != 'resolved' ORDER BY at DESC LIMIT 50`).map(toIncident);
  }

  dueIncidents(now: number): IncidentRow[] {
    return this.q(`SELECT * FROM mon_incidents WHERE status = 'open' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at ASC LIMIT 50`, now).map(toIncident);
  }

  nextIncidentAt(): number | null {
    const r = this.q(`SELECT MIN(next_at) AS t FROM mon_incidents WHERE status = 'open' AND next_at IS NOT NULL`)[0];
    return r ? n(r.t) : null;
  }

  updateIncident(id: string, patch: Partial<Omit<IncidentRow, 'id'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.q(`UPDATE mon_incidents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
  }

  incidentsBetween(from: number, to: number): IncidentRow[] {
    return this.q(`SELECT * FROM mon_incidents WHERE at >= ? AND at < ? ORDER BY at ASC LIMIT 5000`, from, to).map(toIncident);
  }

  /* --------------------------------------------------------------- sleep */

  putSleep(r: SleepRow): void {
    this.q(
      `INSERT OR REPLACE INTO mon_sleep (id, start, end_at, onset, kind, source, asleep_min, awake_min, wakings, longest_min, cry_min, laeq, summary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.id, r.start, r.end, r.onset, r.kind, r.source, r.asleep_min, r.awake_min, r.wakings, r.longest_min, r.cry_min, r.laeq,
      r.summary ? JSON.stringify(r.summary) : null,
    );
  }

  sleep(id: string): SleepRow | null {
    const r = this.q(`SELECT * FROM mon_sleep WHERE id = ?`, id)[0];
    return r ? toSleep(r) : null;
  }

  /** Sessions overlapping a window, oldest first. */
  sleepBetween(from: number, to: number): SleepRow[] {
    return this.q(`SELECT * FROM mon_sleep WHERE start < ? AND (end_at IS NULL OR end_at > ?) ORDER BY start ASC LIMIT 1000`, to, from).map(toSleep);
  }

  lastSleep(limit = 1, kind?: SleepRow['kind']): SleepRow[] {
    return (kind
      ? this.q(`SELECT * FROM mon_sleep WHERE kind = ? AND end_at IS NOT NULL ORDER BY start DESC LIMIT ?`, kind, limit)
      : this.q(`SELECT * FROM mon_sleep WHERE end_at IS NOT NULL ORDER BY start DESC LIMIT ?`, limit)
    ).map(toSleep);
  }

  /* ----------------------------------------------------------- retention */

  purge(now: number): void {
    this.q(`DELETE FROM mon_events WHERE at < ?`, now - RETAIN.events);
    this.q(`DELETE FROM mon_incidents WHERE at < ?`, now - RETAIN.incidents);
    this.q(`DELETE FROM mon_minutes WHERE m < ?`, now - RETAIN.minutes);
    this.q(`DELETE FROM mon_sleep WHERE start < ?`, now - RETAIN.sleep);
  }

  /* -------------------------------------------------------------- export */

  csv(what: 'events' | 'minutes' | 'sleep', from: number, to: number, tz: string): string {
    const time = (ms: number | null) => (ms == null ? '' : localIso(ms, tz));
    const cell = (v: unknown) => {
      const s = v == null ? '' : String(v);
      // Neutralise spreadsheet formulas and quote everything.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const line = (vals: unknown[]) => vals.map(cell).join(',');
    if (what === 'events') {
      const rows = this.eventsBetween(from, to);
      return [line(['time', 'kind', 'severity', 'message', 'by', 'camera', 'seconds', 'confidence', 'dB']), ...rows.map((e) => line([time(e.at), e.kind, e.sev, e.msg, e.by, e.dev, e.secs, e.conf, e.db]))].join('\r\n');
    }
    if (what === 'minutes') {
      const rows = this.minutes(from, to);
      return [
        line(['minute', 'camera', 'LAeq dB', 'LAmax dB', 'L10 dB', 'L50 dB', 'L90 dB', 'peak dB', 'calibrated', 'motion', 'crib motion', 'outside motion', 'light', 'state', 'sounds (s)', 'visit']),
        ...rows.map((r) => line([time(r.m), r.dev, r.laeq, r.lmax, r.l10, r.l50, r.l90, r.lpk, r.cal ? 'yes' : 'no', r.motion, r.crib, r.outside, r.light, r.state, Object.entries(r.sounds).map(([k, v]) => `${k}:${v}`).join(' '), r.visit ? 'yes' : '']))
      ].join('\r\n');
    }
    const rows = this.sleepBetween(from, to);
    return [
      line(['start', 'fell asleep', 'end', 'type', 'asleep (min)', 'awake (min)', 'wake-ups', 'longest stretch (min)', 'crying (min)', 'avg dB', 'source']),
      ...rows.map((r) => line([time(r.start), time(r.onset), time(r.end), r.kind, r.asleep_min, r.awake_min, r.wakings, r.longest_min, r.cry_min, r.laeq, r.source])),
    ].join('\r\n');
  }
}

/* ------------------------------------------------------------ local time */

/** Local wall-clock parts of an instant in an IANA zone (falls back to UTC). */
export function localParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
  } catch {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  }
}

export function localIso(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  const z = (v: number) => String(v).padStart(2, '0');
  return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}`;
}

/** Clock time like "7:42 PM" in the nursery's zone. */
export function clockTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
