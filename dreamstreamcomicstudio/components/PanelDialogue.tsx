import React from 'react';
import { ComicPanel, DialogueBlock, TextLayout } from '../types';
import { ensureDialogueBlocks } from '../services/dialogueUtils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PanelDialogueProps {
    panel: ComicPanel;
    layout: TextLayout;
    /** When true, dialogue renders as an absolute overlay on the panel image. */
    overlay?: boolean;
    /** Compact mode for small panels (e.g., 3×3 grids). */
    compact?: boolean;
}

// ---------------------------------------------------------------------------
// SVG speech bubble tail
// ---------------------------------------------------------------------------

function BubbleTail({ side, className, style = 'speech' }: { side: 'left' | 'right' | 'center'; className?: string, style?: 'speech' | 'thought' | 'shout' | 'whisper' | 'caption' }) {
    if (side === 'center' || style === 'caption' || style === 'thought') return null; // Thought bubbles use small circles instead of tails
    const isLeft = side === 'left';
    return (
        <svg
            width="16"
            height="10"
            viewBox="0 0 16 10"
            className={`absolute -bottom-[9px] ${isLeft ? 'left-3' : 'right-3'} ${className || ''}`}
            style={{ transform: isLeft ? 'none' : 'scaleX(-1)' }}
        >
            <path d={style === 'shout' ? "M0 0 L8 10 L16 0" : "M0 0 Q8 10 16 0"} fill="white" stroke="black" strokeWidth="2" strokeLinejoin="round" />
            {/* White cover to hide the top border where bubble meets tail */}
            <rect x="1" y="0" width="14" height="2" fill="white" />
        </svg>
    );
}

function ThoughtTail({ side }: { side: 'left' | 'right' | 'center' }) {
    if (side === 'center') return null;
    const isLeft = side === 'left';
    return (
        <div className={`absolute -bottom-4 ${isLeft ? 'left-4' : 'right-4'} flex flex-col items-center gap-0.5 pointer-events-none`}>
            <div className="w-2 h-2 bg-white border border-black rounded-full" />
            <div className="w-1.5 h-1.5 bg-white border border-black rounded-full ml-1" />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Narration box (rectangular, italic)
// ---------------------------------------------------------------------------

export function NarrationBox({ text, compact }: { text: string; compact?: boolean }) {
    return (
        <div className={`
      bg-amber-50 border-2 border-black rounded-sm shadow-[2px_2px_0px_0px_#000]
      ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-3 py-1.5 text-xs'}
      font-serif italic text-slate-800 leading-snug
    `}>
            {text}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Speech bubble (rounded, with tail)
// ---------------------------------------------------------------------------

export function SpeechBubble({
    block,
    compact,
}: {
    block: DialogueBlock;
    compact?: boolean;
}) {
    const side = block.side || 'left';
    const isRight = side === 'right';
    const style = block.style || 'speech';

    let containerClasses = `
        bg-white border-2 border-black
        ${compact ? 'px-2 py-1 text-[9px]' : 'px-3 py-2 text-[11px]'}
        font-comic font-bold text-black leading-snug overflow-hidden
    `;

    // Style variations
    if (style === 'thought') {
        containerClasses += " rounded-[20px] border-dashed"; // Cloud-like shape
    } else if (style === 'shout') {
        containerClasses += " rounded-sm border-[3px]"; // High impact
    } else if (style === 'whisper') {
        containerClasses += " rounded-xl border-dotted text-slate-500 bg-white/90";
    } else {
        containerClasses += " rounded-xl shadow-[2px_2px_0px_0px_#000]";
    }

    return (
        <div className={`relative max-w-[85%] ${isRight ? 'ml-auto' : ''}`}>
            <div className={containerClasses} style={style === 'shout' ? { transform: 'rotate(-1deg)' } : {}}>
                {block.speaker && (
                    <span className={`
            font-display uppercase text-brand-blue
            ${compact ? 'text-[8px]' : 'text-[10px]'}
            block mb-0.5
          `}>
                        {block.speaker}
                    </span>
                )}
                <span className={`line-clamp-3 ${compact ? 'line-clamp-2' : ''} ${style === 'shout' ? 'uppercase text-red-600' : ''}`}>{block.text}</span>
            </div>
            {style === 'thought' ? <ThoughtTail side={side} /> : (style !== 'caption' ? <BubbleTail side={side} style={style} /> : null)}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Caption bar (bottom overlay)
// ---------------------------------------------------------------------------

function CaptionBar({
    blocks,
    compact,
}: {
    blocks: DialogueBlock[];
    compact?: boolean;
}) {
    // Group by kind: show narration separately from speech
    const narrations = blocks.filter(b => b.kind === 'narration');
    const speeches = blocks.filter(b => b.kind !== 'narration');

    return (
        <div className={`
      absolute bottom-0 left-0 right-0
      bg-gradient-to-t from-black/80 via-black/60 to-transparent
      ${compact ? 'p-1.5 pt-4' : 'p-3 pt-8'}
    `}>
            {narrations.map(block => (
                <div
                    key={block.id}
                    className={`
            text-amber-100 font-serif italic text-center mb-1
            ${compact ? 'text-[8px]' : 'text-[11px]'}
          `}
                >
                    <span className={`line-clamp-2 ${compact ? 'line-clamp-1' : ''}`}>{block.text}</span>
                </div>
            ))}
            {speeches.length > 0 && (
                <div className={`
          bg-white/95 border-2 border-black rounded
          ${compact ? 'px-1.5 py-1 text-[9px]' : 'px-3 py-2 text-sm'}
          font-comic font-bold text-black text-center
          max-h-[4em] overflow-hidden
        `}>
                    {speeches.map((block, idx) => (
                        <span key={block.id}>
                            {block.speaker && (
                                <span className="text-brand-blue font-display uppercase text-[10px] mr-1">
                                    {block.speaker}:
                                </span>
                            )}
                            {block.text}
                            {idx < speeches.length - 1 && <span className="mx-1 text-slate-400">·</span>}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Chat bubble (messaging-style, below image)
// ---------------------------------------------------------------------------

function ChatMessage({
    block,
    compact,
}: {
    block: DialogueBlock;
    compact?: boolean;
}) {
    const isRight = block.side === 'right';
    const isNarration = block.kind === 'narration';

    if (isNarration) {
        return (
            <div className={`
        text-center font-serif italic text-slate-500
        ${compact ? 'text-[8px] py-0.5' : 'text-[11px] py-1'}
      `}>
                <span className={`line-clamp-2 ${compact ? 'line-clamp-1' : ''}`}>{block.text}</span>
            </div>
        );
    }

    return (
        <div className={`flex ${isRight ? 'justify-end' : 'justify-start'}`}>
            <div className={`
        max-w-[80%] border-2 border-black font-comic font-bold
        ${compact ? 'px-2 py-1 text-[9px] rounded-lg' : 'px-3 py-2 text-xs rounded-xl'}
        ${isRight
                    ? 'bg-brand-blue text-white rounded-br-sm'
                    : 'bg-brand-yellow text-black rounded-bl-sm'
                }
      `}>
                {block.speaker && (
                    <span className={`
            block font-display uppercase mb-0.5
            ${compact ? 'text-[7px]' : 'text-[9px]'}
            ${isRight ? 'text-blue-200' : 'text-amber-700'}
          `}>
                        {block.speaker}
                    </span>
                )}
                <span className={`line-clamp-3 ${compact ? 'line-clamp-2' : ''}`}>{block.text}</span>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const PanelDialogue: React.FC<PanelDialogueProps> = ({
    panel,
    layout,
    overlay = true,
    compact = false,
}) => {
    const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
    if (layout === 'none' || blocks.length === 0) return null;

    // Limit visible blocks in compact mode to prevent overflow
    const maxVisible = compact ? 2 : 4;
    const visibleBlocks = blocks.slice(0, maxVisible);
    const hasMore = blocks.length > maxVisible;

    // ---- Speech bubbles (overlay) ------------------------------------------
    if (layout === 'speech_bubbles') {
        // Distribute bubbles vertically within the panel
        const totalSlots = Math.min(visibleBlocks.length, compact ? 2 : 3);
        const positions = visibleBlocks.map((_, idx) => {
            // Evenly space from top: 8% to 70% of panel height
            const pct = 8 + (idx / Math.max(totalSlots, 1)) * 55;
            return pct;
        });

        return (

            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {visibleBlocks.map((block, idx) => {
                    // Use stored position if available, otherwise fallback to calculated default
                    const side = block.side || (idx % 2 === 0 ? 'left' : 'right');
                    const defaultTop = 8 + (idx / Math.max(totalSlots, 1)) * 55; // 8% to 63%
                    const topPct = block.position?.y ?? defaultTop;
                    const leftPct = block.position?.x; // If undefined, we use side-based logic

                    const isNarration = block.kind === 'narration';

                    return (
                        <div
                            key={block.id}
                            className={`absolute transition-all duration-200`}
                            style={{
                                top: `${topPct}%`,
                                left: leftPct !== undefined ? `${leftPct}%` : (side === 'left' ? '2%' : 'auto'),
                                right: leftPct !== undefined ? 'auto' : (side === 'right' ? '2%' : 'auto'),
                                transform: side === 'center' && leftPct === undefined ? 'translateX(-50%)' : 'none',
                                ...(side === 'center' && leftPct === undefined ? { left: '50%' } : {})
                            }}
                        >
                            {isNarration ? (
                                <NarrationBox text={block.text} compact={compact} />
                            ) : (
                                <SpeechBubble block={{ ...block, side }} compact={compact} />
                            )}
                        </div>
                    );
                })}
                {hasMore && (
                    <div className="absolute bottom-1 right-2 bg-black/60 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold">
                        +{blocks.length - maxVisible} more
                    </div>
                )}
            </div>
        );

    }

    // ---- Captions (gradient overlay at bottom) -----------------------------
    if (layout === 'caption') {
        return <CaptionBar blocks={visibleBlocks} compact={compact} />;
    }

    // ---- Chat bubbles (below the panel image) ------------------------------
    if (layout === 'chat_bubbles') {
        return (
            <div className={`${compact ? 'space-y-0.5 px-1 py-1' : 'space-y-1.5 px-3 py-2'}`}>
                {visibleBlocks.map(block => (
                    <ChatMessage key={block.id} block={block} compact={compact} />
                ))}
                {hasMore && (
                    <div className="text-center text-[9px] text-slate-400 font-bold">
                        +{blocks.length - maxVisible} more lines
                    </div>
                )}
            </div>
        );
    }

    return null;
};

export default PanelDialogue;
