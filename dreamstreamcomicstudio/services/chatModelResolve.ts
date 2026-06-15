export interface ChatModelLock {
  id: string;
  source: string;
}

export interface ApplyLockedChatModelArgs {
  /** A model the user locked globally in Chat Settings (or null when none is set). */
  locked: ChatModelLock | null;
  /** True when a one-off override (suggester / branch) is driving this message. */
  hasOverride: boolean;
  /** True when the active chat is on Auto (no explicit per-chat model pinned). */
  autoMode: boolean;
  /** The model explicitly pinned on the active chat (null/undefined on Auto). */
  sessionModelId: string | null | undefined;
}

/**
 * Decide whether the globally-locked chat model should replace the model already resolved for
 * THIS message.
 *
 * The rule, in priority order:
 *   1. A one-off override (the model suggester, or "branch with a new model") always wins —
 *      so the lock never applies when an override is present.
 *   2. A chat with its OWN explicitly pinned model keeps it. A global lock must never silently
 *      swap the model a user picked for a specific chat — doing so was exactly the bug where
 *      "switching between chats showed/used the previous chat's model instead of the one set".
 *   3. Otherwise (the chat is on Auto, or has no pinned model) the global lock applies — which
 *      is what makes "lock the chat model in Settings" actually take effect as a default.
 *
 * Returns the lock to apply, or null to leave the already-resolved model untouched.
 */
export const applyLockedChatModel = ({
  locked,
  hasOverride,
  autoMode,
  sessionModelId
}: ApplyLockedChatModelArgs): ChatModelLock | null => {
  if (!locked || hasOverride) return null;
  const chatHasOwnPin = !autoMode && Boolean(sessionModelId);
  if (chatHasOwnPin) return null;
  return locked;
};
