// @vitest-environment jsdom
// Chat Studio's half of connected-account privacy (wave notes 1–3, docs/DATA_CONNECTORS.md):
//  - the echo: an assistant turn connected content entered goes back to the server marked;
//  - the sticky memory flag: memory distilled from connected content stays out of Free only turns
//    and turns on a free model, until the memory is cleared;
//  - the calm notice: a refused turn becomes a notice, never an error, and never history.
// Real chatStorage, freeOnlyMode and localStorage; the server's own reader judges the echo.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../usage/useUsageAllowance', () => ({ useUsageAllowance: () => null }));

import {
  applyVariant,
  composeSystemPrompt,
  isHistoryTurn,
  storeMemoryUpdate,
  toNoticeTurn,
  toRequestMessage,
  turnSystemPrompt,
  withAnswer
} from './AIChatPlatform';
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
