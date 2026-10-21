// ============================================================================
// Connector registration — the ONE place you add a connector
// ============================================================================
//
// Adding a connector is: implement AccountConnector (see connectors/*.ts) and add a
// single line to the registerAll() call below. Nothing in core routing, the DB
// schema, the sync runner, or the UI shell needs editing.
// ============================================================================

import { connectorRegistry } from './registry.js';
import { upsertCatalog } from './store.js';
import { GmailConnector } from './connectors/gmail.js';
import { GoogleDriveConnector } from './connectors/googleDrive.js';
import { GoogleDriveSaveConnector } from './connectors/googleDriveSave.js';
import { GoogleCalendarConnector } from './connectors/googleCalendar.js';
import { GoogleSheetsConnector } from './connectors/googleSheets.js';
import { YouTubeConnector } from './connectors/youtube.js';
import { GoogleMapsConnector } from './connectors/googleMaps.js';

// Google Suite (per-user OAuth, one consent for the whole group) + Google Maps (API key).
// Adding a connector = one line here.
connectorRegistry.registerAll([
  new GmailConnector(),
  new GoogleDriveConnector(),
  // Stream Studio "save recordings to Drive" — write-only, drive.file scope (the app sees
  // only the files it creates). Separate from the read-only Drive connector above.
  new GoogleDriveSaveConnector(),
  new GoogleCalendarConnector(),
  new GoogleSheetsConnector(),
  new YouTubeConnector(),
  new GoogleMapsConnector()
]);

export { connectorRegistry };

let seeded = false;

/** Persist code-defined connectors into the catalog table (idempotent, once per boot). */
export const seedConnectorCatalog = async (): Promise<void> => {
  if (seeded) return;
  seeded = true;
  try {
    await upsertCatalog(connectorRegistry.catalog());
  } catch (err) {
    // Catalog seeding is best-effort; the API still serves the in-memory catalog.
    seeded = false;
    console.warn('[connectors] catalog seed skipped:', (err as Error)?.message);
  }
};
