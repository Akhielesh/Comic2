import { beforeEach, describe, expect, it } from 'vitest';
import { PATH_TIP } from '../costCopy';
import { pathTip, viewerPath } from './monitorUsage';

/**
 * The monitor's path pill tooltip. A nursery's relay data is parent-only (the room answers
 * 'forbidden' to caregivers, viewers and guests), so the tooltip adds the figure a parent's
 * read left on this device only for a parent — never for someone else watching on it.
 */
const NOW = Date.now();
const month = new Date(NOW).toISOString().slice(0, 7);

describe('pathTip', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('ds-usage-relay-n1', JSON.stringify({ month, bytes: 2.1e9, limitGb: 10, measured: true }));
  });

  it('a parent on our relay sees this month’s relay data', () => {
    expect(pathTip('turn', 'n1', true)).toBe(`${PATH_TIP.turn} Relay data this month: 2.1 GB of 10 GB.`);
  });

  it('a viewer, caregiver or share-link guest on the same device does not', () => {
    expect(pathTip('turn', 'n1', false)).toBe(PATH_TIP.turn);
    expect(pathTip('turn', 'n1', false)).not.toMatch(/GB/);
  });

  it('other paths: just what the path means', () => {
    expect(pathTip('lan', 'n1', true)).toBe(PATH_TIP.lan);
    expect(pathTip('server', 'n1', true)).toBe(PATH_TIP.server);
    expect(pathTip(null, 'n1', false)).toBe(PATH_TIP.direct);
  });
});

describe('viewerPath', () => {
  it('the direct link when it’s up, else the server picture while it draws, else none', () => {
    expect(viewerPath({ linkState: 'connected', netPath: 'relay', relayOn: true, relayDrawing: true })).toBe('turn');
    expect(viewerPath({ linkState: 'failed', netPath: null, relayOn: true, relayDrawing: true })).toBe('server');
    expect(viewerPath({ linkState: 'failed', netPath: null, relayOn: true, relayDrawing: false })).toBeNull();
  });
});
