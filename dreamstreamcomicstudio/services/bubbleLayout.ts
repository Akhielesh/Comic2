/**
 * Smart bubble positioning — compute default positions for dialogue blocks.
 * When a panel image changes, these defaults reset bubbles to sensible locations
 * based on block count, kind, and speaker side.
 */

import { DialogueBlock } from '../types';

type Quadrant = { x: number; y: number };

const SPEECH_POSITIONS: Quadrant[] = [
    { x: 15, y: 10 },   // top-left
    { x: 70, y: 10 },   // top-right
    { x: 15, y: 60 },   // bottom-left
    { x: 70, y: 60 },   // bottom-right
    { x: 40, y: 10 },   // top-center
    { x: 40, y: 60 },   // bottom-center
];

const NARRATION_POSITIONS: Quadrant[] = [
    { x: 10, y: 5 },    // top strip
    { x: 10, y: 80 },   // bottom strip
];

const SFX_POSITION: Quadrant = { x: 50, y: 45 }; // center

/**
 * Compute default bubble positions for a panel's dialogue blocks.
 * Call this after generating/regenerating a panel image to reset
 * bubble positions to sensible defaults.
 */
export function computeDefaultBubblePositions(
    blocks: DialogueBlock[]
): DialogueBlock[] {
    let speechIdx = 0;
    let narrationIdx = 0;

    return blocks.map((block) => {
        let pos: Quadrant;

        if (block.kind === 'narration' || block.kind === 'caption') {
            pos = NARRATION_POSITIONS[narrationIdx % NARRATION_POSITIONS.length];
            narrationIdx++;
        } else if (block.style === 'shout') {
            pos = SFX_POSITION;
        } else {
            // Use side hint if available
            if (block.side === 'right') {
                pos = speechIdx % 2 === 0
                    ? SPEECH_POSITIONS[1]  // top-right
                    : SPEECH_POSITIONS[3]; // bottom-right
            } else if (block.side === 'left') {
                pos = speechIdx % 2 === 0
                    ? SPEECH_POSITIONS[0]  // top-left
                    : SPEECH_POSITIONS[2]; // bottom-left
            } else {
                pos = SPEECH_POSITIONS[speechIdx % SPEECH_POSITIONS.length];
            }
            speechIdx++;
        }

        return {
            ...block,
            position: { x: pos.x, y: pos.y },
        };
    });
}

/**
 * Apply universal dialogue style to all blocks that don't have manual overrides.
 */
export function applyUniversalStyle(
    blocks: DialogueBlock[],
    style: 'speech' | 'thought' | 'narration' | 'shout',
    hasManualOverride?: Set<string>
): DialogueBlock[] {
    // Map external style names to DialogueBlock.style values
    const mappedStyle: DialogueBlock['style'] = style === 'narration' ? 'caption' : style;
    return blocks.map((block) => {
        if (hasManualOverride?.has(block.id)) return block;
        return { ...block, style: mappedStyle };
    });
}
