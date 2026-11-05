// @vitest-environment jsdom
// The chat client side of connected-account privacy (components/chat/connectorPrivacy.ts): which
// turns carry the provenance echo, which turns may run on a free model, which failures are the calm
// notice (built here from REAL responses: the server's own copy and code, through the real
// apiClient / chatApi / recipes code with only fetch faked), and what "Use a standard model" does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTED_DATA_ACTIONS,
  CONNECTED_DATA_FREE_MODEL_CODE,
  connectedDataNoticeOf,
  connectorMarkerFor,
  isConnectorToolName,
  mayRunOnFreeModel,
  standardModelStep,
  turnCarriesConnectorData
} from './connectorPrivacy';
import { sendChatMessageStream } from '../../services/chatApi';
import { runRecipe } from '../../services/recipes';
import {
  CONNECTED_DATA_BUDGET_SENTENCE as SERVER_BUDGET_SENTENCE,
  CONNECTED_DATA_FREE_MODEL_CODE as SERVER_CODE,
  connectedDataFreeModelMessage
} from '../../server/src/ai/privacy/connectorData';
import { connectorFreeModelRefusal } from '../../server/src/ai/privacy/openrouterPolicy';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (records: string[]): Response =>
  new Response(records.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const respondWith = (res: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => res()));
const chat = () => sendChatMessageStream({ messages: [{ role: 'user', content: 'what is on my calendar?' }] }).catch((e: unknown) => e);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provenance: which turns echo connectorData', () => {
  const assistant = (over: Record<string, unknown> = {}) => ({ role: 'assistant', ...over });

  it('a reply the server marked', () => {
    expect(turnCarriesConnectorData(assistant({ connectorData: true }))).toBe(true);
    expect(connectorMarkerFor(assistant({ connectorData: true }))).toEqual({ connectorData: true });
  });

  it('a reply whose tool events name a connector tool, in every family the note lists', () => {
    for (const tool of [
      'gmail_search',
      'gmail_inbox',
      'drive_search',
      'calendar_agenda',
      'calendar_create_event',
      'sheets_read',
      'maps_lookup',
      'connected_data_search',
      'nango_call_api',
      'mcp_nango_list_connections',
      // A future tool in a connector family counts before the list is updated.
      'gmail_thread_summary',
      'drive_export'
    ]) {
      expect(isConnectorToolName(tool), tool).toBe(true);
      expect(turnCarriesConnectorData(assistant({ toolEvents: [{ tool: 'web_search' }, { tool }] })), tool).toBe(true);
    }
  });

  it('nothing else: other tools, a user-saved MCP server, user turns, an unmarked reply', () => {
    for (const tool of ['web_search', 'run_python', 'maps_route', 'nango_list_integrations', 'mcp_3f2a9c1e-77aa-4c55-9b1d-0f4f2b6c9e10_search']) {
      expect(isConnectorToolName(tool), tool).toBe(false);
    }
    expect(turnCarriesConnectorData(assistant({ toolEvents: [{ tool: 'web_search' }] }))).toBe(false);
    expect(turnCarriesConnectorData(assistant())).toBe(false);
    expect(turnCarriesConnectorData(assistant({ connectorData: false }))).toBe(false);
    // The marker is about the model's replies; a user turn never carries it.
    expect(turnCarriesConnectorData({ role: 'user', connectorData: true, toolEvents: [{ tool: 'gmail_search' }] })).toBe(false);
    expect(connectorMarkerFor(assistant())).toEqual({});
  });
});

describe('the server mark reaches the chat on every path', () => {
  it('the chat stream’s final payload keeps connectorData', async () => {
    respondWith(() => sse(['event: delta\ndata: {"content":"Two meetings."}\n\n', 'event: final\ndata: {"text":"Two meetings.","model":"m","connectorData":true}\n\n']));
    const res = await sendChatMessageStream({ messages: [{ role: 'user', content: 'calendar?' }] });
    expect(res.connectorData).toBe(true);
  });

  it('a recipe run’s final event keeps connectorData; an unmarked run has none', async () => {
    respondWith(() => sse(['event: final\ndata: {"text":"Inbox summary.","connectorData":true}\n\n']));
    expect((await runRecipe({ recipeId: 'inbox', values: {} })).connectorData).toBe(true);
    respondWith(() => sse(['event: final\ndata: {"text":"A poem."}\n\n']));
    expect(await runRecipe({ recipeId: 'poem', values: {} })).not.toHaveProperty('connectorData');
  });
});

describe('mayRunOnFreeModel: the turns flagged memory stays out of', () => {
  it('every Free only turn, whatever model it names', () => {
    expect(mayRunOnFreeModel({ freeOnly: true })).toBe(true);
    expect(mayRunOnFreeModel({ freeOnly: true, model: 'vendor/paid-model' })).toBe(true);
  });
  it('a free model named with Free only off (the suffix, or the catalog says free)', () => {
    expect(mayRunOnFreeModel({ freeOnly: false, model: 'vendor/some-model:free' })).toBe(true);
    expect(mayRunOnFreeModel({ freeOnly: false, model: 'vendor/zero-priced', modelIsFree: true })).toBe(true);
  });
  it('not a paid turn', () => {
    expect(mayRunOnFreeModel({ freeOnly: false, model: 'vendor/paid-model' })).toBe(false);
    expect(mayRunOnFreeModel({ freeOnly: false })).toBe(false);
  });
});

describe('connectedDataNoticeOf: the calm notice, from real responses', () => {
  it('the chat routes’ 409 (Free only copy) → standard-model, with the server copy verbatim', async () => {
    const message = connectedDataFreeModelMessage(true);
    respondWith(() => json(409, { error: { message, code: SERVER_CODE } }));
    const err = await chat();
    expect(connectedDataNoticeOf(err)).toEqual({ kind: 'standard-model', message });
  });

  it('the 409 for a pinned free model (the other copy) → standard-model', async () => {
    const message = connectedDataFreeModelMessage(false);
    respondWith(() => json(409, { error: { message, code: SERVER_CODE } }));
    expect(connectedDataNoticeOf(await chat())).toEqual({ kind: 'standard-model', message });
  });

  it('a recipe run refused the same way (/api/recipes/run) → standard-model', async () => {
    const message = connectedDataFreeModelMessage(true);
    respondWith(() => json(409, { error: { message, code: SERVER_CODE } }));
    const err = await runRecipe({ recipeId: 'research', values: {} }).catch((e: unknown) => e);
    expect(connectedDataNoticeOf(err)).toEqual({ kind: 'standard-model', message });
  });

  it('the provider backstop refusing mid-stream (an SSE error carries no code) → standard-model', async () => {
    for (const freeOnly of [true, false]) {
      const message = connectorFreeModelRefusal(freeOnly).publicMessage;
      respondWith(() => sse([`event: error\ndata: ${JSON.stringify({ message })}\n\n`]));
      expect(connectedDataNoticeOf(await chat())).toEqual({ kind: 'standard-model', message });
    }
    // A recipe's mid-stream error reaches AIChatPlatform as its outcome.error, rethrown as an Error.
    const message = connectorFreeModelRefusal(true).publicMessage;
    respondWith(() => sse([`event: error\ndata: ${JSON.stringify({ message })}\n\n`]));
    const outcome = await runRecipe({ recipeId: 'research', values: {} });
    expect(connectedDataNoticeOf(new Error(outcome.error))).toEqual({ kind: 'standard-model', message });
  });

  it('a 402 that carries the budget sentence → budget, with the whole server copy', async () => {
    const message = `You've used all of your included usage for now. ${SERVER_BUDGET_SENTENCE}`;
    respondWith(() => json(402, { error: { message, code: 'BILLING_LIMIT_EXCEEDED', details: { reason: 'budget', message } } }));
    expect(connectedDataNoticeOf(await chat())).toEqual({ kind: 'budget', message });
  });

  it('every other failure stays what it was', async () => {
    // A plain usage refusal (no connected content): the existing 402 path.
    respondWith(() => json(402, { error: { message: "You've used all of your included usage for now.", code: 'BILLING_LIMIT_EXCEEDED' } }));
    expect(connectedDataNoticeOf(await chat())).toBeNull();
    // A 409 with another code.
    respondWith(() => json(409, { error: { message: 'Conflict.', code: 'CONFLICT' } }));
    expect(connectedDataNoticeOf(await chat())).toBeNull();
    // The budget sentence on another status, or the refusal clause on an HTTP error, is not a notice.
    respondWith(() => json(500, { error: { message: `Oops. ${SERVER_BUDGET_SENTENCE}` } }));
    expect(connectedDataNoticeOf(await chat())).toBeNull();
    respondWith(() => json(500, { error: { message: connectorFreeModelRefusal(true).publicMessage } }));
    expect(connectedDataNoticeOf(await chat())).toBeNull();
    expect(connectedDataNoticeOf(new Error('The model took too long to respond.'))).toBeNull();
    expect(connectedDataNoticeOf(undefined)).toBeNull();
    expect(connectedDataNoticeOf('409')).toBeNull();
  });

  it('the code alone is enough, wherever the error keeps it', () => {
    expect(connectedDataNoticeOf({ message: 'Not sent.', status: 409, details: { error: { code: CONNECTED_DATA_FREE_MODEL_CODE } } })?.kind).toBe('standard-model');
    expect(connectedDataNoticeOf({ message: 'Not sent.', status: 409, details: { code: CONNECTED_DATA_FREE_MODEL_CODE } })?.kind).toBe('standard-model');
    expect(connectedDataNoticeOf({ message: 'Not sent.', code: CONNECTED_DATA_FREE_MODEL_CODE })?.kind).toBe('standard-model');
    // No copy to show: not a notice.
    expect(connectedDataNoticeOf({ message: '  ', status: 409, details: { code: CONNECTED_DATA_FREE_MODEL_CODE } })).toBeNull();
  });
});

describe('the two actions', () => {
  it('free-model refusal: "Use a standard model" first, then "New chat"; usage refusal: "New chat", then "API keys"', () => {
    expect(CONNECTED_DATA_ACTIONS['standard-model']).toEqual(['standard-model', 'new-chat']);
    expect(CONNECTED_DATA_ACTIONS.budget).toEqual(['new-chat', 'api-keys']);
  });

  it('"Use a standard model" turns Free only off — or opens the picker for a pinned free model', () => {
    expect(standardModelStep({ freeOnly: true })).toBe('free-only-off');
    expect(standardModelStep({ freeOnly: true, pinnedModel: null })).toBe('free-only-off');
    expect(standardModelStep({ freeOnly: true, pinnedModel: 'vendor/paid-model' })).toBe('free-only-off');
    expect(standardModelStep({ freeOnly: true, pinnedModel: 'vendor/some-model:free' })).toBe('pick-model');
    expect(standardModelStep({ freeOnly: false, pinnedModel: 'vendor/some-model:free' })).toBe('pick-model');
    expect(standardModelStep({ freeOnly: false, pinnedModel: 'vendor/zero-priced', pinnedIsFree: true })).toBe('pick-model');
    // Free only already off and nothing pinned (Auto named a free model): the picker names a standard one.
    expect(standardModelStep({ freeOnly: false })).toBe('pick-model');
  });
});
