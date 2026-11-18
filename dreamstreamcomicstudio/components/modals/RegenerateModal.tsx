import React, { useId, useState } from 'react';
import { X, RefreshCw, Wand2 } from 'lucide-react';
import { Button } from '../Button';
import { ModalPortal } from './ModalPortal';
import { buttonClasses } from '../ds/Button';
import { DIALOG_TITLE, FIELD, HAIRLINE, MUTED, OVERLAY, RADIUS_CONTROL, SCRIM, Z } from '../chat/studioDesign';

interface RegenerateModalProps {
  currentImageUrl: string;
  onConfirm: (instructions: string) => void;
  onClose: () => void;
  isLoading: boolean;
}

export const RegenerateModal: React.FC<RegenerateModalProps> = ({ currentImageUrl, onConfirm, onClose, isLoading }) => {
  const [instructions, setInstructions] = useState('');
  const titleId = useId();
  const fieldId = useId();

  return (
    <ModalPortal>
      <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center overflow-y-auto p-4`} onClick={onClose}>
        <div role="dialog" aria-labelledby={titleId} className={`${OVERLAY} max-h-[calc(var(--app-h,100dvh)-2rem)] w-full max-w-2xl overflow-y-auto`} onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] px-4 py-3 sm:px-6">
              <h3 id={titleId} className={`flex min-w-0 items-center gap-2 ${DIALOG_TITLE}`}><Wand2 className="size-5 shrink-0" aria-hidden="true"/> Regenerate Panel</h3>
              <button onClick={onClose} aria-label="Close" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })}><X className="size-5"/></button>
          </div>
          
          <div className="space-y-6 p-4 sm:p-6">
              <div className="flex flex-col gap-6 sm:flex-row">
                  <div className={`aspect-square w-full overflow-hidden bg-[var(--ds-well-strong)] sm:w-1/2 ${RADIUS_CONTROL} ${HAIRLINE}`}>
                      <img src={currentImageUrl} className="w-full h-full object-cover opacity-75" />
                  </div>
                  <div className="w-full space-y-2 sm:w-1/2">
                      <label htmlFor={fieldId} className="block text-sm font-medium text-[var(--ds-ink)]">What should be different?</label>
                      <textarea 
                          value={instructions}
                          onChange={(e) => setInstructions(e.target.value)}
                          placeholder="e.g. Make the lighting darker, zoom in on the face, change the background to red..."
                          id={fieldId}
                          className={`${FIELD} block h-32 w-full resize-none p-3 text-sm`}
                      />
                      <p className={`text-xs ${MUTED}`}>The AI will use the original style and characters but apply your changes.</p>
                  </div>
              </div>
              
              <div className="flex flex-wrap justify-end gap-3">
                  <Button variant="outline" onClick={onClose}>Cancel</Button>
                  <Button 
                      onClick={() => onConfirm(instructions)} 
                      isLoading={isLoading} 
                      icon={<RefreshCw className="w-4 h-4"/>}
                      disabled={!instructions.trim()}
                  >
                      Regenerate
                  </Button>
              </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
