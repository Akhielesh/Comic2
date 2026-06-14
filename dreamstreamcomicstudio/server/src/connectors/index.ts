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
import { GoogleMapsConnector } from './connectors/googleMaps.js';

// v1 slice: Gmail (per-user OAuth) + Google Maps (API key) — two auth models, one path.
connectorRegistry.registerAll([new GmailConnector(), new GoogleMapsConnector()]);

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
