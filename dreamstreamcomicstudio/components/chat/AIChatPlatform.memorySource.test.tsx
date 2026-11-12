// @vitest-environment jsdom
// The background memory merge (POST /api/chat/memory) runs on the model source the turn ran on — the
// same source the auto-title gets — so a chat on a direct provider (or Auto locked to one) merges on
// that provider and its key instead of the server's own pick (OpenRouter first). The server keeps every
// connected-account gate (routes/chat.ts /memory); this file checks only what the client sends.
// The real AIChatPlatform renders and sends a message through the composer; storage, the catalog and
// the chat API are faked (no network).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../../services/chatStorage';
import type { CatalogModel } from '../../services/modelCatalog';

const U = '55555555-5555-4555-8555-555555555555';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: U, email: 'tester@example.com' } }) }));
vi.mock('../usage/useUsageAllowance', () => ({ useUsageAllowance: () => null }));
vi.mock('./ChatModelSuggester', () => ({ ChatModelSuggester: () => null }));
vi.mock('./FollowUpChips', () => ({ FollowUpChips: () => null, buildMessages: () => [] }));
vi.mock('./DictationButton', () => ({ DictationButton: () => null }));
vi.mock('../../services/billing', () => ({ getAdminAccess: async () => ({ isAdmin: false }) }));
vi.mock('../../services/clientContext', () => ({ gatherClientContext: async () => undefined }));
vi.mock('../../services/telemetry', () => ({ captureEvent: () => undefined, captureError: () => undefined }));
vi.mock('../../services/sourceGovernance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sourceGovernance')>()),
  isSourceInScope: () => true
}));

const store = vi.hoisted(() => ({ sessions: [] as ChatSession[] }));
vi.mock('../../services/chatStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chatStorage')>()),
  listChatSessions: async () => store.sessions,
  listChatProjects: async () => [],
  saveChatSession: async () => undefined,
  syncFromCloud: async () => undefined
}));

const catalog = vi.hoisted(() => ({ models: [] as CatalogModel[] }));
vi.mock('../../services/modelCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/modelCatalog')>()),
  fetchModelCatalog: async () => ({ models: catalog.models })
}));

const api = vi.hoisted(() => ({
  sendChatMessageStream: vi.fn(),
  updateChatMemory: vi.fn(),
  generateChatTitle: vi.fn()
}));
vi.mock('../../services/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chatApi')>()),
  sendChatMessageStream: api.sendChatMessageStream,
  updateChatMemory: api.updateChatMemory,
  generateChatTitle: api.generateChatTitle
}));

import { AIChatPlatform } from './AIChatPlatform';
import { createEmptySession } from '../../services/chatStorage';

const anthropicModel = {
  id: 'claude-direct-model',
  name: 'Claude (direct)',
  source: 'anthropic',
  contextLength: 200_000,
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: ['tools', 'temperature'],
  pricing: { promptPerToken: 0.000003, completionPerToken: 0.000015, imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  costClass: 'paid',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: false,
  roles: [],
  costBand: 'medium',
  drawbacks: [],
  possibilities: []
} as unknown as CatalogModel;

/** Render the studio on `session`, send one message through the composer, and return the memory call's options. */
const sendOnce = async (session: ChatSession) => {
  store.sessions = [session];
  render(<AIChatPlatform onBack={() => undefined} projects={[]} />);
  const box = (await screen.findByPlaceholderText(/Message the model/)) as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(box, { target: { value: 'Remember that I live in Lisbon' } });
  });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' });
  });
  await waitFor(() => expect(api.updateChatMemory).toHaveBeenCalledTimes(1));
  const [, , options] = api.updateChatMemory.mock.calls[0];
  const [body] = api.sendChatMessageStream.mock.calls[0];
  return { options: options as { source?: string; memoryConnected?: boolean }, turnSource: (body as { source?: string }).source };
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView;
  catalog.models = [anthropicModel];
  api.sendChatMessageStream.mockReset().mockResolvedValue({ text: 'Noted: you live in Lisbon.', model: anthropicModel.id });
  api.updateChatMemory.mockReset().mockResolvedValue({ memory: '- Lives in Lisbon' });
  api.generateChatTitle.mockReset().mockResolvedValue({ title: 'Lisbon' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the background memory merge runs on the turn’s model source', () => {
  it('a chat pinned to a direct provider: the merge carries that source (as the turn did)', async () => {
    const session = createEmptySession({
      modelId: anthropicModel.id,
      modelName: anthropicModel.name,
      source: 'anthropic',
      autoMode: false,
      ownerUserId: U
    });
    const { options, turnSource } = await sendOnce(session);
    expect(turnSource).toBe('anthropic');
    expect(options.source).toBe('anthropic');
    // The sticky connected-memory flag still goes with it (unset memory: false).
    expect(options.memoryConnected).toBe(false);
  });

  it('Auto locked to a provider (the session has no source): the merge carries the source Auto picked', async () => {
    const session = createEmptySession({ autoMode: true, lockedSource: 'anthropic', ownerUserId: U });
    expect(session.source).toBeNull();
    const { options, turnSource } = await sendOnce(session);
    expect(turnSource).toBe('anthropic');
    expect(options.source).toBe('anthropic');
  });
});
