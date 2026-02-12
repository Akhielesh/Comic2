import React from 'react';
import { X, Download } from 'lucide-react';
import { Button } from '../Button';
import { ModalPortal } from './ModalPortal';

interface ImagePreviewModalProps {
  imageUrl: string;
  title?: string;
  onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ imageUrl, title, onClose }) => {
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md" onClick={onClose}>
        <div className="relative max-w-5xl max-h-[90vh] w-full flex flex-col items-center" onClick={e => e.stopPropagation()}>
          <div className="absolute top-0 right-0 -mt-12 flex items-center gap-4">
               <a href={imageUrl} download={`dreamstream-${Date.now()}.png`} className="text-white hover:text-brand-yellow transition-colors" onClick={(e) => e.stopPropagation()}>
                  <Download className="w-8 h-8" />
               </a>
               <button onClick={onClose} className="text-white hover:text-brand-red transition-colors">
                  <X className="w-8 h-8" />
               </button>
          </div>
          
          <img src={imageUrl} alt={title || "Preview"} className="max-w-full max-h-[80vh] rounded-lg border-4 border-black shadow-comic" />
          
          {title && (
              <div className="mt-4 bg-white px-6 py-2 rounded-full border-2 border-black font-display text-xl shadow-lg">
                  {title}
              </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
};
