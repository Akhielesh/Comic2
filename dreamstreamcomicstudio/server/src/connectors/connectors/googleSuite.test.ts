import { describe, it, expect } from 'vitest';
import { GoogleDriveConnector } from './googleDrive.js';
import { GoogleCalendarConnector } from './googleCalendar.js';
import { GoogleSheetsConnector } from './googleSheets.js';
import { YouTubeConnector } from './youtube.js';

describe('Google suite — grouping + normalize', () => {
  it('all four OAuth connectors are in the google provider group', () => {
    for (const c of [new GoogleDriveConnector(), new GoogleCalendarConnector(), new GoogleSheetsConnector(), new YouTubeConnector()]) {
      expect(c.metadata.authType).toBe('user_oauth');
      expect(c.metadata.providerGroup).toBe('google');
      expect(c.metadata.requiredScopes.length).toBeGreaterThan(0);
    }
  });

  it('Drive maps a file to a document', () => {
    const items = new GoogleDriveConnector().normalize({
      id: 'f1',
      name: 'Budget.xlsx',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      modifiedTime: '2026-01-02T03:04:05Z',
      webViewLink: 'https://drive/f1',
      owners: [{ displayName: 'Alice' }],
      size: '2048'
    });
    expect(items[0]).toMatchObject({
      kind: 'document',
      externalId: 'f1',
      title: 'Budget.xlsx',
      author: 'Alice',
      url: 'https://drive/f1',
      occurredAt: '2026-01-02T03:04:05Z'
    });
    expect(items[0].payload).toMatchObject({ size: 2048 });
  });

  it('Calendar maps an event and drops cancelled ones', () => {
    const ev = {
      id: 'e1',
      summary: 'Standup',
      location: 'Room 1',
      htmlLink: 'https://cal/e1',
      start: { dateTime: '2026-01-02T09:00:00Z' },
      end: { dateTime: '2026-01-02T09:30:00Z' },
      attendees: [{ email: 'a@x' }, { email: 'b@x' }],
      organizer: { displayName: 'Bob' }
    };
    const items = new GoogleCalendarConnector().normalize(ev);
    expect(items[0]).toMatchObject({ kind: 'event', externalId: 'e1', title: 'Standup', occurredAt: '2026-01-02T09:00:00Z' });
    expect(items[0].payload).toMatchObject({ attendees: 2, location: 'Room 1' });
    expect(new GoogleCalendarConnector().normalize({ id: 'e2', status: 'cancelled' })).toEqual([]);
  });

  it('Sheets maps rows to records keyed by header row', () => {
    const items = new GoogleSheetsConnector().normalize({
      spreadsheetId: 'sheet1',
      range: 'A1:C3',
      values: [
        ['Name', 'Age', 'City'],
        ['Alice', '30', 'NYC'],
        ['Bob', '25', 'LA']
      ]
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'record', title: 'Alice' });
    expect(items[0].payload).toMatchObject({ fields: { Name: 'Alice', Age: '30', City: 'NYC' } });
  });

  it('Sheets is query-on-demand (not syncable)', () => {
    expect(new GoogleSheetsConnector().metadata.capabilities.syncable).toBe(false);
  });

  it('YouTube maps a playlist item to a video document', () => {
    const items = new YouTubeConnector().normalize({
      contentDetails: { videoId: 'vid123', videoPublishedAt: '2026-01-01T00:00:00Z' },
      snippet: { title: 'My Video', description: 'desc', videoOwnerChannelTitle: 'My Channel', thumbnails: { medium: { url: 'https://t/medium.jpg' } } }
    });
    expect(items[0]).toMatchObject({
      kind: 'document',
      externalId: 'vid123',
      title: 'My Video',
      url: 'https://www.youtube.com/watch?v=vid123',
      author: 'My Channel',
      occurredAt: '2026-01-01T00:00:00Z'
    });
    expect(new YouTubeConnector().normalize({ snippet: { title: 'no video id' } })).toEqual([]);
  });
});
