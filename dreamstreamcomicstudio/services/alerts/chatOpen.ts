// Opening a chat from an alert (notify SPEC §5.9): App navigates to Chat; a Chat that is already on screen hears this
// event and switches to the chat. Its own tiny module so the eager AlertsHost can send it without loading the core.

/** Asks a mounted Chat to open a chat ({ detail: { id } }). */
export const CHAT_OPEN_EVENT = 'ds:chat-open';

/** Ask a mounted Chat to open this chat (nothing listens when Chat is not on screen; it opens the last chat then). */
export function requestChatOpen(sessionId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { id: sessionId } }));
  } catch {
    /* no window */
  }
}
