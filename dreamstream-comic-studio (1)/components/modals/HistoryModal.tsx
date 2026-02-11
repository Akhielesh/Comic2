import React from 'react';
import { X } from 'lucide-react';
import { ModalPortal } from './ModalPortal';
import { ComicPanel } from '../../types';

interface HistoryModalProps {
    onClose: () => void;
    selectedPanel: ComicPanel;
    historyUrls: string[];
    onUpdatePanel: (panelId: string, imageId: string, imageUrl: string) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({ onClose, selectedPanel, historyUrls, onUpdatePanel }) => {
    return (
        <ModalPortal>
            <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
                <div className="bg-white rounded-xl border-4 border-black shadow-comic w-full max-w-4xl max-h-[80vh] flex flex-col p-6" onClick={e => e.stopPropagation()}>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-2xl font-display">Version History for Panel</h3>
                        <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-100" aria-label="Close"><X /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto grid grid-cols-2 md:grid-cols-4 gap-4 custom-scrollbar pr-2">
                        {historyUrls.map((url, idx) => (
                            <div key={idx} className="aspect-square relative group">
                                <img src={url} className="w-full h-full object-cover rounded-lg border-2 border-black" alt={`History version ${idx + 1}`} />
                                <button onClick={() => {
                                    const imageId = selectedPanel.imageIdHistory?.[idx];
                                    if (imageId) onUpdatePanel(selectedPanel.id, imageId, url);
                                    onClose();
                                }} className="absolute inset-0 bg-black/50 text-white font-bold text-sm items-center justify-center hidden group-hover:flex">Use This Version</button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
};
