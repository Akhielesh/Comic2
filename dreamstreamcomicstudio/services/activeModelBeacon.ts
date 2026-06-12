// Active-model beacon — lets each studio surface publish "the model actually in use
// right now" so global chrome (the header usage pill) reflects reality instead of
// only the comic-generation defaults. Chat Studio publishes its per-conversation
// pick (or Auto); surfaces clear it on unmount. Read-only consumers subscribe via
// onActiveModelChanged.

export interface ActiveModelInfo {
  surface: 'chat' | 'code' | 'comic';
  /** Human-friendly label, e.g. "Gemini 2.5 Flash" or "Auto · best model per message". */
  label: string;
  /** Optional qualifier, e.g. the source ("OpenRouter"). */
  detail?: string;
}

export const ACTIVE_MODEL_CHANGED = 'dreamstream:active-model:changed';

let current: ActiveModelInfo | null = null;

export const setActiveModelInfo = (info: ActiveModelInfo | null): void => {
  current = info;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACTIVE_MODEL_CHANGED));
  }
};

export const getActiveModelInfo = (): ActiveModelInfo | null => current;

export const onActiveModelChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const wrapped = () => handler();
  window.addEventListener(ACTIVE_MODEL_CHANGED, wrapped);
  return () => window.removeEventListener(ACTIVE_MODEL_CHANGED, wrapped);
};
