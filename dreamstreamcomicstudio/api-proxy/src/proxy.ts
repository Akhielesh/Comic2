/**
 * dreamstream-api — same-origin front door for the DreamStream backend.
 *
 * Forwards dreamstreamstudio.ai/api/* to the backend verbatim: method, path,
 * query, headers and body pass through untouched, and the response streams
 * back (SSE chat streaming included).
 *
 * Where the backend runs (BACKEND_TARGET):
 *   "container" (default) — the Backend Cloudflare Container (backend.ts),
 *                           reached through its Durable Object binding.
 *   "origin"              — any public URL in BACKEND_ORIGIN (the Railway
 *                           service, kept dormant for a possible return).
 * Switching back is one var change + deploy; see docs/infrastructure/INFRA_MAP.md.
 *
 * The original client IP rides X-Forwarded-For (from CF-Connecting-IP) so
 * the backend's per-IP rate limiting keys on real visitors, not this
 * worker's egress IPs.
 *
 * Agent gate (see agent-gate.ts): AI agents are answered here at the edge and
 * never reach (or wake) the backend:
 *   GET  /api/agent-gate           the check-in page (the Pages middleware sends agents here)
 *   GET  /api/agent-gate/checkin   the 50 questions + a synthetic sample record, as JSON
 *   POST /api/agent-gate/checkin   answers (JSON or the HTML form)
 * (Not /api/agents — that is the product's own custom-agents API on the backend.)
 *   any other /api/* from an AI agent → 403 with a pointer to the check-in.
 */
import { AGENT_HEADERS, AGENT_POLICY, AGENT_QUESTIONS, AGENT_TIER_LABELS, buildDecoy, detectAgent, newCanary, renderGateHtml } from './agent-gate';
import { logVisit, parseAnswers, storeCheckin, type D1Like } from './agent-log';

/** The slice of a Durable Object namespace the proxy needs to reach the Backend container. */
export interface BackendNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

interface Env {
  /** "container" (default) or "origin". */
  BACKEND_TARGET?: string;
  /** Public origin of an external backend (Railway), used when BACKEND_TARGET is "origin". */
  BACKEND_ORIGIN?: string;
  /** The Backend container's Durable Object binding. */
  BACKEND?: BackendNamespace;
  /** Optional: the owner's agent log (shared D1). Without it the gate still works, it just doesn't log. */
  AGENT_DB?: D1Like;
}

/** Every request goes to the same instance — the single replica the Railway service had. */
const BACKEND_INSTANCE = 'primary';

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const GATE_PATH = '/api/agent-gate';
const CHECKIN_PATH = '/api/agent-gate/checkin';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...AGENT_HEADERS } });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type') ?? '';
  const text = await req.text();
  if (text.length > 120_000) throw new Error('too large');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  const parsed = JSON.parse(text || '{}') as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

async function handleAgents(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  const agent = detectAgent(req, 'page');
  const checkinUrl = `${url.origin}${CHECKIN_PATH}`;

  if (url.pathname === GATE_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
    const visitId = crypto.randomUUID();
    const canary = newCanary();
    const from = url.searchParams.get('from') ?? GATE_PATH;
    // Only agents (and browsers the tripwire flagged) are logged — a person opening this page leaves no record.
    if (agent || url.searchParams.get('via') === 'webdriver') ctx.waitUntil(logVisit(env.AGENT_DB, req, agent, visitId, canary, from));
    const html = renderGateHtml({ agent, canary, visitId, checkinUrl });
    return new Response(req.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8', ...AGENT_HEADERS } });
  }

  if (url.pathname === CHECKIN_PATH && req.method === 'GET') {
    return json({
      policy: AGENT_POLICY,
      instructions: `POST ${checkinUrl} with {"visitId": "<optional>", "answers": {"q1": "…"}}. Answer as many as you can; stopping is fine.`,
      tiers: AGENT_TIER_LABELS,
      questions: AGENT_QUESTIONS,
      sample: buildDecoy(newCanary()),
    });
  }

  if (url.pathname === CHECKIN_PATH && req.method === 'POST') {
    let raw: Record<string, unknown>;
    try {
      raw = await readBody(req);
    } catch {
      return json({ error: 'Send JSON or a form, under 120 KB.' }, 400);
    }
    const { visitId, answers } = parseAnswers(raw);
    const count = Object.keys(answers).length;
    if (!count) return json({ error: 'No answers found. Use keys q1 … q50.' }, 422);
    let stored = true;
    try {
      stored = await storeCheckin(env.AGENT_DB, req, agent, visitId, answers);
    } catch {
      // Still thank the agent; the log is best-effort.
    }
    if (!stored) return json({ error: 'Too many check-ins from this address. Try again later.' }, 429);
    const message = `Thank you — ${count} of 50 answers recorded. Nothing in DreamStream Studio is available to automated agents.`;
    if ((req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
      return new Response(`<!doctype html><meta charset="utf-8"><title>Thank you</title><p>${message}</p>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', ...AGENT_HEADERS },
      });
    }
    return json({ ok: true, answered: count, message, sample: buildDecoy(newCanary()) });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === GATE_PATH || url.pathname.startsWith(`${GATE_PATH}/`)) return handleAgents(req, env, ctx, url);

    // AI agents never reach the backend: they get a pointer to the check-in instead.
    const agent = detectAgent(req, 'api');
    if (agent) {
      ctx.waitUntil(logVisit(env.AGENT_DB, req, agent, crypto.randomUUID(), newCanary(), url.pathname));
      return json(
        { error: 'Automated AI agents may not use the DreamStream API.', checkin: `${url.origin}${GATE_PATH}`, questions: `${url.origin}${CHECKIN_PATH}` },
        403,
      );
    }

    const headers = new Headers(req.headers);
    const clientIp = req.headers.get('CF-Connecting-IP');
    if (clientIp) {
      headers.set('X-Forwarded-For', clientIp);
      headers.set('X-Real-IP', clientIp);
    }
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', 'https');

    const wantsOrigin = (env.BACKEND_TARGET ?? 'container').trim().toLowerCase() === 'origin';
    try {
      if (!wantsOrigin && env.BACKEND) {
        const backend = env.BACKEND.get(env.BACKEND.idFromName(BACKEND_INSTANCE));
        return await backend.fetch(new Request(req, { headers, redirect: 'manual' }));
      }
      if (env.BACKEND_ORIGIN) {
        const target = new URL(env.BACKEND_ORIGIN.replace(/\/$/, '') + url.pathname + url.search);
        return await fetch(target.toString(), {
          method: req.method,
          headers,
          body: req.body,
          redirect: 'manual',
        });
      }
      return unreachable('No backend is configured for the API proxy', 503);
    } catch {
      return unreachable('Backend unreachable through the API proxy', 502);
    }
  },
};

function unreachable(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', 'retry-after': '5', 'cache-control': 'no-store' },
  });
}
