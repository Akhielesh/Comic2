import React, { useState, useEffect } from 'react';
import { X, User, Trash2, Import } from 'lucide-react';
import { CharacterLibraryItem, Character } from '../../types';
import { getLibraryCharacters, deleteCharacterFromLibrary } from '../../services/characterLibrary';
import { Button } from '../Button';

interface CharacterLibraryModalProps {
    onClose: () => void;
    onSelect: (character: Character) => void;
}

export const CharacterLibraryModal: React.FC<CharacterLibraryModalProps> = ({ onClose, onSelect }) => {
    const [items, setItems] = useState<CharacterLibraryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh] border-4 border-black">
                <div className="p-4 border-b-2 border-black flex justify-between items-center bg-slate-50 rounded-t-lg">
                    <h2 className="text-2xl font-display font-bold flex items-center gap-2">
                        <User className="text-brand-blue" /> Character Library
                    </h2>
                    <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-full transition-colors">
                        <X size={24} />
                    </button>
                </div>

                <div className="p-6 overflow-y-auto flex-1 bg-slate-100">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-40 gap-3">
                            <div className="animate-spin w-8 h-8 border-4 border-brand-blue border-t-transparent rounded-full" />
                            <p className="font-comic text-slate-500">Opening the vault...</p>
                        </div>
                    ) : error ? (
                        <div className="text-center p-8 bg-white rounded-lg border-2 border-dashed border-red-300">
                            <p className="text-red-500 font-bold mb-2">Library Error</p>
                            <p className="text-sm text-slate-600 mb-4">{error}</p>
                            {error.includes("migration") && (
                                <div className="text-xs bg-slate-800 text-white p-3 rounded text-left overflow-x-auto font-mono">
                                    Is the `character_library` table missing? Ask me for the SQL migration code!
                                </div>
                            )}
                        </div>
                    ) : items.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            <User size={48} className="mx-auto mb-4 opacity-50" />
                            <p className="font-display text-xl mb-2">Library is Empty</p>
                            <p className="text-sm">Save characters from your projects to see them here.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                            {items.map((item) => (
                                <div
                                    key={item.id}
                                    onClick={() => onSelect(item)}
                                    className="bg-white border-2 border-slate-200 hover:border-brand-blue hover:shadow-lg rounded-lg overflow-hidden cursor-pointer transition-all group flex flex-col"
                                >
                                    <div className="aspect-square bg-slate-50 relative border-b border-slate-100">
                                        {item.imageUrl ? (
                                            <img src={item.imageUrl} className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-slate-300">
                                                <User size={32} />
                                            </div>
                                        )}
                                        <button
                                            onClick={(e) => handleDelete(item.id, e)}
                                            className="absolute top-2 right-2 p-1.5 bg-white/90 text-red-500 rounded hover:bg-red-500 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity border border-slate-200"
                                            title="Delete from Library"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                        {/* Hover Overlay */}
                                        <div className="absolute inset-0 bg-brand-blue/10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                                            <div className="bg-white px-3 py-1 rounded-full shadow font-bold text-xs text-brand-blue flex items-center gap-1">
                                                <Import size={12} /> Select
                                            </div>
                                        </div>
                                    </div>
                                    <div className="p-3">
                                        <h3 className="font-bold truncate" title={item.name}>{item.name}</h3>
                                        <p className="text-xs text-slate-500 line-clamp-2 mt-1 h-8">{item.description}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="p-4 border-t-2 border-black bg-white rounded-b-lg flex justify-end">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                </div>
            </div>
        </div>
    );
};
