import React, { useEffect, useId, useState } from 'react';
import { X, User, Trash2, Import } from 'lucide-react';
import { CharacterLibraryItem, Character } from '../../types';
import { getLibraryCharacters, deleteCharacterFromLibrary } from '../../services/characterLibrary';
import { Button } from '../Button';
import { buttonClasses } from '../ds/Button';
import { DIALOG_TITLE, HAIRLINE, INK, MUTED, OVERLAY, RADIUS_CONTROL, RADIUS_PANEL, SCRIM, SHADOW_SOFT, STATUS_SURFACE, TONE_TEXT, Z } from '../chat/studioDesign';

interface CharacterLibraryModalProps {
    onClose: () => void;
    onSelect: (character: Character) => void;
}

export const CharacterLibraryModal: React.FC<CharacterLibraryModalProps> = ({ onClose, onSelect }) => {
    const [items, setItems] = useState<CharacterLibraryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const titleId = useId();

    useEffect(() => {
        loadLibrary();
    }, []);

    const loadLibrary = async () => {
        setLoading(true);
        try {
            const data = await getLibraryCharacters();
            setItems(data);
        } catch (e: any) {
            setError(e.message || "Failed to load library.");
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!confirm("Remove this character from your library?")) return;
        try {
            await deleteCharacterFromLibrary(id);
            setItems(prev => prev.filter(item => item.id !== id));
        } catch (e) {
            alert("Failed to delete character.");
        }
    };

    return (
        <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4 animate-fade-in motion-reduce:animate-none`}>
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`${OVERLAY} flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden`}>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] p-4">
                    <h2 id={titleId} className={`flex min-w-0 items-center gap-2 ${DIALOG_TITLE}`}>
                        <User className="size-5 shrink-0" aria-hidden="true" /> Character Library
                    </h2>
                    <button onClick={onClose} aria-label="Close" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })}>
                        <X size={24} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto bg-[var(--ds-well)] p-4 sm:p-6">
                    {loading ? (
                        <div className="flex h-40 flex-col items-center justify-center gap-3" role="status">
                            <div className="size-8 animate-spin rounded-[var(--ds-radius-pill)] border-4 border-[var(--ds-well-strong)] border-t-[var(--ds-ink)] motion-reduce:animate-none" aria-hidden="true" />
                            <p className={`text-sm ${MUTED}`}>Opening the vault...</p>
                        </div>
                    ) : error ? (
                        <div className={`border p-8 text-center ${RADIUS_PANEL} ${STATUS_SURFACE.error}`}>
                            <p className={`mb-2 font-semibold ${TONE_TEXT.danger}`}>Library Error</p>
                            <p className={`mb-4 text-sm [overflow-wrap:anywhere] ${INK}`}>{error}</p>
                            {error.includes("migration") && (
                                <div className={`overflow-x-auto p-3 text-left font-mono text-xs ${RADIUS_CONTROL} bg-[var(--ds-ink)] text-[var(--ds-canvas)]`}>
                                    Is the `character_library` table missing? Ask me for the SQL migration code!
                                </div>
                            )}
                        </div>
                    ) : items.length === 0 ? (
                        <div className={`py-12 text-center ${MUTED}`}>
                            <User size={48} className="mx-auto mb-4 opacity-50" aria-hidden="true" />
                            <p className={`mb-2 text-lg font-semibold ${INK}`}>Library is Empty</p>
                            <p className="text-sm">Save characters from your projects to see them here.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                            {items.map((item) => (
                                <div
                                    key={item.id}
                                    onClick={() => onSelect(item)}
                                    className={`group flex cursor-pointer flex-col overflow-hidden bg-[var(--ds-surface)] transition-[border-color,box-shadow] duration-[var(--ds-motion-medium)] hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)] hover:shadow-[shadow:var(--ds-shadow-panel)] ${RADIUS_PANEL} ${HAIRLINE} ${SHADOW_SOFT}`}
                                >
                                    <div className="relative aspect-square border-b border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]">
                                        {item.imageUrl ? (
                                            <img src={item.imageUrl} className="w-full h-full object-cover" />
                                        ) : (
                                            <div className={`flex h-full w-full items-center justify-center ${MUTED}`}>
                                                <User size={32} />
                                            </div>
                                        )}
                                        <button
                                            onClick={(e) => handleDelete(item.id, e)}
                                            className={buttonClasses({ variant: 'outline', size: 'icon', className: `absolute right-2 top-2 size-8 text-[var(--ds-danger-text)] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100` })}
                                            aria-label="Delete from Library"
                                            title="Delete from Library"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                        {/* Hover Overlay */}
                                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[color:color-mix(in_srgb,var(--ds-ink)_8%,transparent)] opacity-0 transition-opacity duration-[var(--ds-motion-medium)] group-hover:opacity-100">
                                            <div className={`flex items-center gap-1 rounded-[var(--ds-radius-pill)] bg-[var(--ds-raised)] px-3 py-1 text-xs font-semibold ${INK} ${SHADOW_SOFT}`}>
                                                <Import size={12} /> Select
                                            </div>
                                        </div>
                                    </div>
                                    <div className="p-3">
                                        <h3 className={`truncate font-semibold ${INK}`} title={item.name}>{item.name}</h3>
                                        <p className={`mt-1 h-8 line-clamp-2 text-xs ${MUTED}`}>{item.description}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex justify-end border-t border-[var(--ds-hairline)] p-4">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                </div>
            </div>
        </div>
    );
};
