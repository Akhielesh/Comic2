// The Pro workspace's tool rail (master plan §2.7): a 48 px column on the left of the stage at 1024 px and up, a tool
// row under the top bar on tablets. V select · T text · B balloon · S sound effect · U shapes · M mark up · H hand ·
// Z zoom, each a ToolButton with its key. The active tool is SEGMENTED_ACTIVE, never a hue.
//
// In-art comics (lettering drawn into the art): Text, Balloon and Sound effect stay on the rail but are off, with
// IN_ART_LETTERING_NOTE as their reason (§2.2 rule 6), so nobody wonders where they went; effects and the rest work.

import React from 'react';
import { Hand, MessageCircle, MousePointer2, Shapes, SquareDashed, Type, Zap, ZoomIn } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { PRO_TOOLS, type ProTool } from './shortcuts';
import { ToolButton } from './kit/ToolButton';

const ICON: Record<ProTool, React.ReactNode> = {
  select: <MousePointer2 className="h-4 w-4" />,
  text: <Type className="h-4 w-4" />,
  balloon: <MessageCircle className="h-4 w-4" />,
  sfx: <Zap className="h-4 w-4" />,
  shapes: <Shapes className="h-4 w-4" />,
  markup: <SquareDashed className="h-4 w-4" />,
  hand: <Hand className="h-4 w-4" />,
  zoom: <ZoomIn className="h-4 w-4" />
};

/** The rail's width (px) on desktop (master plan §2.7: 48 px). */
export const TOOL_RAIL_W = 48;

export interface ToolRailProps {
  tool: ProTool;
  onTool(tool: ProTool): void;
  /** The tools to show (the Shapes tool only once overlays draw). */
  tools: readonly ProTool[];
  /** Why a shown tool is off. */
  disabled?: Partial<Record<ProTool, string>>;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
}

export const ToolRail: React.FC<ToolRailProps> = ({ tool, onTool, tools, disabled = {}, orientation = 'vertical', className }) => {
  const vertical = orientation === 'vertical';
  const shown = PRO_TOOLS.filter((t) => tools.includes(t.id));
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      aria-orientation={orientation}
      data-testid="pro-tool-rail"
      data-orientation={orientation}
      className={cn(
        'flex shrink-0 bg-[var(--ds-surface-strong)]',
        vertical
          ? 'w-12 flex-col items-center gap-1 overflow-y-auto overscroll-y-contain border-r border-[var(--ds-hairline)] py-2 [scrollbar-width:none]'
          : 'min-w-0 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-[var(--ds-hairline)] px-2 py-1 [scrollbar-width:none]',
        className
      )}
      style={vertical ? { width: TOOL_RAIL_W } : undefined}
      onKeyDown={(e) => {
        // Roving arrows inside the rail (the tool keys work anywhere in the editor).
        const keys = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
        const i = keys.indexOf(e.key);
        if (i < 0) return;
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-slot="tool-button"]'));
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        e.preventDefault();
        e.stopPropagation();
        buttons[(at + (i === 0 ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }}
    >
      {shown.map((t) => (
        <ToolButton
          key={t.id}
          label={t.label}
          shortcut={t.key}
          icon={ICON[t.id]}
          active={tool === t.id}
          disabledReason={disabled[t.id]}
          data-tool={t.id}
          onClick={() => onTool(t.id)}
        />
      ))}
    </div>
  );
};
