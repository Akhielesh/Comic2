// @vitest-environment node
// The connected-account predicate (Google Limited Use): every way connector content enters a model
// call flags the turn, and nothing else does. Parity tests tie the predicate to the real tool names,
// the real RAG block heading and the real tool-result wrappers, so a rename there fails here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../connectors/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/store.js')>()),
  queryItems: async () => [
    { connector_id: 'gmail', title: 'Lunch on Friday', snippet: 'See you at noon', content_text: null, occurred_at: '2026-11-01T10:00:00Z' }
  ]
}));

import {
  CONNECTED_ACCOUNTS_WITHHELD_NOTICE,
  CONNECTED_DATA_BUDGET_SENTENCE,
  CONNECTED_DATA_FREE_MODEL_MESSAGE,
  CONNECTOR_CONTEXT_HEADING,
  CONNECTOR_DATA_TOOL_NAMES,
  connectorDataSources,
  isConnectorToolName,
  isFreeModelId,
  messagesCarryConnectorData,
  turnUsesConnectorData,
  withoutConnectorTools
} from './connectorData.js';
import { routeForConnectorData, withDataCollectionDenied } from './openrouterPolicy.js';
import { bindConnectorPrivacy, connectorPrivacyActive, connectorPrivacyBound, runWithConnectorPrivacy } from './scope.js';
import { PROVIDER_PRIVACY_POLICIES } from './providerPolicies.js';
import { CONNECTOR_TOOL_NAMES } from '../tools/connectors.js';
import { KNOWN_TOOL_NAMES } from '../tools/registry.js';
import { spotlightToolOutput } from '../tools/spotlight.js';
import { formatToolResult } from '../tools/jsonToolProtocol.js';
import { buildConnectorContextBlock } from '../../connectors/retrieval.js';
import { TEXT_PROVIDER_IDS } from '../../../../shared/providers.js';

describe('connector tool names (parity with the real tools)', () => {
  it('every account-connector tool is a connector-data tool', () => {
    for (const name of CONNECTOR_TOOL_NAMES) expect(isConnectorToolName(name)).toBe(true);
    expect(CONNECTOR_DATA_TOOL_NAMES).toEqual(expect.arrayContaining(CONNECTOR_TOOL_NAMES));
  });

  it('the Nango proxy (any connected API) counts; its catalogue and connect-link tools do not', () => {
    expect(isConnectorToolName('nango_call_api')).toBe(true);
    expect(isConnectorToolName('nango_search_integrations')).toBe(false);
    expect(isConnectorToolName('nango_connect_integration')).toBe(false);
  });

  it('no other known tool is mistaken for a connector tool (the family prefixes stay exact)', () => {
    const flagged = KNOWN_TOOL_NAMES.filter(isConnectorToolName);
    expect(flagged.every((n) => CONNECTOR_DATA_TOOL_NAMES.includes(n))).toBe(true);
    for (const plain of ['web_search', 'get_weather', 'find_places', 'show_map', 'read_url', 'run_python', 'email_draft']) {
      expect(isConnectorToolName(plain)).toBe(false);
    }
  });

  it('a future tool in a connector family counts before the list is updated', () => {
    expect(isConnectorToolName('gmail_thread')).toBe(true);
    expect(isConnectorToolName('drive_read')).toBe(true);
  });
});

describe('turnUsesConnectorData: each entry path flags the turn', () => {
  it('a plain turn is not flagged', () => {
    expect(
      turnUsesConnectorData({
        toolNames: ['web_search', 'get_weather'],
        connectorContext: false,
        messages: [
          { role: 'user', content: 'Explain how tides work' },
          { role: 'assistant', content: 'The moon pulls the oceans…' },
          { role: 'tool', content: spotlightToolOutput('web_search', 'tides result') }
        ]
      })
    ).toBe(false);
    expect(connectorDataSources({})).toEqual([]);
  });

  it("'tools': a connector tool offered this turn (gmail_*, drive_*, calendar_*, sheets, maps, unified search, Nango)", () => {
    for (const name of CONNECTOR_DATA_TOOL_NAMES) {
      expect(connectorDataSources({ toolNames: ['web_search', name] })).toEqual(['tools']);
    }
  });

  it("'context': the connector RAG block may be injected", () => {
    expect(connectorDataSources({ connectorContext: true })).toEqual(['context']);
  });

  it("'history': an assistant turn that called a connector tool (the tool loop's own messages)", () => {
    const messages = [
      { role: 'user', content: 'what did my boss send me?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'gmail_search', arguments: '{}' } }] }
    ];
    expect(connectorDataSources({ messages })).toEqual(['history']);
  });

  it("'history': a connector tool's result as the engine feeds it back (spotlight) or the JSON protocol does", () => {
    expect(messagesCarryConnectorData([{ role: 'tool', tool_call_id: 'c1', content: spotlightToolOutput('drive_search', 'Q3 plan.docx') }])).toBe(true);
    expect(messagesCarryConnectorData([{ role: 'user', content: formatToolResult('calendar_agenda', 'Dentist 9am') }])).toBe(true);
    expect(messagesCarryConnectorData([{ role: 'user', content: formatToolResult('web_search', 'tides') }])).toBe(false);
  });

  it("'history': the real connector RAG block (as connectors/retrieval.ts builds it) in any message", async () => {
    const block = await buildConnectorContextBlock('user-1', 'lunch');
    expect(block).toContain(CONNECTOR_CONTEXT_HEADING);
    expect(messagesCarryConnectorData([{ role: 'system', content: `persona${block}` }])).toBe(true);
    expect(messagesCarryConnectorData([{ role: 'user', content: [{ type: 'text', text: String(block) }] }])).toBe(true);
  });

  it("'history': an explicit provenance marker on a prior assistant turn (connectorData, or toolEvents)", () => {
    expect(messagesCarryConnectorData([{ role: 'assistant', content: 'Your boss wrote…', connectorData: true }])).toBe(true);
    expect(messagesCarryConnectorData([{ role: 'assistant', content: 'Your boss wrote…', toolEvents: [{ tool: 'gmail_search', ok: true }] }])).toBe(true);
    expect(messagesCarryConnectorData([{ role: 'assistant', content: 'Sunny', toolEvents: [{ tool: 'get_weather', ok: true }] }])).toBe(false);
    // A marker set to anything but true is not one.
    expect(messagesCarryConnectorData([{ role: 'assistant', content: 'x', connectorData: 'yes' }])).toBe(false);
  });

  it("'inherited': the caller's scope or request decision", () => {
    expect(connectorDataSources({ inherited: true })).toEqual(['inherited']);
  });

  it('reports every source at once', () => {
    expect(
      connectorDataSources({
        inherited: true,
        toolNames: ['gmail_search'],
        connectorContext: true,
        messages: [{ role: 'assistant', content: 'x', connectorData: true }]
      })
    ).toEqual(['inherited', 'tools', 'context', 'history']);
  });

  it('withoutConnectorTools keeps everything else in order', () => {
    expect(withoutConnectorTools(['gmail_search', 'web_search', 'calendar_agenda', 'get_weather'])).toEqual(['web_search', 'get_weather']);
    expect(withoutConnectorTools([{ name: 'drive_search' }, { name: 'read_url' }], (t) => t.name)).toEqual([{ name: 'read_url' }]);
  });

  it('isFreeModelId: only `:free` endpoints', () => {
    expect(isFreeModelId('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isFreeModelId('google/gemini-2.5-flash')).toBe(false);
    expect(isFreeModelId(undefined)).toBe(false);
  });
});

describe('OpenRouter routing for connector content (pure)', () => {
  it('merges data_collection deny into existing provider routing', () => {
    expect(withDataCollectionDenied({ model: 'a', provider: { order: ['x'] } })).toEqual({
      model: 'a',
      provider: { order: ['x'], data_collection: 'deny' }
    });
    expect(withDataCollectionDenied({ model: 'a' }).provider).toEqual({ data_collection: 'deny' });
  });

  it('leaves a paid request with no free members untouched (same object)', () => {
    const req = { model: 'paid/a', models: ['paid/a', 'paid/b'], fallbackModel: 'paid/net' };
    const route = routeForConnectorData(req);
    expect(route.ok && route.req).toBe(req);
  });

  it('drops free members of the chain and a free fallback', () => {
    const route = routeForConnectorData({ model: 'paid/a', models: ['paid/a', 'x:free', 'paid/b'], fallbackModel: 'y:free' });
    expect(route.ok && route.req).toEqual({ model: 'paid/a', models: ['paid/a', 'paid/b'], fallbackModel: undefined });
  });

  it('a free primary goes to the paid net; a free-only one (or one without a paid net) is refused', () => {
    const swapped = routeForConnectorData({ model: 'x:free', fallbackModel: 'paid/net' });
    expect(swapped.ok && swapped.req.model).toBe('paid/net');
    expect(swapped.ok && swapped.swappedFrom).toBe('x:free');
    expect(routeForConnectorData({ model: 'x:free', fallbackModel: 'paid/net', freeOnly: true }).ok).toBe(false);
    expect(routeForConnectorData({ model: 'x:free' }).ok).toBe(false);
  });
});

describe('privacy scope and request binding', () => {
  it('is sticky: a nested false never clears an enclosing scope; outside, nothing is set', async () => {
    expect(connectorPrivacyActive()).toBe(false);
    await runWithConnectorPrivacy(true, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(connectorPrivacyActive()).toBe(true);
      runWithConnectorPrivacy(false, () => expect(connectorPrivacyActive()).toBe(true));
    });
    expect(connectorPrivacyActive()).toBe(false);
    runWithConnectorPrivacy(false, () => expect(connectorPrivacyActive()).toBe(false));
  });

  it('binds the decision to the request object only (a client property is never read)', () => {
    const ctx = {};
    const forged = { connectorData: true };
    bindConnectorPrivacy(ctx, true);
    bindConnectorPrivacy({}, false);
    expect(connectorPrivacyBound(ctx)).toBe(true);
    expect(connectorPrivacyBound(forged)).toBe(false);
    expect(connectorPrivacyBound(undefined)).toBe(false);
  });
});

describe('copy and the provider table', () => {
  it('says what happened, why, and the two ways forward — and survives the client error mapper', () => {
    for (const copy of [CONNECTED_DATA_FREE_MODEL_MESSAGE]) {
      expect(copy).toMatch(/connected accounts/);
      expect(copy).toMatch(/free models may keep or learn/);
      expect(copy).toMatch(/switch to a standard model/);
      expect(copy).toMatch(/start a new chat without connected content/);
    }
    // services/chatErrors.ts rewrites messages containing these phrases; ours must reach the user verbatim.
    const rewritten = /aborted|timed out|timeout|failed to fetch|network error|not found|no endpoints found|limit exceeded|payment required|credits|quota|429|rate limit|too many requests|uuid/i;
    for (const copy of [CONNECTED_DATA_FREE_MODEL_MESSAGE, CONNECTED_DATA_BUDGET_SENTENCE, CONNECTED_ACCOUNTS_WITHHELD_NOTICE]) {
      expect(copy).not.toMatch(rewritten);
      expect(copy).not.toMatch(/\$/);
    }
  });

  it('documents every text provider; only OpenRouter is controlled per request, Gemini needs the owner', () => {
    for (const id of TEXT_PROVIDER_IDS) expect(PROVIDER_PRIVACY_POLICIES[id]).toBeDefined();
    expect(PROVIDER_PRIVACY_POLICIES.openrouter.coverage).toBe('per_request_control');
    expect(PROVIDER_PRIVACY_POLICIES.gemini.coverage).toBe('owner_must_confirm');
    const verified = Object.values(PROVIDER_PRIVACY_POLICIES).filter((p) => p.coverage === 'api_terms_no_training');
    for (const p of verified) expect(p.source).toMatch(/^https:\/\//);
  });
});
