// Conversation thread for Code Studio — a lightweight record of the build conversation (your
// prompts + the agent's outcomes), so iterating feels like chatting with a builder (Lovable/Bolt
// style) rather than firing one-shot prompts. Studio-scoped, dependency-free.

import { create } from 'zustand';

export type StudioMsgRole = 'user' | 'assistant';
export type StudioMsgStatus = 'pending' | 'done' | 'error';

export interface StudioMessage {
  id: string;
  role: StudioMsgRole;
  text: string;
  status: StudioMsgStatus;
}

interface ConversationState {
  messages: StudioMessage[];
  pushUser: (text: string) => void;
  /** Append an assistant message (default pending) and return its id. */
  pushAssistant: (text: string, status?: StudioMsgStatus) => string;
  /** Resolve the most recent assistant message (its text + status). */
  resolveLastAssistant: (text: string, status: StudioMsgStatus) => void;
  clear: () => void;
}

let seq = 0;
const nextId = (): string => `m${Date.now().toString(36)}_${seq++}`;

export const useStudioConversation = create<ConversationState>((set) => ({
  messages: [],
  pushUser: (text) =>
    set((s) => ({ messages: [...s.messages, { id: nextId(), role: 'user', text, status: 'done' }] })),
  pushAssistant: (text, status = 'pending') => {
    const id = nextId();
    set((s) => ({ messages: [...s.messages, { id, role: 'assistant', text, status }] }));
    return id;
  },
  resolveLastAssistant: (text, status) =>
    set((s) => {
      // Last assistant message (search from the end).
      let idx = -1;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i].role === 'assistant') { idx = i; break; }
      }
      if (idx === -1) return s;
      const messages = s.messages.slice();
      messages[idx] = { ...messages[idx], text, status };
      return { messages };
    }),
  clear: () => set({ messages: [] }),
}));
