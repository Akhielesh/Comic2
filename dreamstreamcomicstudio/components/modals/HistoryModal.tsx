import React, { useId } from 'react';
import { X } from 'lucide-react';
import { ModalPortal } from './ModalPortal';
import { ComicPanel } from '../../types';
import { buttonClasses } from '../ds/Button';
import { DIALOG_TITLE, HAIRLINE, OVERLAY, RADIUS_CONTROL, SCRIM, Z } from '../chat/studioDesign';

interface HistoryModalProps {
    onClose: () => void;
    selectedPanel: ComicPanel;
    historyUrls: string[];
    onUpdatePanel: (panelId: string, imageId: string, imageUrl: string) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({ onClose, selectedPanel, historyUrls, onUpdatePanel }) => {
    const titleId = useId();
    return (
        <ModalPortal>
            <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4`} onClick={onClose}>
                <div role="dialog" aria-labelledby={titleId} className={`${OVERLAY} flex max-h-[80vh] w-full max-w-4xl flex-col p-4 sm:p-6`} onClick={e => e.stopPropagation()}>
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h3 id={titleId} className={`min-w-0 ${DIALOG_TITLE}`}>Version History for Panel</h3>
                        <button onClick={onClose} className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })} aria-label="Close"><X /></button>
                    </div>
                    <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto pr-2 custom-scrollbar md:grid-cols-4">
                        {historyUrls.map((url, idx) => (
                            <div key={idx} className="aspect-square relative group">
                                <img src={url} className={`h-full w-full object-cover ${RADIUS_CONTROL} ${HAIRLINE}`} alt={`History version ${idx + 1}`} />
                                <button onClick={() => {
                                    const imageId = selectedPanel.imageIdHistory?.[idx];
                                    if (imageId) onUpdatePanel(selectedPanel.id, imageId, url);
                                    onClose();
                                }} className={`absolute inset-0 hidden items-center justify-center bg-black/60 text-sm font-semibold text-white group-hover:flex ${RADIUS_CONTROL}`}>Use This Version</button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
};
