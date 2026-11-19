// Chat's alert source (notify SPEC §5.9, NF-3): when an answer finishes — or asks something, waits for a confirm, or
// fails — while the person is not looking at that chat, one alert, and an "unseen" mark that Chat's list shows as an
// ink dot until the chat is opened. AIChatPlatform calls chatAnswered after the answer is saved (never on Stop and
// never for a connected-data notice, which are the person's own moves or a calm refusal). The alert holds no answer
// text: a fixed phrase and the chat's own title.

import { getHotSession, markAnswerSeen, markAnswerUnseen } from '../chatStreams';
import { isLooking, lookingTarget, onLookingChange, postAlert } from './bus';
import type { AlertKind, AlertTarget } from './types';

export { CHAT_OPEN_EVENT, requestChatOpen } from './chatOpen';

/**
 * The chat cards that wait on the person, and the alert each one raises (ChatArtifacts.tsx ACTING_ARTIFACT_TYPES lists
 * the same types; chatAlerts.test.ts keeps them equal).
 */
export const CHAT_WAITING_KINDS: Readonly<Record<string, AlertKind>> = Object.freeze({
  clarify: 'chat_question',
  calendar_event_draft: 'chat_confirm'
});

export interface ChatAnswer {
  sessionId: string;
  /** The answer's turn (keys the alert). */
  turnId: string;
  /** The answer's artifacts (only their types are read). */
  artifacts?: readonly { type?: unknown }[] | null;
  failed?: boolean;
  /** The chat's title, when the caller has it; otherwise the newest kept copy's. */
  title?: string;
}

/** The kind an answer raises: a failure, a card that waits on the person, or a plain answer. */
export function chatAlertKind(answer: Pick<ChatAnswer, 'artifacts' | 'failed'>): AlertKind {
  if (answer.failed) return 'chat_failed';
  const types = (answer.artifacts ?? []).map((a) => (a && typeof a.type === 'string' ? a.type : ''));
  if (types.includes('clarify')) return CHAT_WAITING_KINDS.clarify;
  if (types.includes('calendar_event_draft')) return CHAT_WAITING_KINDS.calendar_event_draft;
  return 'chat_reply';
}

let seq = 0;

/** An answer landed in a chat: mark it unseen unless the person looks at it, and post its alert. */
export function chatAnswered(answer: ChatAnswer): void {
  try {
    if (!answer?.sessionId) return;
    const target: AlertTarget = { app: 'chat', id: answer.sessionId };
    if (!isLooking(target)) markAnswerUnseen(answer.sessionId);
    const kind = chatAlertKind(answer);
    seq += 1;
    postAlert({
      kind,
      key: `chat:${answer.sessionId}:${answer.turnId}:${kind}:${seq}`,
      target,
      title: answer.title ?? getHotSession(answer.sessionId)?.title ?? ''
    });
  } catch {
    /* an alert never breaks the chat */
  }
}

/** While mounted: a chat the person comes back to (the tab or the window again) is seen. Returns the unsubscribe. */
export function watchChatSeen(): () => void {
  return onLookingChange(() => {
    const target = lookingTarget();
    if (target?.app === 'chat' && isLooking(target)) markAnswerSeen(target.id);
  });
}
