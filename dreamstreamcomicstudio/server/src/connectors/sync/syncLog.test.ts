import { describe, it, expect, vi, afterEach } from 'vitest';

// Force color OFF so the events route through the structured logger (deterministic, no TTY/ANSI).
vi.mock('../../config.js', () => ({ CONNECTORS_SYNC_COLOR: false, CONNECTORS_SYNC_DEBUG: 'off' }));

import {
  kindSummary,
  formatKinds,
  logPageStart,
  logPageDone,
  logReconnect,
  logError,
  logRunStart,
  logRunEnd,
  logNote
} from './syncLog.js';
import type { NormalizedItem } from '../types.js';

afterEach(() => vi.restoreAllMocks());

describe('kindSummary', () => {
  it('counts items by kind, defaulting missing kinds to "unknown"', () => {
    const items = [{ kind: 'document' }, { kind: 'document' }, { kind: 'event' }, {}];
    expect(kindSummary(items as NormalizedItem[])).toEqual({ document: 2, event: 1, unknown: 1 });
  });

  it('is empty for no items', () => {
    expect(kindSummary([])).toEqual({});
  });
});

describe('formatKinds', () => {
  it('pluralizes and joins', () => {
    expect(formatKinds({ document: 48, event: 1 })).toBe('48 documents, 1 event');
  });

  it('says "nothing" when empty', () => {
    expect(formatKinds({})).toBe('nothing');
  });
});

describe('event helpers (color off → structured logger, never throw)', () => {
  const tag = { connectorId: 'gmail', account: 'a@b.com', connectionId: 'conn-12345678', mode: 'full' };

  it('logs a page lifecycle without throwing', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logPageStart({ ...tag, cursorIn: { pageToken: 'P2' } });
    logPageDone({
      ...tag,
      items: [{ kind: 'document', externalId: '1', title: 'Hi' }] as NormalizedItem[],
      written: 1,
      hasMore: true,
      cursorOut: { pageToken: 'P3' },
      total: 51,
      ms: 1234
    });
    expect(info).toHaveBeenCalled();
  });

  it('routes auth failures to warn and transient errors to error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logReconnect({ ...tag, message: 'revoked' });
    logError({ ...tag, message: '429', willRetry: true });
    expect(warn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('logs the inline run, surfacing the capped outcome as a warning', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logRunStart({ connectionId: tag.connectionId, mode: 'auto', maxPages: 8 });
    logRunEnd({ connectionId: tag.connectionId, mode: 'auto', outcome: 'capped', pages: 8, total: 400, ms: 5000 });
    logNote('connector_worker_ready', 'ready', 'info');
    expect(info).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled(); // 'capped' is a warn-level run end
  });
});
