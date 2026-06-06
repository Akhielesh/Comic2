import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioConversation } from './conversationStore';

beforeEach(() => useStudioConversation.getState().clear());

describe('studioConversation store', () => {
  it('appends user + assistant messages in order', () => {
    const s = useStudioConversation.getState();
    s.pushUser('build a todo app');
    s.pushAssistant('Generating your app…');
    const { messages } = useStudioConversation.getState();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].text).toBe('build a todo app');
    expect(messages[0].status).toBe('done');
    expect(messages[1].status).toBe('pending');
  });

  it('resolves the most recent assistant message', () => {
    const s = useStudioConversation.getState();
    s.pushUser('x');
    s.pushAssistant('Generating…');
    s.resolveLastAssistant('Built "Todo" — 3 file(s).', 'done');
    const last = useStudioConversation.getState().messages.at(-1)!;
    expect(last.text).toBe('Built "Todo" — 3 file(s).');
    expect(last.status).toBe('done');
  });

  it('resolveLastAssistant only touches the last assistant, not user messages', () => {
    const s = useStudioConversation.getState();
    s.pushUser('a');
    s.pushAssistant('first', 'done');
    s.pushUser('b');
    s.pushAssistant('second', 'pending');
    s.resolveLastAssistant('second done', 'error');
    const m = useStudioConversation.getState().messages;
    expect(m[1].text).toBe('first'); // unchanged
    expect(m[3]).toMatchObject({ text: 'second done', status: 'error' });
  });

  it('clear empties the thread', () => {
    const s = useStudioConversation.getState();
    s.pushUser('x');
    s.clear();
    expect(useStudioConversation.getState().messages).toHaveLength(0);
  });
});
