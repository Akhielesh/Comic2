// Code Studio sessions — every NEW project gets a stable, client-generated project id + session id,
// stored in a local registry so identity exists from the moment of creation (not only after the
// server's first build) and survives reloads. Pure + dependency-free so it's unit-testable.

export interface StudioSession {
  /** Stable id for the project (the workspace + chat-history key). */
  projectId: string;
  /** Id for THIS editing session of the project. */
  sessionId: string;
  /** Short human tag, e.g. "proj_8f3a1c2d · sess_1b2c3d4e". */
  tag: string;
  createdAt: string;
}

const STORAGE = 'dreamstream_studio_sessions';
const MAX_SESSIONS = 200;

const rid = (prefix: string): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function') {
      return `${prefix}_${(crypto as Crypto).randomUUID()}`;
    }
  } catch { /* fall through to the non-crypto path */ }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

const short = (id: string): string => (id.split('_').pop() ?? id).replace(/-/g, '').slice(0, 8);
const tagOf = (projectId: string, sessionId: string): string => `proj_${short(projectId)} · sess_${short(sessionId)}`;

const readAll = (): StudioSession[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as StudioSession[]) : [];
  } catch {
    return [];
  }
};

const writeAll = (list: StudioSession[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(list.slice(-MAX_SESSIONS)));
  } catch { /* quota / unavailable — non-fatal */ }
};

const persist = (session: StudioSession): StudioSession => {
  writeAll([...readAll(), session]);
  return session;
};

/** Create + persist a brand-new project identity (new project id + session id). */
export const createStudioSession = (): StudioSession => {
  const projectId = rid('proj');
  const sessionId = rid('sess');
  return persist({ projectId, sessionId, tag: tagOf(projectId, sessionId), createdAt: new Date().toISOString() });
};

/** Start (and persist) a fresh session for an EXISTING project — e.g. reopening it later. */
export const startSessionForProject = (projectId: string): StudioSession => {
  const sessionId = rid('sess');
  return persist({ projectId, sessionId, tag: tagOf(projectId, sessionId), createdAt: new Date().toISOString() });
};

/** All stored sessions, oldest first. */
export const listStudioSessions = (): StudioSession[] => readAll();
