// @vitest-environment jsdom
// Chat Studio's half of connected-account privacy (wave notes 1–3, docs/DATA_CONNECTORS.md):
//  - the echo: an assistant turn connected content entered goes back to the server marked;
//  - the sticky memory flag: memory distilled from connected content stays out of Free only turns
//    and turns on a free model, until the memory is cleared;
//  - the calm notice: a refused turn becomes a notice, never an error, and never history.
// Real chatStorage, freeOnlyMode and localStorage; the server's own reader judges the echo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../usage/useUsageAllowance', () => ({ useUsageAllowance: () => null }));

import {
  applyVariant,
  composeSystemPrompt,
  isHistoryTurn,
  standardModelAction,
  storeMemoryUpdate,
  toNoticeTurn,
  toRequestMessage,
  toStoppedTurn,
  turnSystemPrompt,
  withAnswer
} from './AIChatPlatform';
import { sendChatMessageStream } from '../../services/chatApi';
import { recommendModels } from '../../services/chatSuggest';
import type { CatalogModel } from '../../services/modelCatalog';
import { buildMessages as followUpMessages } from './FollowUpChips';
import type { ChatTurn } from '../../services/chatStorage';
import { createEmptySession, getChatMemory, isChatMemoryConnected, setChatMemory } from '../../services/chatStorage';
import { setFreeOnly } from '../../services/freeOnlyMode';
import {
  CLIENT_MEMORY_HEADING,
  messagesCarryConnectorData,
  withoutClientMemoryBlock
} from '../../server/src/ai/privacy/connectorData';

const U = '33333333-3333-4333-8333-333333333333';
const MEMORY = '- Planning the launch with Dana on Friday\n- Lives in Lisbon';
const PERSONA = 'Answer like a calm editor.';

const turn = (over: Partial<ChatTurn>): ChatTurn => ({ id: crypto.randomUUID(), role: 'assistant', content: 'Answer.', createdAt: 1, ...over });

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('note 2(a): toRequestMessage echoes connected-account provenance', () => {
  it('a reply the server marked (connectorData: true) goes back marked, and the server recognises it', () => {
    const msg = toRequestMessage(turn({ content: 'You have two meetings tomorrow.', connectorData: true }));
    expect(msg).toEqual({ role: 'assistant', content: 'You have two meetings tomorrow.', connectorData: true });
    expect(messagesCarryConnectorData([msg])).toBe(true);
  });

  it('a reply whose tool events name a connector tool is marked even without the server flag', () => {
    for (const tool of ['gmail_search', 'drive_search', 'calendar_agenda', 'sheets_read', 'maps_lookup', 'connected_data_search', 'nango_call_api', 'mcp_nango_proxy']) {
      const msg = toRequestMessage(turn({ toolEvents: [{ tool: 'web_search', ok: true }, { tool, ok: true }] }));
      expect(msg.connectorData, tool).toBe(true);
      // The marker alone is what the server reads (toolEvents are not sent).
      expect(messagesCarryConnectorData([{ role: msg.role, content: msg.content, connectorData: msg.connectorData }]), tool).toBe(true);
    }
  });

  it('an image turn keeps the marker on its multimodal message', () => {
    const msg = toRequestMessage(
      turn({ connectorData: true, attachments: [{ id: 'a1', name: 'chart.png', mimeType: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }] })
    );
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.connectorData).toBe(true);
  });

  it('every other turn is sent exactly as before: no marker key at all', () => {
    expect(toRequestMessage(turn({ content: 'Paris.' }))).toEqual({ role: 'assistant', content: 'Paris.' });
    expect(toRequestMessage(turn({ toolEvents: [{ tool: 'web_search', ok: true }] }))).toEqual({ role: 'assistant', content: 'Answer.' });
    expect(toRequestMessage(turn({ role: 'user', content: 'Check my inbox' }))).toEqual({ role: 'user', content: 'Check my inbox' });
    expect(messagesCarryConnectorData([toRequestMessage(turn({ content: 'Paris.' }))])).toBe(false);
  });
});

describe('note 2(a): the server mark is stored on the answer and its version', () => {
  it('a final payload with connectorData: true leaves a marked turn (and version) that goes back marked', () => {
    const live = turn({ content: 'Two meet' });
    const done = withAnswer(live, { text: 'Two meetings tomorrow.', model: 'vendor/paid-model', connectorData: true }, 1200, 5);
    expect(done.connectorData).toBe(true);
    expect(done.variants?.[0]).toMatchObject({ content: 'Two meetings tomorrow.', connectorData: true, durationMs: 1200, createdAt: 5 });
    expect(toRequestMessage(done)).toEqual({ role: 'assistant', content: 'Two meetings tomorrow.', connectorData: true });
  });

  it('an unmarked reply stays unmarked; flipping versions shows that version’s mark', () => {
    const first = withAnswer(turn({ content: '' }), { text: 'From your inbox: …', connectorData: true }, 10);
    const second = withAnswer(first, { text: 'A general answer.' }, 10);
    expect(second.connectorData).toBeUndefined();
    expect(toRequestMessage(second)).toEqual({ role: 'assistant', content: 'A general answer.' });
    const back = applyVariant(second, second.variants![0]);
    expect(back.connectorData).toBe(true);
    expect(toRequestMessage(back).connectorData).toBe(true);
    // A version never carries a notice over.
    expect(applyVariant({ ...second, notice: { kind: 'budget' } }, second.variants![1]).notice).toBeUndefined();
  });
});

describe('note 2(b): flagged memory stays out of Free only turns', () => {
  it('composeSystemPrompt: flagged memory on a free turn is left out, the persona kept', () => {
    const out = composeSystemPrompt(MEMORY, PERSONA, { memoryConnected: true, freeTurn: true });
    expect(out).toBe(PERSONA);
    expect(composeSystemPrompt(MEMORY, undefined, { memoryConnected: true, freeTurn: true })).toBeUndefined();
  });

  it('composeSystemPrompt: the memory block is unchanged otherwise (paid turn, unflagged memory, no privacy arg)', () => {
    for (const out of [
      composeSystemPrompt(MEMORY, PERSONA, { memoryConnected: true, freeTurn: false }),
      composeSystemPrompt(MEMORY, PERSONA, { memoryConnected: false, freeTurn: true }),
      composeSystemPrompt(MEMORY, PERSONA)
    ]) {
      expect(out).toContain(CLIENT_MEMORY_HEADING);
      expect(out).toContain('Planning the launch with Dana');
      // Still the block the server's interim strip recognises (parity with withoutClientMemoryBlock).
      expect(withoutClientMemoryBlock(out)).toBe(PERSONA);
    }
  });

  it('turnSystemPrompt: Free only (the default) leaves flagged memory out; a paid turn keeps it', () => {
    setChatMemory(MEMORY, U);
    storeMemoryUpdate(U, MEMORY, { memory: MEMORY, connectorData: true });
    expect(isChatMemoryConnected(U)).toBe(true);

    // Free only is ON by default — even with a paid model named, flagged memory stays out.
    expect(turnSystemPrompt(U, PERSONA, {})).toBe(PERSONA);
    expect(turnSystemPrompt(U, PERSONA, { id: 'vendor/paid-model' })).toBe(PERSONA);

    setFreeOnly(false);
    // A free model named: still out.
    expect(turnSystemPrompt(U, PERSONA, { id: 'vendor/some-model:free' })).toBe(PERSONA);
    expect(turnSystemPrompt(U, PERSONA, { id: 'vendor/zero-priced', isFree: true })).toBe(PERSONA);
    // A paid turn: the memory is composed as before.
    expect(turnSystemPrompt(U, PERSONA, { id: 'vendor/paid-model' })).toContain('Planning the launch with Dana');
  });

  it('turnSystemPrompt: unflagged memory is composed on free turns as before', () => {
    setChatMemory(MEMORY, U);
    storeMemoryUpdate(U, MEMORY, { memory: `${MEMORY}\n- Prefers short answers` });
    expect(isChatMemoryConnected(U)).toBe(false);
    expect(turnSystemPrompt(U, PERSONA, {})).toContain('Prefers short answers');
  });

  it('storeMemoryUpdate: the flag is sticky across later unflagged updates, and cleared with the memory', () => {
    expect(storeMemoryUpdate(U, '', { memory: MEMORY, connectorData: true })).toBe(MEMORY);
    expect(getChatMemory(U)).toBe(MEMORY);
    expect(isChatMemoryConnected(U)).toBe(true);

    // A later exchange with no connected content does not unflag what was already learnt.
    const next = `${MEMORY}\n- Prefers short answers`;
    expect(storeMemoryUpdate(U, MEMORY, { memory: next })).toBe(next);
    expect(isChatMemoryConnected(U)).toBe(true);

    // Nothing new, but the exchange was connected: the flag is (still) set; nothing to show.
    expect(storeMemoryUpdate(U, next, { memory: next, connectorData: true })).toBeNull();
    expect(isChatMemoryConnected(U)).toBe(true);

    // The user clears their memory (Settings → Memory removes every item): the flag goes with it.
    setChatMemory('', U);
    expect(isChatMemoryConnected(U)).toBe(false);
  });

  it('storeMemoryUpdate: a flag on an empty memory is not kept (there is nothing to withhold)', () => {
    expect(storeMemoryUpdate(U, '', { memory: '', connectorData: true })).toBeNull();
    expect(isChatMemoryConnected(U)).toBe(false);
  });

  it('the flag is per account', () => {
    const V = '44444444-4444-4444-8444-444444444444';
    setChatMemory(MEMORY, V);
    storeMemoryUpdate(U, '', { memory: MEMORY, connectorData: true });
    expect(isChatMemoryConnected(U)).toBe(true);
    expect(isChatMemoryConnected(V)).toBe(false);
  });
});

describe('note 3: a refused turn becomes a calm notice, never an error and never history', () => {
  it('toNoticeTurn keeps the server copy, sets the notice, and clears what the attempt started', () => {
    const live = turn({ content: '', reasoning: 'thinking', durationMs: 12, error: true });
    const notice = toNoticeTurn(live, { kind: 'standard-model', message: 'Not sent. Pick a standard model.' });
    expect(notice).toMatchObject({ id: live.id, role: 'assistant', content: 'Not sent. Pick a standard model.', notice: { kind: 'standard-model' } });
    expect(notice.error).toBeFalsy();
    expect(notice.reasoning).toBeUndefined();
  });

  it('a notice (like a failed attempt) is never sent back as history; answers are', () => {
    const user = turn({ role: 'user', content: 'What is on my calendar?' });
    const answer = turn({ content: 'Two meetings.', connectorData: true });
    const notice = toNoticeTurn(turn({ content: '' }), { kind: 'budget', message: 'Usage is used up.' });
    const failed = turn({ content: "Couldn't complete that.", error: true });
    const history = [user, answer, failed, notice].filter(isHistoryTurn).map(toRequestMessage);
    expect(history).toEqual([
      { role: 'user', content: 'What is on my calendar?' },
      { role: 'assistant', content: 'Two meetings.', connectorData: true }
    ]);
  });
});

describe('follow-up suggestions see the same conversation', () => {
  it('a marked answer keeps its marker, and a notice is not part of it', () => {
    const session = {
      ...createEmptySession(),
      turns: [
        turn({ role: 'user', content: 'What is on my calendar?' }),
        turn({ content: 'Two meetings.', toolEvents: [{ tool: 'calendar_agenda', ok: true }] }),
        turn({ role: 'user', content: 'And on Friday?' }),
        toNoticeTurn(turn({ content: '' }), { kind: 'standard-model', message: 'Not sent.' })
      ]
    };
    expect(followUpMessages(session)).toEqual([
      { role: 'user', content: 'What is on my calendar?' },
      { role: 'assistant', content: 'Two meetings.', connectorData: true },
      { role: 'user', content: 'And on Friday?' }
    ]);
  });
});

describe('a reply the user stops goes back marked when its stream said it may carry connected content', () => {
  /** A stream that sends `meta` and one delta, then waits until the request is aborted. */
  const stoppableStream = (meta: Record<string, unknown>) =>
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
          c.enqueue(enc.encode('event: delta\ndata: {"content":"You have two meet"}\n\n'));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('The user aborted a request.', 'AbortError')));
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

  const stopAfterFirstDelta = async () => {
    const controller = new AbortController();
    let flagged = false;
    let partial = '';
    const run = sendChatMessageStream(
      { messages: [{ role: 'user', content: 'What is on my calendar?' }] },
      {
        signal: controller.signal,
        onMeta: (m) => {
          if (m.connectorPrivacy === true) flagged = true;
        },
        onDelta: (d) => {
          partial += d;
          controller.abort();
        }
      }
    );
    await expect(run).rejects.toBeTruthy();
    return { flagged, partial };
  };

  it('a flagged stream stopped after a delta: the kept partial answer is history and carries connectorData: true', async () => {
    vi.stubGlobal('fetch', stoppableStream({ model: 'vendor/paid-model', source: 'openrouter', connectorPrivacy: true }));
    const { flagged, partial } = await stopAfterFirstDelta();
    expect(partial).toBe('You have two meet');
    const stopped = toStoppedTurn(turn({ content: partial }), flagged);
    expect(isHistoryTurn(stopped)).toBe(true);
    expect(toRequestMessage(stopped)).toEqual({ role: 'assistant', content: 'You have two meet', connectorData: true });
    expect(messagesCarryConnectorData([toRequestMessage(stopped)])).toBe(true);
  });

  it('an unflagged stream stopped the same way stays unmarked, unless its live trace shows a connector tool', async () => {
    vi.stubGlobal('fetch', stoppableStream({ model: 'vendor/paid-model', source: 'openrouter', connectorPrivacy: false }));
    const { flagged, partial } = await stopAfterFirstDelta();
    expect(toRequestMessage(toStoppedTurn(turn({ content: partial }), flagged))).toEqual({ role: 'assistant', content: 'You have two meet' });

    const traced = toStoppedTurn(
      turn({ content: partial, artifacts: [{ type: 'agent_activity', data: { steps: [{ tool: 'calendar_agenda', status: 'running' }] } }] }),
      flagged
    );
    expect(toRequestMessage(traced).connectorData).toBe(true);
    // The live card stops spinning.
    expect((traced.artifacts?.[0].data as { steps: { status: string }[] }).steps[0].status).not.toBe('running');
  });
});

describe('"Use a standard model" resolves the model the resend would actually use', () => {
  const model = (id: string, isFree: boolean): CatalogModel =>
    ({
      id,
      name: id,
      source: 'openrouter',
      contextLength: 128_000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['tools', 'temperature'],
      pricing: { promptPerToken: isFree ? 0 : 0.000001, completionPerToken: isFree ? 0 : 0.000002, imagePerImage: 0, requestFlat: 0 },
      isFree,
      costClass: isFree ? 'free_verified' : 'paid',
      supportsImageOutput: false,
      supportsImageInput: false,
      supportsJsonOutput: false,
      roles: [],
      costBand: 'low',
      drawbacks: [],
      possibilities: []
    }) as unknown as CatalogModel;
  const FREE = model('vendor/assistant:free', true);
  const PAID = model('vendor/assistant', false);
  const ASK = 'what is on my calendar this week';

  it('Auto under Free only picks the free model for this message (the refused turn); the action resends on the standard one and leaves Free only on', () => {
    // The precondition the refusal came from: Auto prefers the free model.
    expect(recommendModels(ASK, [FREE, PAID], 1)[0]?.model.id).toBe(FREE.id);
    const plan = standardModelAction({ freeOnly: true, auto: true, reqModel: FREE.id, reqSource: 'openrouter', modelIsFree: true, text: ASK, candidates: [FREE, PAID] });
    expect(plan).toEqual({ kind: 'resend', freeOnlyOff: false, overrideModel: PAID });
  });

  it('a standard model the user just picked (Free only off): resend, never the model picker again', () => {
    expect(standardModelAction({ freeOnly: false, auto: false, reqModel: PAID.id, reqSource: 'openrouter', modelIsFree: false, text: ASK, candidates: [FREE, PAID] })).toEqual({
      kind: 'resend',
      freeOnlyOff: false
    });
  });

  it('a free model the user pinned opens the picker; nothing named under Free only turns it off', () => {
    expect(standardModelAction({ freeOnly: true, auto: false, reqModel: FREE.id, reqSource: 'openrouter', modelIsFree: true, text: ASK, candidates: [FREE, PAID] })).toEqual({ kind: 'pick-model' });
    expect(standardModelAction({ freeOnly: true, auto: true, text: ASK, candidates: [] })).toEqual({ kind: 'resend', freeOnlyOff: true });
    // Auto had only free models to choose from: the picker is the way to name a standard one.
    expect(standardModelAction({ freeOnly: true, auto: true, reqModel: FREE.id, modelIsFree: true, text: ASK, candidates: [FREE] })).toEqual({ kind: 'pick-model' });
  });
});

describe('flagged memory on a direct-provider turn', () => {
  it('is kept under Free only (a direct provider never runs on a free model); an OpenRouter or Auto turn leaves it out', () => {
    setChatMemory(MEMORY, U);
    storeMemoryUpdate(U, MEMORY, { memory: MEMORY, connectorData: true });
    setFreeOnly(true);
    expect(turnSystemPrompt(U, PERSONA, { id: 'vendor-direct-model', source: 'openai' })).toContain('Planning the launch with Dana');
    expect(turnSystemPrompt(U, PERSONA, { id: 'vendor/paid-model', source: 'openrouter' })).toBe(PERSONA);
    expect(turnSystemPrompt(U, PERSONA, {})).toBe(PERSONA);
  });
});
