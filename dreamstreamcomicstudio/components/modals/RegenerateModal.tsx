import React, { useState } from 'react';
import { X, RefreshCw, Wand2 } from 'lucide-react';
import { Button } from '../Button';
import { ModalPortal } from './ModalPortal';

interface RegenerateModalProps {
  currentImageUrl: string;
  onConfirm: (instructions: string) => void;
  onClose: () => void;
  isLoading: boolean;
}

export const RegenerateModal: React.FC<RegenerateModalProps> = ({ currentImageUrl, onConfirm, onClose, isLoading }) => {
  const [instructions, setInstructions] = useState('');

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-xl border-4 border-black shadow-comic max-w-2xl w-full overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="bg-brand-yellow p-4 border-b-4 border-black flex justify-between items-center">
              <h3 className="font-display text-2xl flex items-center gap-2"><Wand2 className="w-6 h-6"/> Regenerate Panel</h3>
              <button onClick={onClose}><X className="w-6 h-6 hover:scale-110 transition-transform"/></button>
          </div>
          
          <div className="p-6 space-y-6">
              <div className="flex gap-6">
                  <div className="w-1/2 aspect-square bg-slate-100 rounded-lg border-2 border-black overflow-hidden">
                      <img src={currentImageUrl} className="w-full h-full object-cover opacity-75" />
                  </div>
                  <div className="w-1/2 space-y-4">
                      <label className="font-bold font-comic block">What should be different?</label>
                      <textarea 
                          value={instructions}
                          onChange={(e) => setInstructions(e.target.value)}
                          placeholder="e.g. Make the lighting darker, zoom in on the face, change the background to red..."
                          className="w-full h-32 bg-slate-50 border-2 border-black rounded-lg p-3 text-sm resize-none focus:ring-0 focus:shadow-comic transition-all"
                      />
                      <p className="text-xs text-slate-500">The AI will use the original style and characters but apply your changes.</p>
                  </div>
              </div>
              
              <div className="flex justify-end gap-3">
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
