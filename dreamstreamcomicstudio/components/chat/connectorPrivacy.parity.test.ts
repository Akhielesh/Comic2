// @vitest-environment node
// Parity: components/chat/connectorPrivacy.ts duplicates server constants, because the client bundle
// never imports server code. This test reads both sides, so a change on either one that the other
// does not follow fails here: the refusal code, the budget sentence the 402 carries, the clause both
// free-model refusals share, and the connector tool names and families.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as client from './connectorPrivacy';
import * as server from '../../server/src/ai/privacy/connectorData';
import { CONNECTOR_FREE_MODEL_REFUSED, connectorFreeModelRefusal } from '../../server/src/ai/privacy/openrouterPolicy';

const serverSource = readFileSync(
  fileURLToPath(new URL('../../server/src/ai/privacy/connectorData.ts', import.meta.url)),
  'utf8'
);

/** The server's private CONNECTOR_TOOL_PREFIXES literal, with its MCP spread resolved. */
const serverPrefixes = (): string[] => {
  const m = serverSource.match(/const CONNECTOR_TOOL_PREFIXES = \[([^\]]*)\]/);
  expect(m, 'server/src/ai/privacy/connectorData.ts still declares CONNECTOR_TOOL_PREFIXES').toBeTruthy();
  const body = m![1];
  const literals = Array.from(body.matchAll(/'([^']+)'/g), (x) => x[1]);
  const spread = body.includes('...CONNECTOR_MCP_TOOL_PREFIXES') ? [...server.CONNECTOR_MCP_TOOL_PREFIXES] : [];
  const rest = body.replace(/'[^']*'/g, '').replace('...CONNECTOR_MCP_TOOL_PREFIXES', '').replace(/[\s,]/g, '');
  expect(rest, 'every entry of the server prefix list is a literal or the MCP spread').toBe('');
  return [...literals, ...spread];
};

describe('connected-account privacy: client ↔ server parity', () => {
  it('the free-model refusal code', () => {
    expect(client.CONNECTED_DATA_FREE_MODEL_CODE).toBe(server.CONNECTED_DATA_FREE_MODEL_CODE);
    expect(client.CONNECTED_DATA_FREE_MODEL_CODE).toBe(CONNECTOR_FREE_MODEL_REFUSED);
  });

  it('the sentence a usage refusal carries when the free fallback is off for connected content', () => {
    expect(client.CONNECTED_DATA_BUDGET_SENTENCE).toBe(server.CONNECTED_DATA_BUDGET_SENTENCE);
  });

  it('the clause both free-model refusals share (the chat routes and the provider backstop, both copies)', () => {
    for (const freeOnly of [true, false]) {
      expect(server.connectedDataFreeModelMessage(freeOnly)).toContain(client.CONNECTED_DATA_REFUSAL_CLAUSE);
      expect(connectorFreeModelRefusal(freeOnly).publicMessage).toContain(client.CONNECTED_DATA_REFUSAL_CLAUSE);
      // Never in copy that is not a refusal.
      expect(server.connectedAccountsWithheldNotice(freeOnly)).not.toContain(client.CONNECTED_DATA_REFUSAL_CLAUSE);
    }
    expect(server.CONNECTED_DATA_BUDGET_SENTENCE).not.toContain(client.CONNECTED_DATA_REFUSAL_CLAUSE);
  });

  it('the connector tool names', () => {
    expect([...client.CONNECTOR_DATA_TOOL_NAMES].sort()).toEqual([...server.CONNECTOR_DATA_TOOL_NAMES].sort());
  });

  it('the connector tool families (prefixes), read from the server source', () => {
    expect([...client.CONNECTOR_TOOL_PREFIXES].sort()).toEqual(serverPrefixes().sort());
  });

  it('both sides answer the same for every name, known, future and foreign', () => {
    const names = [
      ...server.CONNECTOR_DATA_TOOL_NAMES,
      ...client.CONNECTOR_TOOL_PREFIXES.map((p) => `${p}future_tool`),
      ...serverPrefixes().map((p) => `${p}another`),
      'web_search',
      'run_python',
      'maps_route',
      'nango_list_integrations',
      'nango_connect_link',
      'mcp_3f2a9c1e-77aa-4c55-9b1d-0f4f2b6c9e10_search',
      'mcp_nango',
      '',
      'GMAIL_SEARCH'
    ];
    for (const name of names) expect(client.isConnectorToolName(name), name).toBe(server.isConnectorToolName(name));
    expect(client.isConnectorToolName(undefined)).toBe(server.isConnectorToolName(undefined));
    expect(client.isConnectorToolName(42)).toBe(server.isConnectorToolName(42));
  });

  it('the server reads the client marker: a marked reply, and a reply whose tool events name a connector tool', () => {
    const marked = { role: 'assistant', content: 'You have two meetings tomorrow.', ...client.connectorMarkerFor({ role: 'assistant', connectorData: true }) };
    expect(server.messageCarriesConnectorData(marked)).toBe(true);
    const viaTool = { role: 'assistant', content: 'Found it.', ...client.connectorMarkerFor({ role: 'assistant', toolEvents: [{ tool: 'drive_search' }] }) };
    expect(server.messageCarriesConnectorData(viaTool)).toBe(true);
    const plain = { role: 'assistant', content: 'Paris is the capital of France.', ...client.connectorMarkerFor({ role: 'assistant' }) };
    expect(server.messageCarriesConnectorData(plain)).toBe(false);
  });
});
