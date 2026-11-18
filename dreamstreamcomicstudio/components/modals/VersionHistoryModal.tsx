import React, { useId } from 'react';
import { ProjectVersion } from '../../types';
import { Clock, RotateCcw, Trash2, X } from 'lucide-react';
import { buttonClasses } from '../ds/Button';
import { CHIP, CHIP_VARIANT, DIALOG_TITLE, HAIRLINE, INK, MUTED, OVERLAY, RADIUS_PANEL, SCRIM, Z } from '../chat/studioDesign';

const ROW_ACTION = buttonClasses({ variant: 'outline', size: 'icon', className: 'size-9' });

interface VersionHistoryModalProps {
    versions: ProjectVersion[];
    onRestore: (version: ProjectVersion) => void;
    onDelete: (versionId: string) => void;
    onClose: () => void;
}

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({ versions, onRestore, onDelete, onClose }) => {
    const titleId = useId();
    return (
        <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4 animate-fade-in motion-reduce:animate-none`}>
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`${OVERLAY} flex max-h-[80vh] w-full max-w-lg flex-col`}>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] p-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <Clock className="size-5 shrink-0" aria-hidden="true" />
                        <h2 id={titleId} className={DIALOG_TITLE}>Version History</h2>
                    </div>
                    <button onClick={onClose} aria-label="Close" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })}>
                        <X size={24} />
                    </button>
                </div>

                <div className="p-4 overflow-y-auto flex-1 space-y-3 custom-scrollbar">
                    {versions.length === 0 ? (
                        <div className={`py-12 text-center text-sm ${MUTED}`}>
                            No saved versions yet.
                            <br />
                            <span className="text-xs">Save a version in the editor to create a checkpoint.</span>
                        </div>
                    ) : (
                        versions.slice().reverse().map((v) => (
                            <div key={v.id} className={`group flex items-center justify-between gap-3 p-4 transition-colors duration-[var(--ds-motion-medium)] hover:bg-[var(--ds-hover)] ${RADIUS_PANEL} ${HAIRLINE}`}>
                                <div className="min-w-0">
                                    <div className={`text-base font-semibold [overflow-wrap:anywhere] ${INK}`}>{v.name}</div>
                                    <div className={`font-mono text-xs ${MUTED}`}>
                                        {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(v.createdAt)}
                                    </div>
                                    <div className={`mt-1 ${CHIP} ${CHIP_VARIANT.filled}`}>
                                        Step: {v.state.step} • {v.state.panels.length} Panels
                                    </div>
                                    {(v.reason || v.snapshotHash) && (
                                        <div className={`mt-1 font-mono text-[11px] [overflow-wrap:anywhere] ${MUTED}`}>
                                            {v.reason ? `Reason: ${v.reason}` : ''}{v.reason && v.snapshotHash ? ' • ' : ''}{v.snapshotHash ? `Hash: ${v.snapshotHash}` : ''}
                                        </div>
                                    )}
                                </div>
                                <div className="flex shrink-0 gap-2 opacity-100 transition-opacity duration-[var(--ds-motion-medium)] focus-within:opacity-100 group-hover:opacity-100 md:opacity-0">
                                    <button
                                        onClick={() => {
                                            if (confirm(`Restore "${v.name}"? Current unsaved changes will be lost.`)) {
                                                onRestore(v);
                                            }
                                        }}
                                        className={ROW_ACTION}
                                        aria-label="Restore this version"
                                        title="Restore this version"
                                    >
                                        <RotateCcw size={18} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (confirm(`Delete version "${v.name}"?`)) {
                                                onDelete(v.id);
                                            }
                                        }}
                                        className={`${ROW_ACTION} text-[var(--ds-danger-text)]`}
                                        aria-label="Delete version"
                                        title="Delete version"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className={`border-t border-[var(--ds-hairline)] p-4 text-center text-xs font-medium ${MUTED}`}>
                    Versions are stored within the project file.
                </div>
            </div>
        </div>
    );
};
