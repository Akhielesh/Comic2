// The `open_model_picker` client action (shared/comic/doc.ts ClientAction; models.md §3.8): a director chip, the
// outage card's "Try {model} instead" and the status banner (reliability/**: `{ type: 'open_model_picker',
// suggest: option.modelId }`), the QualityPanel lock line, the Cost card and the header chip all OPEN the picker —
// nothing here changes the model. useStudio's runClientAction raises the request; the mounted ModelPickerHost
// (a header slot of this feature) answers it, the same pattern as the Share sheet and Comic settings.
// Leaf module: no React components, so useStudio and QualityPanel can share the event without import cycles.

import { useEffect, useRef } from 'react';
import { getImageModel } from '../../../shared/comic/models';

/** useStudio.ts keeps the same string (it never imports this feature); a test checks they agree. */
export const OPEN_MODEL_PICKER_EVENT = 'ds:open-model-picker';

export interface ModelPickerRequest {
  /** A registry id to highlight (the picker never switches by itself; picking still goes through the confirm). */
  suggest?: string;
}

/** Only a model the registry knows (chips come from the model; a route id resolves to its registry id). */
export const suggestionOf = (value: unknown): string | undefined => (typeof value === 'string' && value ? getImageModel(value.slice(0, 160))?.id : undefined);

/** Ask the mounted picker host to open; true when something handled it. */
export const requestOpenModelPicker = (req: ModelPickerRequest = {}): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return false;
  const suggest = suggestionOf(req.suggest);
  return !window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER_EVENT, { cancelable: true, detail: suggest ? { suggest } : {} }));
};

/** The host's side: open the picker for every request (the suggestion validated again). */
export const useModelPickerRequests = (open: (req: ModelPickerRequest) => void, enabled = true): void => {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const onRequest = (e: Event) => {
      e.preventDefault();
      const suggest = suggestionOf((e as CustomEvent<{ suggest?: unknown }>).detail?.suggest);
      openRef.current(suggest ? { suggest } : {});
    };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
  }, [enabled]);
};
