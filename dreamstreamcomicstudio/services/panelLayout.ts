import type { ComicPanel, DialogueBlock, TextLayout } from '../types';
import { ensureDialogueBlocks } from './dialogueUtils';

// ---------------------------------------------------------------------------
// Shared layout class helpers (used by ReviewExport + ComicReader)
// ---------------------------------------------------------------------------

export const getLayoutClass = (layoutType: string): string => {
    switch (layoutType) {
        case 'webtoon': return 'flex flex-col items-center gap-4';
        case 'strip': return 'flex flex-col items-center gap-2';
        case 'graphic_novel': return 'grid grid-cols-3 gap-4 auto-rows-fr';
        case 'conversation_grid': return 'grid grid-cols-2 gap-4 auto-rows-fr';
        case 'splash_insets': return 'grid grid-cols-3 gap-4 auto-rows-[200px]';
        case 'golden_ratio': return 'grid grid-cols-3 gap-4 auto-rows-[180px]';
        case 'diagonal_action': return 'grid grid-cols-2 gap-4 auto-rows-[200px]';
        case 'storyboard': return 'grid grid-cols-3 gap-2 auto-rows-[150px]';
        case 'manga': return 'grid grid-cols-2 gap-4 auto-rows-fr';
        case 'cinematic': return 'grid grid-cols-1 gap-4';
        case 'grid':
        case 'custom':
        default:
            return 'grid grid-cols-2 gap-4 auto-rows-fr';
    }
};

export const getPanelClass = (layoutType: string, idx: number): string => {
    switch (layoutType) {
        case 'splash_insets':
            return idx === 0 ? 'col-span-3 row-span-2' : 'col-span-1 row-span-1';
        case 'golden_ratio':
            return idx === 0 ? 'col-span-2 row-span-2' : 'col-span-1 row-span-1';
        case 'diagonal_action':
            return idx % 3 === 0 ? 'col-span-2 row-span-1' : 'col-span-1 row-span-1';
        case 'graphic_novel':
            return idx % 4 === 0 ? 'col-span-2 row-span-1' : 'col-span-1 row-span-1';
        default:
            return 'col-span-1 row-span-1';
    }
};

// ---------------------------------------------------------------------------
// HTML export dialogue — generates proper styled dialogue HTML to match
// PanelDialogue.tsx quality inside exported standalone HTML files.
// ---------------------------------------------------------------------------

const esc = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * CSS styles for exported HTML dialogue. Inject once in <style>.
 */
export const EXPORT_DIALOGUE_CSS = `
  /* Speech bubbles (absolute overlay) */
  .speech-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
  .speech-bubble{position:relative;max-width:85%;background:#fff;border:2px solid #000;
    padding:6px 10px;border-radius:14px;font-weight:bold;font-size:13px;margin-bottom:8px;
    box-shadow:2px 2px 0 #000;}
  .speech-bubble.right{margin-left:auto;}
  .speech-bubble .speaker{display:block;font-size:10px;text-transform:uppercase;color:#2867ff;margin-bottom:2px;}
  .speech-bubble svg.tail{position:absolute;bottom:-9px;width:16px;height:10px;}
  .speech-bubble svg.tail.left{left:12px;}
  .speech-bubble svg.tail.right{right:12px;transform:scaleX(-1);}

  /* Narration box */
  .narration-box{background:#fffbeb;border:2px solid #000;border-radius:3px;padding:6px 10px;
    font-style:italic;font-family:Georgia,serif;font-size:12px;color:#334155;
    box-shadow:2px 2px 0 #000;margin-bottom:8px;max-width:85%;}

  /* Caption bar (gradient overlay at bottom) */
  .caption-bar{position:absolute;bottom:0;left:0;right:0;
    background:linear-gradient(to top,rgba(0,0,0,0.8),rgba(0,0,0,0.6),transparent);
    padding:24px 12px 10px 12px;}
  .caption-narration{color:#fef3c7;font-family:Georgia,serif;font-style:italic;
    text-align:center;font-size:12px;margin-bottom:4px;}
  .caption-speech{background:rgba(255,255,255,0.95);border:2px solid #000;border-radius:4px;
    padding:6px 10px;font-weight:bold;font-size:13px;text-align:center;}
  .caption-speech .speaker{color:#2867ff;font-size:10px;text-transform:uppercase;margin-right:4px;}

  /* Chat bubbles (below image) */
  .chat{display:flex;flex-direction:column;gap:8px;padding:10px;}
  .chat .msg{max-width:80%;padding:6px 10px;border:2px solid #000;border-radius:12px;
    font-weight:bold;font-size:13px;}
  .chat .msg.left{align-self:flex-start;background:#f9e547;color:#000;border-bottom-left-radius:3px;}
  .chat .msg.right{align-self:flex-end;background:#2867ff;color:#fff;border-bottom-right-radius:3px;}
  .chat .msg .speaker{display:block;font-size:9px;text-transform:uppercase;margin-bottom:2px;}
  .chat .msg.left .speaker{color:#92400e;}
  .chat .msg.right .speaker{color:#bfdbfe;}
  .chat .msg.narration{align-self:center;background:transparent;border:none;
    font-style:italic;color:#64748b;font-weight:normal;font-family:Georgia,serif;}

  /* Overflow indicator */
  .overflow-badge{position:absolute;bottom:4px;right:8px;background:rgba(0,0,0,0.6);
    color:#fff;font-size:10px;padding:2px 6px;border-radius:999px;font-weight:bold;}
`;

const BUBBLE_TAIL_SVG = '<svg class="tail left" viewBox="0 0 16 10"><path d="M0 0 L8 10 L16 0" fill="white" stroke="black" stroke-width="2" stroke-linejoin="round"/><rect x="1" y="0" width="14" height="2" fill="white"/></svg>';
const BUBBLE_TAIL_SVG_RIGHT = '<svg class="tail right" viewBox="0 0 16 10"><path d="M0 0 L8 10 L16 0" fill="white" stroke="black" stroke-width="2" stroke-linejoin="round"/><rect x="1" y="0" width="14" height="2" fill="white"/></svg>';

/**
 * Build proper styled dialogue HTML for a single panel.
 * Mirrors the PanelDialogue.tsx component logic.
 */
export function buildPanelDialogueHtml(
    panel: ComicPanel,
    layout: TextLayout
): string {
    if (layout === 'none') return '';

    const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
    if (blocks.length === 0) return '';

    const maxVisible = 4;
    const visible = blocks.slice(0, maxVisible);
    const overflow = blocks.length > maxVisible;

    // ---- Speech bubbles ----
    if (layout === 'speech_bubbles') {
        const bubbles = visible.map((b, idx) => {
            const side = b.side || (idx % 2 === 0 ? 'left' : 'right');
            const top = 8 + (idx / Math.max(visible.length, 1)) * 55;
            const align = side === 'right' ? 'right:8px;' : 'left:8px;';
            const isNarration = b.kind === 'narration';

            if (isNarration) {
                return `<div class="narration-box" style="position:absolute;top:${top}%;${align}">${esc(b.text)}</div>`;
            }

            const speakerHtml = b.speaker ? `<span class="speaker">${esc(b.speaker)}</span>` : '';
            const tail = side === 'right' ? BUBBLE_TAIL_SVG_RIGHT : BUBBLE_TAIL_SVG;
            return `<div class="speech-bubble ${side}" style="position:absolute;top:${top}%;${align}">
        ${speakerHtml}${esc(b.text)}${tail}
      </div>`;
        }).join('');

        const overflowHtml = overflow ? `<div class="overflow-badge">+${blocks.length - maxVisible} more</div>` : '';
        return `<div class="speech-overlay">${bubbles}${overflowHtml}</div>`;
    }

    // ---- Caption ----
    if (layout === 'caption') {
        const narrations = visible.filter(b => b.kind === 'narration');
        const speeches = visible.filter(b => b.kind !== 'narration');

        const narrationHtml = narrations.map(b => `<div class="caption-narration">${esc(b.text)}</div>`).join('');
        const speechHtml = speeches.length > 0
            ? `<div class="caption-speech">${speeches.map((b, i) => {
                const sp = b.speaker ? `<span class="speaker">${esc(b.speaker)}:</span>` : '';
                const sep = i < speeches.length - 1 ? '<span style="margin:0 4px;color:#94a3b8;">·</span>' : '';
                return `<span>${sp}${esc(b.text)}${sep}</span>`;
            }).join('')}</div>`
            : '';

        return `<div class="caption-bar">${narrationHtml}${speechHtml}</div>`;
    }

    // ---- Chat bubbles ----
    if (layout === 'chat_bubbles') {
        const msgs = visible.map(b => {
            if (b.kind === 'narration') {
                return `<div class="msg narration">${esc(b.text)}</div>`;
            }
            const side = b.side === 'right' ? 'right' : 'left';
            const sp = b.speaker ? `<span class="speaker">${esc(b.speaker)}</span>` : '';
            return `<div class="msg ${side}">${sp}${esc(b.text)}</div>`;
        }).join('');

        const overflowHtml = overflow
            ? `<div style="text-align:center;font-size:11px;color:#94a3b8;font-weight:bold;">+${blocks.length - maxVisible} more lines</div>`
            : '';
        return `<div class="chat">${msgs}${overflowHtml}</div>`;
    }

    return '';
}
