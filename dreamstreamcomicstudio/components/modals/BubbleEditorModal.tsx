import React, { useEffect, useId, useRef, useState } from 'react';
import { X, Plus, Trash2, Move, MessageSquare, Cloud, Zap, Volume2, Type, Sparkles, CheckCheck } from 'lucide-react';
import { ComicPanel, TextLayout, DialogueBlock } from '../../types';
import { ensureDialogueBlocks } from '../../services/dialogueUtils';
import { SpeechBubble, NarrationBox } from '../PanelDialogue';
import { Button } from '../Button';
import { buttonClasses } from '../ds/Button';
import {
    DENSITY,
    DIALOG_TITLE,
    FIELD,
    FOCUS_RING,
    HAIRLINE,
    INK,
    MUTED,
    OVERLAY,
    OVERLINE,
    RADIUS_CONTROL,
    RADIUS_PANEL,
    SCRIM,
    SPARK_RING_ON_ART,
    Z
} from '../chat/studioDesign';

const FIELD_LABEL = `mb-1 block text-xs font-medium ${INK}`;
const TEXT_FIELD = `${FIELD} block w-full px-2 py-1 text-sm`;
const styleOption = (on: boolean) =>
    `flex flex-col items-center justify-center gap-1 border p-2 text-[11px] font-medium text-[var(--ds-ink)] ${RADIUS_CONTROL} ${DENSITY.coarse} transition-colors duration-[var(--ds-motion-medium)] ${FOCUS_RING} ${on ? 'border-[var(--ds-ink)] bg-[var(--ds-active)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-raised)] hover:bg-[var(--ds-hover)]'}`;

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
    const speakerId = useId();
    const textId = useId();
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
        <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4`} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
            <div role="dialog" aria-label="Dialogue Editor" className={`${OVERLAY} flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden md:flex-row`}>

                {/* Editor Area (Left/Top) */}
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--ds-well)]">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4">
                        <h3 className={`flex items-center gap-2 font-semibold ${INK}`}><Move className="size-4" aria-hidden="true" /> Drag to Position Bubbles</h3>
                        <div className={`text-xs ${MUTED}`}>Bubbles are draggable overlay elements</div>
                    </div>

                    <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-[var(--ds-well-strong)] p-4 sm:p-8">
                        <div
                            ref={containerRef}
                            className={`relative select-none bg-[var(--ds-surface)] ${HAIRLINE} shadow-[shadow:var(--ds-shadow-panel)]`}
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
                                        className={`absolute cursor-move touch-none transition-shadow ${isSelected ? Z.chrome : Z.stage}`}
                                        style={{ top: `${y}%`, left: `${x}%` }}
                                    >
                                        <div className={`
                          ${isSelected ? SPARK_RING_ON_ART : ''}
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
                <div className="flex min-h-0 w-full flex-col border-t border-[var(--ds-hairline)] bg-[var(--ds-surface)] md:w-80 md:border-l md:border-t-0">
                    <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] p-4">
                        <h2 className={DIALOG_TITLE}>Dialogue Editor</h2>
                        <button onClick={onClose} aria-label="Close" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })}><X size={20} /></button>
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
                            <div className={`space-y-4 bg-[var(--ds-well)] p-3 ${RADIUS_PANEL} ${HAIRLINE}`}>
                                <div className="flex items-center justify-between">
                                    <span className={OVERLINE}>Editing Selected</span>
                                    <button onClick={() => setBlocks(blocks.filter(b => b.id !== selectedBlock.id))} aria-label="Delete bubble" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'size-8 text-[var(--ds-danger-text)]' })}><Trash2 size={14} /></button>
                                </div>

                                <div>
                                    <div className={FIELD_LABEL}>Style</div>
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
                                                aria-pressed={selectedBlock.style === style.id}
                                                className={styleOption(selectedBlock.style === style.id)}
                                            >
                                                <style.icon size={14} />
                                                {style.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label htmlFor={speakerId} className={FIELD_LABEL}>Speaker</label>
                                    <input
                                        type="text"
                                        value={selectedBlock.speaker || ''}
                                        onChange={(e) => handleUpdateBlock(selectedBlock.id, { speaker: e.target.value })}
                                        id={speakerId}
                                        className={`${TEXT_FIELD} h-9`}
                                        placeholder="Name..."
                                    />
                                </div>

                                <div>
                                    <label htmlFor={textId} className={FIELD_LABEL}>Text</label>
                                    <textarea
                                        value={selectedBlock.text}
                                        onChange={(e) => handleUpdateBlock(selectedBlock.id, { text: e.target.value })}
                                        id={textId}
                                        className={`${TEXT_FIELD} min-h-[80px]`}
                                    />
                                </div>

                                <div className={`flex flex-wrap gap-x-4 text-xs ${INK}`}>
                                    <label className="flex min-h-11 cursor-pointer items-center gap-1.5">
                                        <input
                                            type="radio"
                                            checked={selectedBlock.side === 'left'}
                                            onChange={() => handleUpdateBlock(selectedBlock.id, { side: 'left' })}
                                            className="size-4 accent-[var(--ds-ink)]"
                                        /> Left Tail
                                    </label>
                                    <label className="flex min-h-11 cursor-pointer items-center gap-1.5">
                                        <input
                                            type="radio"
                                            checked={selectedBlock.side === 'right'}
                                            onChange={() => handleUpdateBlock(selectedBlock.id, { side: 'right' })}
                                            className="size-4 accent-[var(--ds-ink)]"
                                        /> Right Tail
                                    </label>
                                </div>
                            </div>
                        ) : (
                            <div className={`py-8 text-center text-sm ${MUTED}`}>
                                Select a bubble to edit text & style
                            </div>
                        )}
                    </div>

                    <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--ds-hairline)] p-4">
                        <Button variant="secondary" onClick={onClose}>Cancel</Button>
                        <Button onClick={handleSave}>Save Changes</Button>
                    </div>
                </div>
            </div>
        </div>
    );
};
