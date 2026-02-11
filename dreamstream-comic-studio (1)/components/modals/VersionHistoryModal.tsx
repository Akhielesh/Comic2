import React from 'react';
import { ProjectVersion } from '../../types';
import { Clock, RotateCcw, Trash2, X } from 'lucide-react';

interface VersionHistoryModalProps {
    versions: ProjectVersion[];
    onRestore: (version: ProjectVersion) => void;
    onDelete: (versionId: string) => void;
    onClose: () => void;
}

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({ versions, onRestore, onDelete, onClose }) => {
    return (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
            <div className="bg-white border-4 border-black rounded-2xl w-full max-w-lg shadow-comic max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between p-4 border-b-4 border-black bg-brand-yellow">
                    <div className="flex items-center gap-2">
                        <Clock className="w-6 h-6" />
                        <h2 className="text-xl font-display">Version History</h2>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-black/10 rounded-full transition-colors">
                        <X size={24} />
                    </button>
                </div>

                <div className="p-4 overflow-y-auto flex-1 space-y-3 custom-scrollbar">
                    {versions.length === 0 ? (
                        <div className="text-center py-12 text-slate-500 font-comic">
                            No saved versions yet.
                            <br />
                            <span className="text-xs">Save a version in the editor to create a checkpoint.</span>
                        </div>
                    ) : (
                        versions.slice().reverse().map((v) => (
                            <div key={v.id} className="border-2 border-black rounded-xl p-4 flex items-center justify-between group hover:bg-slate-50 transition-colors">
                                <div>
                                    <div className="font-bold text-lg">{v.name}</div>
                                    <div className="text-xs text-slate-500 font-mono">
                                        {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(v.createdAt)}
                                    </div>
                                    <div className="text-xs mt-1 bg-slate-100 inline-block px-2 py-0.5 rounded border border-slate-300">
                                        Step: {v.state.step} • {v.state.panels.length} Panels
                                    </div>
                                </div>
                                <div className="flex gap-2 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={() => {
                                            if (confirm(`Restore "${v.name}"? Current unsaved changes will be lost.`)) {
                                                onRestore(v);
                                            }
                                        }}
                                        className="p-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 border-2 border-transparent hover:border-blue-300 transition-all"
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
                                        className="p-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 border-2 border-transparent hover:border-red-300 transition-all"
                                        title="Delete version"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="p-4 border-t-4 border-black bg-slate-50 text-xs text-center text-slate-500 font-bold">
                    Versions are stored within the project file.
                </div>
            </div>
        </div>
    );
};
