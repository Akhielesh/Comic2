// The picker's home in the studio: a header slot (banner tier, renders nothing in place) that answers every
// open_model_picker request — the director's chip, the outage card's and banner's "Try {model} instead" (they
// dispatch `{ type: 'open_model_picker', suggest: option.modelId }`), the QualityPanel lock line, the Cost card and
// the header chip — with the picker sheet, and a pick with the change confirm (C/D). The "Switch back to {Current}"
// chip of the switch notice (§3.6 F) names the model just switched away from: its confirm opens directly (with
// "Free now"). Nothing here switches a model on its own: the confirm is the only path, and it is never skipped.

import React, { useCallback, useRef, useState } from 'react';
import type { StudioController } from '../types';
import { ModelChangeConfirm } from './ModelChangeConfirm';
import { ModelPicker } from './ModelPicker';
import { useModelPickerRequests, type ModelPickerRequest } from './openPicker';
import { currentModelId } from './pickerRows';
import { useModelCatalog } from './useModelCatalog';

/** Header slot order: in the banner tier (≥ 1000, under the header), after the model-status banner (1000). */
export const MODEL_PICKER_SLOT_ORDER = 1010;

export interface ModelPickerHostProps {
  studio: Pick<StudioController, 'doc' | 'caps' | 'mode' | 'act' | 'patch'> & { byok?: boolean };
  compact?: boolean;
}

export const ModelPickerHost: React.FC<ModelPickerHostProps> = ({ studio }) => {
  const [picker, setPicker] = useState<{ open: boolean; suggest?: string; seq: number }>({ open: false, seq: 0 });
  const [target, setTarget] = useState<string | null>(null);
  const doc = studio.doc;
  const byok = !!(studio.byok ?? studio.caps?.byok);
  const catalog = useModelCatalog(doc?.id, { enabled: !!doc && (picker.open || !!target) });

  const docRef = useRef(doc);
  docRef.current = doc;
  useModelPickerRequests(
    useCallback((req: ModelPickerRequest) => {
      const d = docRef.current;
      setPicker((p) => ({ open: true, ...(req.suggest ? { suggest: req.suggest } : {}), seq: p.seq + 1 }));
      // "Switch back to {Current}" (§3.6 F) names the model the comic just left: its confirm opens at once, over the
      // picker ("Keep" returns to the list). Any other suggestion is highlighted and picked by the user.
      const back = d?.imageModel?.changes?.[0]?.from;
      setTarget(d && req.suggest && req.suggest === back && req.suggest !== currentModelId(d) ? req.suggest : null);
    }, []),
    !!doc
  );

  if (!doc) return null;
  const mode = studio.mode === 'pro' ? 'pro' : 'easy';
  const close = () => setPicker((p) => ({ open: false, seq: p.seq }));

  return (
    <>
      <ModelPicker
        key={picker.seq}
        open={picker.open}
        onClose={close}
        doc={doc}
        caps={studio.caps}
        byok={byok}
        mode={mode}
        suggest={picker.suggest}
        onPick={(id) => setTarget(id)}
      />
      {target && (
        <ModelChangeConfirm
          open
          doc={doc}
          caps={studio.caps}
          byok={byok}
          mode={mode}
          targetId={target}
          rows={catalog.rows}
          act={studio.act}
          patch={studio.patch}
          onCancel={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            close();
          }}
          onPricesStale={catalog.refresh}
        />
      )}
    </>
  );
};

export default ModelPickerHost;
