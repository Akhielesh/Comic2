import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ComicPanel, DialogueBlock, TextLayout } from '../types';
import { readerDialogueBlocks } from '../services/dialogueUtils';

// ---------------------------------------------------------------------------
// Placement (mobile-reading hotfix)
// ---------------------------------------------------------------------------
// Speech bubbles and captions are fixed-pixel overlays sized for desktop panels. On a phone the panel is ~300-350 px
// wide, so the same bubbles cover 2-3x more of the art. On phones (coarse pointer or a viewport under 640 px), when
// the RENDERED panel is narrower than STACK_BELOW_PX, they stack under the image instead (the chat_bubbles pattern),
// at the same native 11-14 px text size, unclamped. Desktop keeps the overlay exactly as before.

/** Where speech bubbles and captions go: over the art, under it, or decided by the rendered panel width on phones. */
export type DialoguePlacement = 'auto' | 'overlay' | 'below';

const PHONE_QUERY = '(pointer: coarse), (max-width: 639.98px)';
/** Panels narrower than this (CSS px) stack their dialogue under the image on phones. */
export const STACK_BELOW_PX = 480;

const usePhoneContext = (enabled: boolean): boolean => {
    const read = () => enabled && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
    const [phone, setPhone] = useState(read);
    useEffect(() => {
        if (!enabled || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(PHONE_QUERY);
        const on = () => setPhone(mq.matches);
        on();
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
    }, [enabled]);
    return enabled && phone;
};

/** Resolves the placement; for 'auto' on phones it measures the dialogue root (always as wide as the panel). */
const useStackBelow = (placement: DialoguePlacement, active: boolean) => {
    const phone = usePhoneContext(placement === 'auto' && active);
    const [node, setNode] = useState<HTMLElement | null>(null);
    // First-paint guess from the viewport; the layout effect corrects it from the real panel width before paint.
    const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < STACK_BELOW_PX);
    useLayoutEffect(() => {
        if (!phone || !node) return;
        const read = () => {
            const width = node.getBoundingClientRect().width;
            if (width > 0) setNarrow(width < STACK_BELOW_PX);
        };
        read();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => read());
        ro.observe(node);
        return () => ro.disconnect();
    }, [phone, node]);
    const below = placement === 'below' || (placement === 'auto' && phone && narrow);
    return { below, phone, ref: setNode };
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PanelDialogueProps {
    panel: ComicPanel;
    layout: TextLayout;
    /** true: always an absolute overlay on the panel image; false: always under it. Unset: `placement` decides. */
    overlay?: boolean;
    /** Compact mode for small panels (e.g., 3×3 grids). */
    compact?: boolean;
    /** Default 'auto': overlay, except on phones when the rendered panel is narrower than STACK_BELOW_PX. */
    placement?: DialoguePlacement;
}

// ---------------------------------------------------------------------------
// SVG speech bubble tail
// ---------------------------------------------------------------------------

function BubbleTail({ side, className, style = 'speech', up = false }: { side: 'left' | 'right' | 'center'; className?: string, style?: 'speech' | 'thought' | 'shout' | 'whisper' | 'caption'; up?: boolean }) {
    if (side === 'center' || style === 'caption' || style === 'thought') return null; // Thought bubbles use small circles instead of tails
    const isLeft = side === 'left';
    const flips = [isLeft ? '' : 'scaleX(-1)', up ? 'scaleY(-1)' : ''].filter(Boolean).join(' ');
    return (
        <svg
            width="16"
            height="10"
            viewBox="0 0 16 10"
            className={`absolute ${up ? '-top-[9px]' : '-bottom-[9px]'} ${isLeft ? 'left-3' : 'right-3'} ${className || ''}`}
            style={{ transform: flips || 'none' }}
        >
            <path d={style === 'shout' ? "M0 0 L8 10 L16 0" : "M0 0 Q8 10 16 0"} fill="white" stroke="black" strokeWidth="2" strokeLinejoin="round" />
            {/* White cover to hide the top border where bubble meets tail */}
            <rect x="1" y="0" width="14" height="2" fill="white" />
        </svg>
    );
}

function ThoughtTail({ side, up = false }: { side: 'left' | 'right' | 'center'; up?: boolean }) {
    if (side === 'center') return null;
    const isLeft = side === 'left';
    return (
        <div className={`absolute ${up ? '-top-4 flex-col-reverse' : '-bottom-4 flex-col'} ${isLeft ? 'left-4' : 'right-4'} flex items-center gap-0.5 pointer-events-none`}>
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
    tail = 'down',
    clamp = true,
}: {
    block: DialogueBlock;
    compact?: boolean;
    /** 'up' when the bubble sits under the art (stacked on phones) and points at it. */
    tail?: 'down' | 'up';
    /** Overlays clamp long lines to bound how much art they cover; stacked bubbles show every word. */
    clamp?: boolean;
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
                <span className={`${clamp ? `line-clamp-3 ${compact ? 'line-clamp-2' : ''}` : 'block whitespace-pre-line break-words'} ${style === 'shout' ? 'uppercase text-red-600' : ''}`}>{block.text}</span>
            </div>
            {style === 'thought' ? <ThoughtTail side={side} up={tail === 'up'} /> : (style !== 'caption' ? <BubbleTail side={side} style={style} up={tail === 'up'} /> : null)}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Caption bar (bottom overlay)
// ---------------------------------------------------------------------------

function CaptionBar({
    blocks,
    compact,
    rootRef,
}: {
    blocks: DialogueBlock[];
    compact?: boolean;
    rootRef?: (el: HTMLDivElement | null) => void;
}) {
    // Group by kind: show narration separately from speech
    const narrations = blocks.filter(b => b.kind === 'narration');
    const speeches = blocks.filter(b => b.kind !== 'narration');

    return (
        <div ref={rootRef} data-testid="panel-dialogue" data-placement="overlay" className={`
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
    clamp = true,
}: {
    block: DialogueBlock;
    compact?: boolean;
    clamp?: boolean;
}) {
    const isRight = block.side === 'right';
    const isNarration = block.kind === 'narration';

    if (isNarration) {
        return (
            <div className={`
        text-center font-serif italic text-slate-500
        ${compact ? 'text-[8px] py-0.5' : 'text-[11px] py-1'}
      `}>
                <span className={clamp ? `line-clamp-2 ${compact ? 'line-clamp-1' : ''}` : 'block whitespace-pre-line break-words'}>{block.text}</span>
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
                <span className={clamp ? `line-clamp-3 ${compact ? 'line-clamp-2' : ''}` : 'block whitespace-pre-line break-words'}>{block.text}</span>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Stacked under the art (phones): the same bubbles / caption bar, below the image, every word
// ---------------------------------------------------------------------------

function StackedSpeechBubbles({ blocks, compact }: { blocks: DialogueBlock[]; compact?: boolean }) {
    return (
        <div className={compact ? 'space-y-2 px-1.5 pt-2.5 pb-1.5' : 'space-y-3 px-3 pt-3.5 pb-3'}>
            {blocks.map((block, idx) => {
                if (block.kind === 'narration') return <NarrationBox key={block.id} text={block.text} compact={compact} />;
                // Same side rule as the overlay, so a conversation keeps its left/right rhythm.
                const side = block.side || (idx % 2 === 0 ? 'left' : 'right');
                // A flex row so each bubble is as wide as its words (up to 85%), not a full-width bar.
                return (
                    <div key={block.id} className={`flex ${side === 'right' ? 'justify-end' : side === 'center' ? 'justify-center' : 'justify-start'}`}>
                        <SpeechBubble block={{ ...block, side }} compact={compact} tail="up" clamp={false} />
                    </div>
                );
            })}
        </div>
    );
}

function StackedCaptions({ blocks, compact }: { blocks: DialogueBlock[]; compact?: boolean }) {
    const narrations = blocks.filter(b => b.kind === 'narration');
    const speeches = blocks.filter(b => b.kind !== 'narration');
    return (
        <div className={`bg-neutral-900 ${compact ? 'space-y-1 p-1.5' : 'space-y-1.5 px-3 py-2.5'}`}>
            {narrations.map(block => (
                <p key={block.id} className={`text-amber-100 font-serif italic text-center leading-snug ${compact ? 'text-[8px]' : 'text-[11px]'}`}>
                    {block.text}
                </p>
            ))}
            {speeches.length > 0 && (
                <div className={`bg-white/95 border-2 border-black rounded font-comic font-bold text-black text-center leading-snug ${compact ? 'px-1.5 py-1 text-[9px]' : 'px-3 py-2 text-sm'}`}>
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
// Main component
// ---------------------------------------------------------------------------

export const PanelDialogue: React.FC<PanelDialogueProps> = ({
    panel,
    layout,
    overlay,
    compact = false,
    placement,
}) => {
    // Readers never show the scene description as dialogue (no fallback; stored echoes of it are hidden).
    const blocks = readerDialogueBlocks(panel);
    const resolved: DialoguePlacement = placement ?? (overlay === true ? 'overlay' : overlay === false ? 'below' : 'auto');
    const canStack = layout === 'speech_bubbles' || layout === 'caption';
    const { below, phone, ref } = useStackBelow(resolved, layout !== 'none' && blocks.length > 0);
    if (layout === 'none' || blocks.length === 0) return null;

    // Limit visible blocks in compact mode to prevent overflow
    const maxVisible = compact ? 2 : 4;
    const visibleBlocks = blocks.slice(0, maxVisible);
    const hasMore = blocks.length > maxVisible;

    // ---- Phones: speech bubbles and captions under the image -----------------
    // `w-0 min-w-full`: exactly as wide as the panel, never widening a shrink-to-fit page (Page Flip).
    if (canStack && below) {
        return (
            <div ref={ref} data-testid="panel-dialogue" data-placement="below" className="w-0 min-w-full">
                {layout === 'speech_bubbles'
                    ? <StackedSpeechBubbles blocks={blocks} compact={compact} />
                    : <StackedCaptions blocks={blocks} compact={compact} />}
            </div>
        );
    }

    // ---- Speech bubbles (overlay) ------------------------------------------
    if (layout === 'speech_bubbles') {
        // Distribute bubbles vertically within the panel
        const totalSlots = Math.min(visibleBlocks.length, compact ? 2 : 3);

        return (

            <div ref={ref} data-testid="panel-dialogue" data-placement="overlay" className="absolute inset-0 pointer-events-none overflow-hidden">
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
        return <CaptionBar blocks={visibleBlocks} compact={compact} rootRef={ref} />;
    }

    // ---- Chat bubbles (below the panel image) ------------------------------
    // Phones show every line (it is already under the art, nothing to bound); desktop keeps its 4-line cap.
    if (layout === 'chat_bubbles') {
        const stacked = phone || resolved === 'below';
        const shown = stacked ? blocks : visibleBlocks;
        return (
            <div
                data-testid="panel-dialogue"
                data-placement="below"
                className={`${compact ? 'space-y-0.5 px-1 py-1' : 'space-y-1.5 px-3 py-2'}${stacked ? ' w-0 min-w-full' : ''}`}
            >
                {shown.map(block => (
                    <ChatMessage key={block.id} block={block} compact={compact} clamp={!stacked} />
                ))}
                {!stacked && hasMore && (
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
