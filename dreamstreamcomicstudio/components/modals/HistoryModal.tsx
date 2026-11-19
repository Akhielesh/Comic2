import React, { useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import { ModalPortal } from './ModalPortal';
import { ComicPanel } from '../../types';
import { Button } from '../ds';
import { buttonClasses } from '../ds/Button';
import { cn } from '../../lib/utils';
import { CHIP, CHIP_VARIANT, DIALOG_TITLE, FOCUS_RING, HAIRLINE, MUTED, OVERLAY, RADIUS_CONTROL, SCRIM, Z } from '../chat/studioDesign';

interface HistoryModalProps {
    onClose: () => void;
    selectedPanel: ComicPanel;
    historyUrls: string[];
    onUpdatePanel: (panelId: string, imageId: string, imageUrl: string) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({ onClose, selectedPanel, historyUrls, onUpdatePanel }) => {
    const titleId = useId();
    // The version the panel shows now: the stored image id when it is in the history, else the image url.
    const currentIdx = (() => {
        const byId = selectedPanel.imageId ? (selectedPanel.imageIdHistory || []).indexOf(selectedPanel.imageId) : -1;
        if (byId >= 0) return byId;
        return selectedPanel.imageUrl ? historyUrls.indexOf(selectedPanel.imageUrl) : -1;
    })();
    const [selectedIdx, setSelectedIdx] = useState<number>(currentIdx);
    const selectedImageId = selectedIdx >= 0 ? selectedPanel.imageIdHistory?.[selectedIdx] : undefined;
    const canUse = selectedIdx >= 0 && selectedIdx !== currentIdx && !!selectedImageId;

    const applySelected = () => {
        if (!canUse || !selectedImageId) return;
        onUpdatePanel(selectedPanel.id, selectedImageId, historyUrls[selectedIdx]);
        onClose();
    };

    return (
        <ModalPortal>
            <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4`} onClick={onClose}>
                <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`${OVERLAY} flex max-h-[80vh] w-full max-w-4xl flex-col p-4 sm:p-6`} onClick={e => e.stopPropagation()}>
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 id={titleId} className={`min-w-0 ${DIALOG_TITLE}`}>Version History for Panel</h2>
                        <button onClick={onClose} className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })} aria-label="Close"><X /></button>
                    </div>
                    <div role="radiogroup" aria-labelledby={titleId} className="grid flex-1 grid-cols-2 content-start gap-4 overflow-y-auto p-1 custom-scrollbar md:grid-cols-4">
                        {historyUrls.map((url, idx) => {
                            const selected = idx === selectedIdx;
                            const current = idx === currentIdx;
                            return (
                                <button
                                    key={idx}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setSelectedIdx(idx)}
                                    className={`flex min-w-0 flex-col gap-2 p-1 text-left ${RADIUS_CONTROL} ${FOCUS_RING}`}
                                >
                                    <span className={cn('relative block aspect-square w-full overflow-hidden', RADIUS_CONTROL, HAIRLINE, selected && 'outline outline-2 outline-offset-2 outline-[color:var(--ds-ink)]')}>
                                        <img src={url} className="h-full w-full object-cover" alt={`Version ${idx + 1}`} />
                                    </span>
                                    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                                        <span className="font-medium text-[var(--ds-ink)]">Version {idx + 1}</span>
                                        {current && <span className={cn(CHIP, CHIP_VARIANT.filled)}>Current</span>}
                                        {selected && !current && <Check className={cn('size-4', MUTED)} aria-hidden="true" />}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--ds-hairline)] pt-4">
                        <Button variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button onClick={applySelected} disabled={!canUse}>Use this version</Button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
};
