import { describe, it, expect, beforeEach } from 'vitest';
import { appStatus, __resetAppStatus } from './appStatus';

beforeEach(() => __resetAppStatus());

describe('appStatus store', () => {
  it('records events newest-first and exposes a stable snapshot between changes', () => {
    appStatus.report('info', 'first');
    const snap1 = appStatus.getSnapshot();
    appStatus.report('error', 'second');
    const snap2 = appStatus.getSnapshot();

    expect(snap2.events.map((e) => e.message)).toEqual(['second', 'first']);
    expect(snap2).not.toBe(snap1); // new reference on change
    expect(appStatus.getSnapshot()).toBe(snap2); // stable until next change
  });

  it('coalesces identical consecutive events into a single counted entry', () => {
    appStatus.report('warn', 'flaky load');
    appStatus.report('warn', 'flaky load');
    appStatus.report('warn', 'flaky load');
    const { events } = appStatus.getSnapshot();
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(3);
  });

  it('tracks unseen warn/error count + worst level, and clears it on markSeen', () => {
    appStatus.report('info', 'fyi'); // info never counts as unseen
    appStatus.report('warn', 'heads up');
    appStatus.report('error', 'boom');
    let snap = appStatus.getSnapshot();
    expect(snap.unseen).toBe(2);
    expect(snap.worstUnseen).toBe('error');

    appStatus.markSeen();
    snap = appStatus.getSnapshot();
    expect(snap.unseen).toBe(0);
    expect(snap.worstUnseen).toBeNull();
  });

  it('tracks in-flight activities and the most recent label', () => {
    const a = appStatus.begin('Connecting Gmail…');
    const b = appStatus.begin('Syncing Drive…');
    let snap = appStatus.getSnapshot();
    expect(snap.activeCount).toBe(2);
    expect(snap.activeLabel).toBe('Syncing Drive…');

    appStatus.end(b);
    snap = appStatus.getSnapshot();
    expect(snap.activeCount).toBe(1);
    expect(snap.activeLabel).toBe('Connecting Gmail…');

    appStatus.end(a);
    expect(appStatus.getSnapshot().activeCount).toBe(0);
  });

  it('notifies subscribers and clear() empties the log', () => {
    let hits = 0;
    const unsub = appStatus.subscribe(() => hits++);
    appStatus.report('error', 'x');
    expect(hits).toBeGreaterThan(0);
    appStatus.clear();
    expect(appStatus.getSnapshot().events).toHaveLength(0);
    unsub();
  });

  it('ignores empty messages and caps the log length', () => {
    appStatus.report('info', '   ');
    expect(appStatus.getSnapshot().events).toHaveLength(0);
    for (let i = 0; i < 80; i++) appStatus.report('info', `event ${i}`);
    expect(appStatus.getSnapshot().events.length).toBeLessThanOrEqual(60);
  });
});
