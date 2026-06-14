// ============================================================================
// ConnectorRegistry — discovery + lookup for every connector
// ============================================================================
//
// Adding a connector = implement AccountConnector + register the instance here (one
// line in connectors/index.ts). Core routing, the DB schema, the sync runner and the
// UI shell are all driven off this registry, so none of them change.
// ============================================================================

import type { AccountConnector, ConnectorMetadata } from './types.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, AccountConnector>();

  /** Register a connector. Throws on a duplicate id so collisions fail loudly at boot. */
  register(connector: AccountConnector): this {
    const id = connector.metadata.id;
    if (!id || !/^[a-z0-9_]+$/.test(id)) {
      throw new Error(`Connector id "${id}" must be lowercase snake_case`);
    }
    if (this.connectors.has(id)) {
      throw new Error(`Connector "${id}" is already registered`);
    }
    this.connectors.set(id, connector);
    return this;
  }

  /** Register many at once (used by connectors/index.ts and tests). */
  registerAll(connectors: AccountConnector[]): this {
    for (const c of connectors) this.register(c);
    return this;
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  get(id: string): AccountConnector | undefined {
    return this.connectors.get(id);
  }

  /** Get or throw — for code paths where a missing connector is a programmer/data error. */
  require(id: string): AccountConnector {
    const c = this.connectors.get(id);
    if (!c) throw new Error(`Unknown connector "${id}"`);
    return c;
  }

  list(): AccountConnector[] {
    return [...this.connectors.values()];
  }

  /** The catalog metadata for every registered connector. */
  catalog(): ConnectorMetadata[] {
    return this.list().map((c) => c.metadata);
  }

  /** Connectors that materialize items via background sync. */
  syncable(): AccountConnector[] {
    return this.list().filter((c) => c.metadata.capabilities.syncable);
  }
}

/** The process-wide registry, populated in connectors/index.ts. */
export const connectorRegistry = new ConnectorRegistry();
