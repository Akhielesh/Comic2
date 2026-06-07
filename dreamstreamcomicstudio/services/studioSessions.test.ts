import { describe, it, expect, beforeEach } from 'vitest';
import { createStudioSession, startSessionForProject, listStudioSessions } from './studioSessions';

beforeEach(() => { try { window.localStorage.clear(); } catch { /* jsdom */ } });

describe('studioSessions', () => {
  it('creates a project + session id with a readable tag and persists it', () => {
    const s = createStudioSession();
    expect(s.projectId).toMatch(/^proj_/);
    expect(s.sessionId).toMatch(/^sess_/);
    expect(s.tag).toContain('proj_');
    expect(s.tag).toContain('sess_');
    expect(s.createdAt).toBeTruthy();
    expect(listStudioSessions().some((x) => x.projectId === s.projectId)).toBe(true);
  });

  it('generates unique ids on each call and stores both', () => {
    const a = createStudioSession();
    const b = createStudioSession();
    expect(a.projectId).not.toBe(b.projectId);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(listStudioSessions().length).toBe(2);
  });

  it('startSessionForProject keeps the project id but mints a fresh session id', () => {
    const a = createStudioSession();
    const b = startSessionForProject(a.projectId);
    expect(b.projectId).toBe(a.projectId);
    expect(b.sessionId).not.toBe(a.sessionId);
  });
});
