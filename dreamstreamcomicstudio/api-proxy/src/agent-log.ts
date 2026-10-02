/**
 * Agent visit / check-in logging for the dreamstream-api Worker.
 *
 * Rows go to the owner's shared D1 (`akhielesh-portfolio-analytics`, tables
 * `agent_visits` / `agent_checkins`, `site` = dreamstreamstudio.ai) so AI visitors
 * to every site show up in one place (akhielesh.com/adminak → AI visitors).
 * Everything here runs at the edge — agents never wake the Railway backend.
 */
import { AGENT_QUESTIONS, type AgentMatch } from './agent-gate';

export const SITE = 'dreamstreamstudio.ai';

/** The subset of the D1 API this Worker uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
    run(): Promise<unknown>;
  };
}

let schemaReady = false;

/** Creates the tables on a fresh database and adds `site` to ones created before it existed. */
async function ensureSchema(db: D1Like) {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS agent_visits (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, path TEXT NOT NULL, agent_name TEXT, agent_kind TEXT, reason TEXT,
        user_agent TEXT, ip TEXT, country TEXT, asn TEXT, as_org TEXT, canary TEXT NOT NULL, headers TEXT,
        site TEXT NOT NULL DEFAULT 'akhielesh.com')`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS agent_checkins (
        id TEXT PRIMARY KEY, visit_id TEXT, created_at TEXT NOT NULL, agent_name TEXT, user_agent TEXT, ip TEXT,
        answered INTEGER NOT NULL DEFAULT 0, answers TEXT NOT NULL, site TEXT NOT NULL DEFAULT 'akhielesh.com')`,
    )
    .run();
  for (const table of ['agent_visits', 'agent_checkins']) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN site TEXT NOT NULL DEFAULT 'akhielesh.com'`).run();
    } catch {
      // Column already exists.
    }
  }
  schemaReady = true;
}

const LOGGED_HEADERS = ['accept', 'accept-language', 'from', 'referer', 'signature-agent', 'signature-input', 'via', 'sec-ch-ua', 'sec-ch-ua-platform'];

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

export function clientIp(request: Request): string {
  return clean(request.headers.get('cf-connecting-ip') ?? '', 64) || 'unknown';
}

/** At most `limit` rows per IP per hour in `table`, so a busy crawler can't flood the log. */
async function underLimit(db: D1Like, table: 'agent_visits' | 'agent_checkins', ip: string, limit: number): Promise<boolean> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ip = ? AND created_at >= ?`).bind(ip, since).first<{ n: number }>();
  return Number(row?.n ?? 0) < limit;
}

export async function logVisit(db: D1Like | undefined, request: Request, agent: AgentMatch | null, visitId: string, canary: string, path: string) {
  if (!db) return;
  try {
    await ensureSchema(db);
    const ip = clientIp(request);
    if (!(await underLimit(db, 'agent_visits', ip, 60))) return;
    const headers: Record<string, string> = {};
    for (const name of LOGGED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value.slice(0, 300);
    }
    const cf = ((request as Request & { cf?: Record<string, unknown> }).cf ?? {}) as Record<string, unknown>;
    await db
      .prepare(
        'INSERT INTO agent_visits (id, created_at, path, agent_name, agent_kind, reason, user_agent, ip, country, asn, as_org, canary, headers, site) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        visitId,
        new Date().toISOString(),
        clean(path, 300) || '/',
        agent?.name ?? 'self-identified',
        agent?.kind ?? 'unknown',
        agent?.reason ?? 'visited the check-in page',
        clean(request.headers.get('user-agent'), 400),
        ip,
        clean(cf.country, 8),
        cf.asn !== undefined ? String(cf.asn).slice(0, 16) : '',
        clean(cf.asOrganization, 120),
        canary,
        JSON.stringify(headers),
        SITE,
      )
      .run();
    if (Math.random() < 0.02) {
      await db.prepare('DELETE FROM agent_visits WHERE created_at < ?').bind(new Date(Date.now() - 90 * 86400_000).toISOString()).run();
    }
  } catch {
    // Logging must never break the response.
  }
}

/** Accepts `{ visitId?, answers: { q1: "…" } }` (JSON) or the HTML form. Unknown keys are dropped; answers are capped. */
export function parseAnswers(raw: Record<string, unknown>): { visitId: string; answers: Record<string, string> } {
  const source = raw.answers && typeof raw.answers === 'object' ? (raw.answers as Record<string, unknown>) : raw;
  const answers: Record<string, string> = {};
  for (const q of AGENT_QUESTIONS) {
    const value = source[q.id];
    if (typeof value === 'string' && value.trim()) answers[q.id] = value.replace(/\u0000/g, '').trim().slice(0, 2000);
  }
  const visitId = typeof raw.visitId === 'string' && /^[a-z0-9-]{8,64}$/i.test(raw.visitId) ? raw.visitId : '';
  return { visitId, answers };
}

/** Returns false when the IP is over its hourly check-in budget. */
export async function storeCheckin(db: D1Like | undefined, request: Request, agent: AgentMatch | null, visitId: string, answers: Record<string, string>): Promise<boolean> {
  if (!db) return true;
  await ensureSchema(db);
  const ip = clientIp(request);
  if (!(await underLimit(db, 'agent_checkins', ip, 10))) return false;
  await db
    .prepare('INSERT INTO agent_checkins (id, visit_id, created_at, agent_name, user_agent, ip, answered, answers, site) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      crypto.randomUUID(),
      visitId || null,
      new Date().toISOString(),
      agent?.name ?? 'unidentified',
      clean(request.headers.get('user-agent'), 400),
      ip,
      Object.keys(answers).length,
      JSON.stringify(answers),
      SITE,
    )
    .run();
  return true;
}
