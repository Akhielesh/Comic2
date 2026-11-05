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
  connectedAccountsWithheldNote,
  connectedAccountsWithheldNotice,
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
    expect(isFreeModelId('vendor/free-a:free')).toBe(true);
    expect(isFreeModelId('vendor/paid-a')).toBe(false);
    expect(isFreeModelId('vendor/free-a:free-trial')).toBe(false);
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
    for (const copy of [CONNECTED_DATA_FREE_MODEL_MESSAGE, CONNECTED_DATA_BUDGET_SENTENCE, CONNECTED_ACCOUNTS_WITHHELD_NOTICE, connectedAccountsWithheldNotice(false)]) {
      expect(copy).not.toMatch(rewritten);
      expect(copy).not.toMatch(/\$/);
    }
  });

  it('the withheld copy only advises turning Free only off when the user chose it', () => {
    expect(connectedAccountsWithheldNote(true)).toContain('turn off Free only');
    expect(connectedAccountsWithheldNotice(true)).toContain('turn off Free only');
    expect(connectedAccountsWithheldNote(false)).not.toContain('Free only');
    expect(connectedAccountsWithheldNotice(false)).not.toContain('Free only');
  });

  it('documents every text provider; only OpenRouter is controlled per request, Gemini needs the owner', () => {
    for (const id of TEXT_PROVIDER_IDS) expect(PROVIDER_PRIVACY_POLICIES[id]).toBeDefined();
    expect(PROVIDER_PRIVACY_POLICIES.openrouter.coverage).toBe('per_request_control');
    expect(PROVIDER_PRIVACY_POLICIES.gemini.coverage).toBe('owner_must_confirm');
    const verified = Object.values(PROVIDER_PRIVACY_POLICIES).filter((p) => p.coverage === 'api_terms_no_training');
    for (const p of verified) expect(p.source).toMatch(/^https:\/\//);
  });
});

// ── Review fixes ──────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_MEMORY_HEADING,
  CONNECTED_MEMORY_PRODUCT,
  connectedDataFreeModelMessage,
  isConnectorMcpToolName,
  withoutClientMemoryBlock
} from './connectorData.js';
import { connectedDataCapacityError, connectorFreeModelRefusal } from './openrouterPolicy.js';
import { bindConnectorTurnDecision, connectorEgressProbe, connectorTurnDecision, noteConnectorEgress } from './scope.js';
import { makeProviderError } from '../providers/errors.js';
import { CURATED_MCP_CATALOG } from '../studio/designSystem.js';

describe('review fixes: connector classification', () => {
  it("the operator's Nango MCP tools (mcp_nango_*) are connector tools; a user's own MCP server (UUID id) is not", () => {
    expect(CURATED_MCP_CATALOG.some((m) => m.id === 'nango' && m.envVar === 'STUDIO_NANGO_MCP_URL')).toBe(true);
    expect(isConnectorToolName('mcp_nango_list_records')).toBe(true);
    expect(isConnectorMcpToolName('mcp_nango_proxy')).toBe(true);
    expect(isConnectorToolName('mcp_8f14e45f-ceea-467f-a0e6-0f4e1c0f2c11_search')).toBe(false);
    expect(isConnectorMcpToolName('gmail_search')).toBe(false);
    expect(turnUsesConnectorData({ toolNames: ['mcp_nango_list_records'] })).toBe(true);
  });

  it("'history' from the server's provenance store (plain text, no marker)", () => {
    const plain = [{ role: 'assistant', content: 'Dana asked to move the launch.' }];
    expect(connectorDataSources({ messages: plain })).toEqual([]);
    expect(connectorDataSources({ messages: plain, historyKnown: true })).toEqual(['history']);
  });
});

describe('review fixes: copy', () => {
  it('the free-model refusal only says "turn off Free only" to someone in Free only', () => {
    expect(connectedDataFreeModelMessage(true)).toBe(CONNECTED_DATA_FREE_MODEL_MESSAGE);
    expect(connectedDataFreeModelMessage(true)).toContain('turn off Free only');
    expect(connectedDataFreeModelMessage(false)).not.toContain('Free only');
    expect(connectedDataFreeModelMessage(false)).toContain('pick a standard model instead of the free one');
    for (const freeOnly of [true, false]) {
      expect(connectedDataFreeModelMessage(freeOnly)).toContain('start a new chat without connected content');
      expect(connectorFreeModelRefusal(freeOnly).publicMessage.includes('Free only')).toBe(freeOnly);
    }
  });

  it('a capacity failure keeps its status, code and log text; only the advice changes (both capacity kinds)', () => {
    for (const [status, text] of [
      [403, 'Key limit exceeded (total limit)'],
      [402, 'This request requires more credits']
    ] as const) {
      const err = makeProviderError(status, `OpenRouter /chat/completions failed: ${status} ${text}`);
      const before = err.message;
      expect(err.publicMessage).toMatch(/switch to a free model/i);
      const out = connectedDataCapacityError(err);
      expect(out).toBe(err);
      expect(out.status).toBe(503);
      expect(out.publicCode).toBe('PROVIDER_CAPACITY');
      expect(out.message).toBe(before);
      expect(out.publicMessage).not.toMatch(/switch to a free model/i);
      expect(out.publicMessage).toContain('never sent to free models');
      expect(out.publicMessage).toContain('add your own API key');
    }
  });
});

describe('review fixes: memory', () => {
  // The exact block the chat client composes (components/chat/AIChatPlatform.tsx composeSystemPrompt).
  const clientSource = readFileSync(fileURLToPath(new URL('../../../../components/chat/AIChatPlatform.tsx', import.meta.url)), 'utf8');
  const RULES =
    'Relevance rules: treat these as optional background, never a frame. If a fact does not obviously apply, ignore it. If stored facts seem to contradict the current message, trust the current message.';
  const composed = (persona: string | null, memory: string) =>
    [persona, `${CLIENT_MEMORY_HEADING} — use ONLY when they are clearly relevant to the current question:\n${memory}\n\n${RULES}`]
      .filter(Boolean)
      .join('\n\n');

  it('parity: the client still composes memory under this heading, closed by the relevance rules', () => {
    expect(clientSource).toContain(CLIENT_MEMORY_HEADING);
    expect(clientSource).toContain('Relevance rules:');
    expect(clientSource.indexOf('Relevance rules:')).toBeGreaterThan(clientSource.indexOf(CLIENT_MEMORY_HEADING));
  });

  it('withoutClientMemoryBlock drops the heading, the memory and the rules, and keeps the persona', () => {
    const memory = '- Dana launch Friday\n- Lives in Lisbon';
    expect(withoutClientMemoryBlock(composed('Answer like a pirate.', memory))).toBe('Answer like a pirate.');
    expect(withoutClientMemoryBlock(composed(null, memory))).toBeUndefined();
    // A prompt cut off mid-memory (the route keeps 8,000 characters) loses the rest too.
    expect(withoutClientMemoryBlock(`Persona.\n\n${CLIENT_MEMORY_HEADING}:\n- Dana launch`)).toBe('Persona.');
    // No memory: unchanged.
    expect(withoutClientMemoryBlock('Just a persona.')).toBe('Just a persona.');
    expect(withoutClientMemoryBlock(undefined)).toBeUndefined();
  });

  it('memory distilled from connected content gets its own product (the column is free text)', () => {
    expect(CONNECTED_MEMORY_PRODUCT).toBe('chat_studio_connected');
  });
});

describe('review fixes: the egress probe and the bound decision', () => {
  it('a probe learns only what is sent inside its own scoped run (nested runs report to every enclosing probe)', async () => {
    const outer = connectorEgressProbe();
    const inner = connectorEgressProbe();
    noteConnectorEgress(); // outside any scope: nobody hears it
    await runWithConnectorPrivacy(
      true,
      async () => {
        await runWithConnectorPrivacy(false, async () => noteConnectorEgress(), inner);
      },
      outer
    );
    expect(inner.sent).toBe(true);
    expect(outer.sent).toBe(true);

    const idle = connectorEgressProbe();
    await runWithConnectorPrivacy(true, async () => undefined, idle);
    expect(idle.sent).toBe(false);
    // Not a connector run: no scope, nothing heard.
    const off = connectorEgressProbe();
    await runWithConnectorPrivacy(false, async () => noteConnectorEgress(), off);
    expect(off.sent).toBe(false);
  });

  it('binds the whole decision; the older flag-only binding keeps working', () => {
    const ctx = {};
    expect(connectorTurnDecision(ctx)).toBeUndefined();
    bindConnectorTurnDecision(ctx, { connectorData: false, freeTurn: true });
    expect(connectorTurnDecision(ctx)).toEqual({ connectorData: false, freeTurn: true });
    expect(connectorPrivacyBound(ctx)).toBe(false);
    bindConnectorPrivacy(ctx, true);
    expect(connectorTurnDecision(ctx)).toEqual({ connectorData: true, freeTurn: true });
    expect(connectorPrivacyBound(ctx)).toBe(true);
    expect(connectorTurnDecision(undefined)).toBeUndefined();
  });
});
