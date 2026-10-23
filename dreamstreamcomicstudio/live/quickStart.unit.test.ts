import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraErrorMessage, cameraProblem } from './media';
import { guestUrl, isMeetingGuestLink } from './nav';
import {
  INTENT_TTL_MS,
  autoTitle,
  firstName,
  loadAdvancedOpen,
  quickDefaultsLine,
  requestScheduleOnCreate,
  saveAdvancedOpen,
  setStudioIntent,
  shareOrCopy,
  takeScheduleRequest,
  takeStudioIntent,
} from './quickStart';

const OCT_22 = new Date(2026, 9, 22, 9, 30).getTime();

describe('quick start · auto titles', () => {
  it('names a meeting or a live after the host’s first name and the day', () => {
    expect(autoTitle('meeting', 'Akhil', OCT_22)).toBe('Akhil’s meeting · Oct 22');
    expect(autoTitle('live', 'Akhil Srirangam', OCT_22)).toBe('Akhil’s live · Oct 22');
  });

  it('falls back to a plain title without a name', () => {
    expect(autoTitle('meeting', '', OCT_22)).toBe('Meeting · Oct 22');
    expect(autoTitle('live', '   ', OCT_22)).toBe('Live · Oct 22');
    expect(autoTitle('live', null, OCT_22)).toBe('Live · Oct 22');
  });

  it('keeps titles short even for very long names', () => {
    expect(firstName('X'.repeat(200)).length).toBeLessThanOrEqual(40);
    expect(autoTitle('meeting', 'X'.repeat(200), OCT_22).length).toBeLessThanOrEqual(120);
  });

  it('summarises the defaults a quick start will use', () => {
    expect(quickDefaultsLine({ quality: '720p', access: 'open', maxViewers: 100, autoRecord: false })).toBe(
      '720p · Anyone with the link · up to 100 viewers · not recording',
    );
    expect(quickDefaultsLine({ quality: '1080p', access: 'approval', maxViewers: 50, autoRecord: true })).toMatch(/approve each viewer.*up to 50.*recording to this device/);
  });
});

describe('quick start · studio intent hand-off', () => {
  beforeEach(() => sessionStorage.clear());

  it('is one-shot: the studio acts on it once, a reload never repeats it', () => {
    setStudioIntent('ev1', 'live', 1000);
    expect(takeStudioIntent('ev1', 2000)).toBe('live');
    expect(takeStudioIntent('ev1', 2000)).toBeNull();
  });

  it('is per event and ignores stale or malformed notes', () => {
    setStudioIntent('a', 'meeting', 1000);
    expect(takeStudioIntent('b', 1000)).toBeNull();
    expect(takeStudioIntent('a', 1000 + INTENT_TTL_MS + 1)).toBeNull();
    sessionStorage.setItem('ds-live-intent:c', '{"intent":"party","at":1}');
    expect(takeStudioIntent('c', 2)).toBeNull();
    sessionStorage.setItem('ds-live-intent:d', 'not json');
    expect(takeStudioIntent('d', 2)).toBeNull();
  });

  it('never lives in the URL', () => {
    setStudioIntent('ev2', 'meeting');
    expect(location.href).not.toContain('meeting');
    expect(location.href).not.toContain('intent');
  });

  it('remembers Advanced and passes "Schedule…" through once', () => {
    localStorage.clear();
    expect(loadAdvancedOpen()).toBe(false);
    saveAdvancedOpen(true);
    expect(loadAdvancedOpen()).toBe(true);
    requestScheduleOnCreate();
    expect(takeScheduleRequest()).toBe(true);
    expect(takeScheduleRequest()).toBe(false);
  });
});

describe('quick start · meeting guest links', () => {
  it('flags meeting invites in the fragment, beside the key', () => {
    const u = new URL(guestUrl('abc123', 'guest-key', { meeting: true }));
    expect(u.searchParams.has('m')).toBe(false); // never sent to servers
    const hp = new URLSearchParams(u.hash.split('?')[1]);
    expect(hp.get('g')).toBe('guest-key');
    expect(hp.get('m')).toBe('1');
    expect(isMeetingGuestLink(u.hash)).toBe(true);
    expect(isMeetingGuestLink(new URL(guestUrl('abc123', 'guest-key')).hash)).toBe(false);
  });

  it('leaves route parsing unchanged for a meeting invite', async () => {
    const { parseRoute } = await import('./LiveApp');
    history.replaceState(null, '', '/live.html?e=abc123#/guest?g=guest-key&m=1');
    expect(parseRoute()).toEqual({ view: 'guest', id: 'abc123', g: 'guest-key' });
    history.replaceState(null, '', '/live.html');
  });
});

describe('quick start · camera errors in plain words', () => {
  const err = (name: string) => Object.assign(new Error('x'), { name });

  it('maps the browser’s error names to one fix each', () => {
    expect(cameraProblem(err('NotAllowedError'))).toBe('blocked');
    expect(cameraProblem(err('NotFoundError'))).toBe('missing');
    expect(cameraProblem(err('NotReadableError'))).toBe('busy');
    expect(cameraProblem(err('Weird'))).toBe('other');
    expect(cameraErrorMessage(err('NotAllowedError'))).toMatch(/blocked for this site.*Try again/);
    expect(cameraErrorMessage(err('NotFoundError'))).toMatch(/No camera found/);
    expect(cameraErrorMessage(err('NotReadableError'))).toMatch(/busy in another app/);
    expect(cameraErrorMessage(null)).toMatch(/Try again/);
  });
});

describe('quick start · share or copy', () => {
  const nav = navigator as Navigator & { share?: unknown; canShare?: unknown };
  afterEach(() => {
    delete nav.share;
    delete nav.canShare;
    vi.restoreAllMocks();
  });

  it('copies when there is no share sheet', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await shareOrCopy({ url: 'https://x.test/a' })).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://x.test/a');
  });

  it('uses the share sheet when there is one, and a dismissal is not a copy', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    nav.share = vi.fn(async () => undefined);
    expect(await shareOrCopy({ title: 't', url: 'https://x.test/b' })).toBe('shared');
    nav.share = vi.fn(async () => {
      throw Object.assign(new Error('dismissed'), { name: 'AbortError' });
    });
    expect(await shareOrCopy({ url: 'https://x.test/c' })).toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
    expect(await shareOrCopy({ url: 'https://x.test/d' }, { copyOnly: true })).toBe('copied');
  });
});
