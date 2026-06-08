import React, { useState, useRef, useEffect } from 'react';
import { X, Plus, Trash2, Move, MessageSquare, Cloud, Zap, Volume2, Type, Sparkles, CheckCheck } from 'lucide-react';
import { ComicPanel, TextLayout, DialogueBlock } from '../../types';
import { ensureDialogueBlocks } from '../../services/dialogueUtils';
import { SpeechBubble, NarrationBox } from '../PanelDialogue';
import { Button } from '../Button';

interface BubbleEditorModalProps {
    isOpen: boolean;
    onClose: () => void;
    panel: ComicPanel;
    layout: TextLayout;
    onUpdatePanel: (updatedPanel: ComicPanel) => void;
}

export const BubbleEditorModal: React.FC<BubbleEditorModalProps> = ({
    isOpen,
    onClose,
    panel,
    layout,
    onUpdatePanel,
}) => {
    const [blocks, setBlocks] = useState<DialogueBlock[]>([]);
    const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ id: string; startX: number; startY: number; startObjX: number; startObjY: number } | null>(null);

    useEffect(() => {
        // Initialize blocks from panel
        const initialBlocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
        // Ensure every block has a position initialized if missing
        const enrichedBlocks = initialBlocks.map((b, idx) => ({
            ...b,
            position: b.position || { x: (idx % 2 === 0 ? 5 : 50), y: 10 + (idx * 20) }, // Default staggered pattern
            style: b.style || 'speech'
        }));
        setBlocks(enrichedBlocks);
    }, [panel]);

    if (!isOpen) return null;

    const handleUpdateBlock = (id: string, updates: Partial<DialogueBlock>) => {
        setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b));
    };

    const handleSave = () => {
        onUpdatePanel({
            ...panel,
            dialogueBlocks: blocks
        });
        onClose();
    };

    // Deterministic "AI auto-select": pick a bubble style from the line's content so the user
    // doesn't have to set each one by hand. Shouts (ALL CAPS / "!!"), thoughts (parenth?cal or
    // "I think…"), whispers (*asterisks* / "quietly"), else plain speech. Narration is left as-is.
    const classifyStyle = (text: string): 'speech' | 'thought' | 'shout' | 'whisper' => {
        const t = (text || '').trim();
        if (!t) return 'speech';
        const letters = t.replace(/[^a-zA-Z]/g, '');
        const isAllCaps = letters.length >= 3 && letters === letters.toUpperCase();
        if (isAllCaps || /!{2,}/.test(t) || /!\s*$/.test(t)) return 'shout';
        if (/^\(.*\)$/.test(t) || /\b(think|thinking|wonder|thought|imagine)\b/i.test(t)) return 'thought';
        if (/^\*.*\*$/.test(t) || /\b(whisper|whispers|quietly|murmur|psst|under (his|her|their) breath)\b/i.test(t)) return 'whisper';
        return 'speech';
    };

    const handleAutoStyle = () => {
        setBlocks(prev => prev.map(b => b.kind === 'narration' ? b : { ...b, style: classifyStyle(b.text) }));
    };

    const handleApplyStyleToAll = () => {
        if (!selectedBlockId) return;
        const source = blocks.find(b => b.id === selectedBlockId);
        const style = source?.style || 'speech';
        setBlocks(prev => prev.map(b => b.kind === 'narration' ? b : { ...b, style }));
    };

    // Pointer Events (not mouse-only) so dragging works for touch + pen too — mouse-only
    // handlers never fire on a phone, leaving bubbles impossible to reposition there.
    const handlePointerDown = (e: React.PointerEvent, id: string, currentX: number, currentY: number) => {
        e.stopPropagation();
        setSelectedBlockId(id);
        dragRef.current = {
            id,
            startX: e.clientX,
            startY: e.clientY,
            startObjX: currentX,
            startObjY: currentY
        };
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragRef.current || !containerRef.current) return;

        // Calculate delta in percentages relative to container size
        const rect = containerRef.current.getBoundingClientRect();
        const deltaX = ((e.clientX - dragRef.current.startX) / rect.width) * 100;
        const deltaY = ((e.clientY - dragRef.current.startY) / rect.height) * 100;

        const newX = Math.max(0, Math.min(90, dragRef.current.startObjX + deltaX));
        const newY = Math.max(0, Math.min(90, dragRef.current.startObjY + deltaY));

        handleUpdateBlock(dragRef.current.id, { position: { x: newX, y: newY } });
    };

    const handlePointerUp = () => {
        dragRef.current = null;
    };

    const selectedBlock = blocks.find(b => b.id === selectedBlockId);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
            <div className="bg-white rounded-xl w-full max-w-5xl h-[85vh] flex overflow-hidden shadow-2xl flex-col md:flex-row">

                {/* Editor Area (Left/Top) */}
                <div className="flex-1 bg-slate-100 relative overflow-hidden flex flex-col">
                    <div className="p-4 border-b bg-white flex justify-between items-center">
                        <h3 className="font-bold flex items-center gap-2"><Move className="w-4 h-4" /> Drag to Position Bubbles</h3>
                        <div className="text-xs text-slate-500">Bubbles are draggable overlay elements</div>
                    </div>

                    <div className="flex-1 overflow-hidden relative flex items-center justify-center p-8 bg-slate-200">
                        <div
                            ref={containerRef}
                            className="relative border-4 border-black shadow-comic bg-white select-none"
                            style={{
                                aspectRatio: '1/1', // default to square if dimensions unknown
                                maxHeight: '100%',
                                maxWidth: '100%'
                            }}
                        >
                            {/* Background Image */}
                            {panel.imageUrl && (
                                <img src={panel.imageUrl} className="w-full h-full object-cover pointer-events-none" alt="comic panel" />
                            )}

                            {/* Draggable Bubbles */}
                            {blocks.map((block, idx) => {
                                const x = block.position?.x ?? 50;
                                const y = block.position?.y ?? 50;
                                const isSelected = selectedBlockId === block.id;

                                return (
                                    <div
                                        key={block.id}
                                        onPointerDown={(e) => handlePointerDown(e, block.id, x, y)}
                                        className={`absolute cursor-move touch-none transition-shadow ${isSelected ? 'z-50' : 'z-10'}`}
                                        style={{ top: `${y}%`, left: `${x}%` }}
                                    >
                                        <div className={`
                          ${isSelected ? 'ring-2 ring-brand-blue ring-offset-2' : ''}
                          relative group w-max max-w-[300px]
                        `}>
                                            {/* Render the actual bubble component for preview */}
                                            <div className="pointer-events-none">
                                                {block.kind === 'narration' ? (
                                                    <NarrationBox text={block.text} compact={false} />
                                                ) : (
                                                    <SpeechBubble
                                                        block={{
                                                            ...block,
                                                            side: block.side || (idx % 2 === 0 ? 'left' : 'right')
                                                        }}
                                                        compact={false}
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Sidebar Controls (Right/Bottom) */}
                <div className="w-full md:w-80 bg-white border-l border-slate-200 flex flex-col">
                    <div className="p-4 border-b flex justify-between items-center bg-slate-50">
                        <h2 className="font-bold text-lg">Dialogue Editor</h2>
                        <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded"><X size={20} /></button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-6">

                        {/* Action Buttons */}
                        <div className="space-y-2">
                            <Button
                                variant="outline"
                                className="w-full"
                                icon={<Plus size={16} />}
                                onClick={() => {
                                    const newBlock: DialogueBlock = {
                                        id: crypto.randomUUID(),
                                        text: "New dialogue...",
                                        speaker: "Speaker",
                                        style: 'speech',
                                        kind: 'speech',
                                        position: { x: 50, y: 50 }
                                    };
                                    setBlocks([...blocks, newBlock]);
                                    setSelectedBlockId(newBlock.id);
                                }}
                            >
                                Add New Bubble
                            </Button>
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    variant="secondary"
                                    className="w-full"
                                    icon={<Sparkles size={14} />}
                                    disabled={blocks.length === 0}
                                    onClick={handleAutoStyle}
                                    title="Let the app pick a bubble style for every line from its wording"
                                >
                                    AI auto-style
                                </Button>
                                <Button
                                    variant="secondary"
                                    className="w-full"
                                    icon={<CheckCheck size={14} />}
                                    disabled={!selectedBlockId}
                                    onClick={handleApplyStyleToAll}
                                    title="Apply the selected bubble's style to every bubble in this panel"
                                >
                                    Apply to all
                                </Button>
                            </div>
                        </div>

                        {/* Selected Block Editor */}
                        {selectedBlock ? (
                            <div className="space-y-4 border rounded-lg p-3 bg-slate-50">
                                <div className="flex justify-between items-center">
                                    <span className="text-xs font-bold uppercase text-slate-500">Editing Selected</span>
                                    <button onClick={() => setBlocks(blocks.filter(b => b.id !== selectedBlock.id))} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 size={14} /></button>
                                </div>

                                <div>
                                    <label className="text-xs font-bold mb-1 block">Style</label>
                                    <div className="grid grid-cols-4 gap-2">
                                        {[
                                            { id: 'speech', icon: MessageSquare, label: 'Speech' },
                                            { id: 'thought', icon: Cloud, label: 'Think' },
                                            { id: 'shout', icon: Zap, label: 'Shout' },
                                            { id: 'whisper', icon: Volume2, label: 'Quiet' }
                                        ].map(style => (
                                            <button
                                                key={style.id}
                                                onClick={() => handleUpdateBlock(selectedBlock.id, { style: style.id as any })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 text-[10px] ${selectedBlock.style === style.id ? 'bg-brand-blue text-white border-brand-blue' : 'bg-white hover:bg-slate-100'}`}
                                            >
                                                <style.icon size={14} />
                                                {style.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label className="text-xs font-bold mb-1 block">Speaker</label>
                                    <input
                                        type="text"
                                        value={selectedBlock.speaker || ''}
                                        onChange={(e) => handleUpdateBlock(selectedBlock.id, { speaker: e.target.value })}
                                        className="w-full text-sm border rounded px-2 py-1"
                                        placeholder="Name..."
                                    />
                                </div>

                                <div>
                                    <label className="text-xs font-bold mb-1 block">Text</label>
                                    <textarea
                                        value={selectedBlock.text}
                                        onChange={(e) => handleUpdateBlock(selectedBlock.id, { text: e.target.value })}
                                        className="w-full text-sm border rounded px-2 py-1 min-h-[80px]"
                                    />
                                </div>

                                <div className="flex gap-2 text-xs">
                                    <label className="flex items-center gap-1 cursor-pointer">
                                        <input
                                            type="radio"
                                            checked={selectedBlock.side === 'left'}
                                            onChange={() => handleUpdateBlock(selectedBlock.id, { side: 'left' })}
                                        /> Left Tail
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                        <input
                                            type="radio"
                                            checked={selectedBlock.side === 'right'}
                                            onChange={() => handleUpdateBlock(selectedBlock.id, { side: 'right' })}
                                        /> Right Tail
                                    </label>
                                </div>
                            </div>
                        ) : (
                            <div className="text-center text-slate-400 py-8 text-sm italic">
                                Select a bubble to edit text & style
                            </div>
                        )}
                    </div>

                    <div className="p-4 border-t bg-slate-50 flex justify-end gap-2">
                        <Button variant="secondary" onClick={onClose}>Cancel</Button>
                        <Button onClick={handleSave}>Save Changes</Button>
                    </div>
                </div>
            </div>
        </div>
    );
};
