// @vitest-environment node
// EGRESS-DB follow-up: what the app does with the result of opening a comic from the library. Only a comic whose
// full state did not load keeps the app where it is; a comic that loaded but could not sign its images still opens.
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import { ProjectStateLoadError, isProjectStateLoadError, resolveProjectOpen } from './projectOpen';

const project = (id: string) => ({ id, name: 'Comic', state: {} }) as unknown as Project;

describe('resolveProjectOpen', () => {
  it('opens the hydrated comic and never reads the copy in memory', async () => {
    const hydrated = project('c1');
    const current = vi.fn(() => project('stale'));
    await expect(resolveProjectOpen(async () => hydrated, current)).resolves.toEqual({ outcome: 'opened', project: hydrated });
    expect(current).not.toHaveBeenCalled();
  });

  it('a comic that is no longer listed still resolves (the caller routes off nothing, as before)', async () => {
    await expect(resolveProjectOpen(async () => undefined, () => undefined)).resolves.toEqual({ outcome: 'opened', project: undefined });
  });

  it('STAYS when the full state did not load: no project is handed back to open', async () => {
    const current = vi.fn(() => project('card'));
    const failed = () => Promise.reject(new ProjectStateLoadError('c1', { code: '57014' }));
    const result = await resolveProjectOpen(failed, current);
    expect(result).toEqual({ outcome: 'stayed' });
    expect('project' in result).toBe(false);
    expect(current).not.toHaveBeenCalled();
  });

  it('opens best-effort from the copy in memory when only the image signing failed', async () => {
    const inMemory = project('c1');
    const result = await resolveProjectOpen(() => Promise.reject(new Error('sign failed')), () => inMemory);
    expect(result).toEqual({ outcome: 'opened-best-effort', project: inMemory });
  });

  it('never rejects, whatever the open throws', async () => {
    for (const thrown of [new Error('x'), 'a string', undefined, { code: 'PGRST301' }]) {
      await expect(resolveProjectOpen(() => Promise.reject(thrown), () => undefined)).resolves.toEqual({ outcome: 'opened-best-effort', project: undefined });
    }
  });
});

describe('ProjectStateLoadError', () => {
  it('names the comic, keeps the cause, and is told apart from any other error', () => {
    const cause = { code: '57014', message: 'statement timeout' };
    const error = new ProjectStateLoadError('c1', cause, "Couldn't load this comic. Try again.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProjectStateLoadError');
    expect(error.projectId).toBe('c1');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Couldn't load this comic. Try again.");
    expect(isProjectStateLoadError(error)).toBe(true);
    for (const other of [new Error('x'), cause, null, undefined, 'ProjectStateLoadError']) expect(isProjectStateLoadError(other)).toBe(false);
  });
});
