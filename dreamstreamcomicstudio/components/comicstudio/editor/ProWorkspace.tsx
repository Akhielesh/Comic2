// The Pro workspace (master plan §2.7 slice 1; PE-SHELL = the C-INSPECT dock + the C-LAYERS mount + C7 slice 1).
//
//   1024 × 768   rail 48 · canvas on --ds-well with a faint dot grid · docked inspector 360 (Properties | Layers |
//                Assets | AI)
//   1280 × 800   the same with a 400 px inspector: the dock is a COLUMN, so it never overlaps the page
//   1440 × 900+  adds the 280 px Layers / Assets rail on the left (only while a part fills it); nothing floats over
//                the page
//   768 tablet   today's layout with the tools as a row under the top bar (ToolRail horizontal), plus Layers and
//                Assets toggles that open a left overlay drawer, and the inspector part in a bottom sheet (≤ 40 %)
//   phones       today's layout: the inspector stays a bottom sheet; the thumb bar gains Layers (C9), which opens a
//                sheet ABOVE the thumb bar that the stage makes room for (portrait), or a 320 px side sheet (landscape)
//
// LAZY: this module (and the tool rail, the kit's ToolButton and ds/Tabs it brings) loads through editor/proLazy.ts
// only while COMIC_PRO_EDITOR_V2 is on; the Easy path never downloads it (master plan §2.8).
//
// The shell only arranges: the panels come from the PE-0 parts (inspector and layers from PE-INSPECT, assets and
// animate in S3), mounted when `part.ready` is true and COMIC_PRO_EDITOR_V2 is on. Every Pro panel reads
// PRO_FREE_FOOTER; "Edit with AI" is the only priced tool and lives in its own AI tab with today's quote.
//
// Also here: the coach cards (Layers, Effects & assets, Animate — shown on the first open of Pro, dismissible, back
// from ?), the shortcut sheet (?), the phone Layers sheet and the frame every Pro panel sits in.

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Images, Layers, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { PRO_FREE_FOOTER, type ProSample } from '../../../shared/comic/pro/types';
import { DENSITY, FOCUS_RING, INK, MUTED, OVERLAY, OVERLINE, RADIUS_CONTROL, RADIUS_PANEL, ACCENT_SOFT_BG, SCRIM } from '../../chat/studioDesign';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs';
import type { ProWorkspaceLayout } from '../mobile/editor/editorModel';
import { IconButton } from '../board/ui';
import { SHORTCUT_SHEET, type ProTool } from './shortcuts';
import type { MountedParts, ProCoachCard, ProPanelProps } from './useProEditor';
import { editorZ } from './kit/zLayers';
import { ToolButton } from './kit/ToolButton';
import { ToolRail } from './ToolRail';

// ── The frame every Pro panel sits in ────────────────────────────────────────

/** A Pro panel's body and its "Free — done by the editor, no AI cost" footer. */
export const ProPanelFrame: React.FC<{ children: React.ReactNode; free?: boolean; className?: string; testId?: string }> = ({ children, free = true, className, testId }) => (
  <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)} data-testid={testId}>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain px-3 py-3">{children}</div>
    {free && (
      <p data-testid="pro-free-footer" className={cn('m-0 shrink-0 border-t border-[var(--ds-hairline)] px-3 py-1.5 text-[11px]', MUTED)}>
        {PRO_FREE_FOOTER}
      </p>
    )}
  </div>
);

// ── The dock ─────────────────────────────────────────────────────────────────

export type DockTabId = 'properties' | 'layers' | 'assets' | 'ai';

export interface DockTab {
  id: DockTabId;
  label: string;
  content: React.ReactNode;
  /** A free panel (PRO_FREE_FOOTER under it). The AI tab is the one priced place: false. */
  free: boolean;
}

export interface ProDockProps {
  tabs: readonly DockTab[];
  value: DockTabId;
  onChange(id: DockTabId): void;
  /** Width (px): the aside's (360, 400 from 1200). */
  width: number;
  /** Above the tabs (the coach cards). */
  top?: React.ReactNode;
  label?: string;
}

export const ProDock = React.forwardRef<HTMLElement, ProDockProps>(function ProDock({ tabs, value, onChange, width, top, label = 'Inspector' }, ref) {
  const current = tabs.some((t) => t.id === value) ? value : tabs[0]?.id;
  return (
    <aside
      ref={ref}
      aria-label={label}
      data-testid="pro-dock"
      className="flex min-h-0 shrink-0 flex-col border-l border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)]"
      style={{ width }}
    >
      {top}
      {current && (
        <Tabs value={current} onValueChange={(v) => onChange(v as DockTabId)} className="min-h-0 flex-1 gap-0">
          <div className="shrink-0 border-b border-[var(--ds-hairline)] px-3 py-2">
            <TabsList label={label} size="sm" fullWidth>
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} data-dock-tab={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {tabs.map((t) => (
            <TabsContent key={t.id} value={t.id} className="flex min-h-0 flex-1 flex-col focus-visible:outline-none">
              <ProPanelFrame free={t.free} testId={`pro-dock-${t.id}`}>
                {t.content}
              </ProPanelFrame>
            </TabsContent>
          ))}
        </Tabs>
      )}
    </aside>
  );
});

// ── The docked workspace ─────────────────────────────────────────────────────

export interface ProWorkspaceProps {
  layout: ProWorkspaceLayout;
  rail: React.ReactNode;
  /** The 280 px Layers / Assets rail (≥ 1440; only when a part fills it). */
  leftRail?: React.ReactNode;
  /** The canvas column: the mode row, the stage, the filmstrip. */
  main: React.ReactNode;
  dock: React.ReactNode;
  /** Floating pieces that belong to the editor (the menu, the shortcut sheet, the fallback inspector). */
  children?: React.ReactNode;
  rootRef?: React.Ref<HTMLDivElement>;
  bodyRef?: React.Ref<HTMLDivElement>;
}

export const ProWorkspace: React.FC<ProWorkspaceProps> = ({ layout, rail, leftRail, main, dock, children, rootRef, bodyRef }) => (
  <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden" data-layout="desktop" data-pro-workspace={layout.kind}>
    {rail}
    {leftRail && layout.leftRailW > 0 && (
      <aside aria-label="Layers and assets" data-testid="pro-left-rail" className="flex min-h-0 shrink-0 flex-col border-r border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)]" style={{ width: layout.leftRailW }}>
        {leftRail}
      </aside>
    )}
    <div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ds-well)]" data-testid="editor-stage" data-pro-canvas>
      {/* The faint dot grid (styles/ds-motion.css .ds-grid-backdrop), behind everything, never hit. */}
      <div aria-hidden className="ds-grid-backdrop pointer-events-none absolute inset-0" />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
    </div>
    {dock}
    {children}
  </div>
);

// ── Coach cards (§2.2 rule 5) ────────────────────────────────────────────────

export interface ProCoachProps {
  cards: readonly ProCoachCard[];
  onDismiss(): void;
  /** "Start from a sample" (only when samples exist: PE-ASSETS, S3). */
  samples?: readonly ProSample[];
  onSamples?(): void;
  className?: string;
}

export const ProCoach: React.FC<ProCoachProps> = ({ cards, onDismiss, samples = [], onSamples, className }) => {
  const [at, setAt] = useState(0);
  if (!cards.length) return null;
  const card = cards[Math.min(at, cards.length - 1)];
  const last = at >= cards.length - 1;
  return (
    <section aria-label="Pro tips" data-testid="pro-coach" data-card={card.id} className={cn('flex min-w-0 flex-col gap-1.5 border border-[var(--ds-hairline)] px-3 py-2.5', RADIUS_PANEL, ACCENT_SOFT_BG, className)}>
      <p className={cn('m-0', OVERLINE)}>
        Pro tip {Math.min(at, cards.length - 1) + 1} of {cards.length}
      </p>
      <h3 className={cn('m-0 text-[13px] font-semibold', INK)}>{card.title}</h3>
      <p className={cn('m-0 text-[12px] leading-snug [overflow-wrap:anywhere]', INK)}>{card.body}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
        {!last && (
          <button type="button" onClick={() => setAt((i) => i + 1)} className={`${cn('px-2.5 py-1 text-[12px] font-semibold', RADIUS_CONTROL, INK, 'hover:bg-[var(--ds-hover)]', DENSITY.coarse)} ${FOCUS_RING}`}>
            Next tip
          </button>
        )}
        <button type="button" onClick={onDismiss} className={`${cn('px-2.5 py-1 text-[12px] font-semibold underline decoration-[var(--ds-hairline)] underline-offset-2', RADIUS_CONTROL, INK, 'hover:bg-[var(--ds-hover)]', DENSITY.coarse)} ${FOCUS_RING}`}>
          Got it
        </button>
        {samples.length > 0 && onSamples && (
          <button type="button" data-testid="pro-samples" onClick={onSamples} className={`${cn('ml-auto px-2.5 py-1 text-[12px] font-semibold', RADIUS_CONTROL, INK, 'hover:bg-[var(--ds-hover)]', DENSITY.coarse)} ${FOCUS_RING}`}>
            Start from a sample
          </button>
        )}
      </div>
    </section>
  );
};

// ── The shortcut sheet (?) ───────────────────────────────────────────────────

export interface ShortcutSheetProps {
  onClose(): void;
  /** Bring the Pro tips back (shown when there are tips). */
  onTips?(): void;
}

export const ShortcutSheet: React.FC<ShortcutSheetProps> = ({ onClose, onTips }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Shortcuts and Pro tips"
      tabIndex={-1}
      data-testid="pro-shortcuts"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn('fixed right-3 top-14 flex max-h-[min(70vh,36rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden focus-visible:outline-none', OVERLAY, editorZ('popover'))}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-2">
        <h3 className={cn('m-0 min-w-0 flex-1 text-[13px] font-semibold', INK)}>Shortcuts</h3>
        <IconButton label="Close the shortcuts" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {SHORTCUT_SHEET.map((g) => (
          <section key={g.title} className="py-1.5" aria-label={g.title}>
            <h4 className={cn('m-0 pb-1', OVERLINE)}>{g.title}</h4>
            <dl className="m-0 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
              {g.rows.map((r) => (
                <React.Fragment key={`${g.title}-${r.keys}`}>
                  <dt className={cn('min-w-0 font-mono text-[11.5px] [overflow-wrap:anywhere]', INK)}>{r.keys}</dt>
                  <dd className={cn('m-0 min-w-0 text-[12px] leading-snug', MUTED)}>{r.label}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {onTips && (
        <footer className="shrink-0 border-t border-[var(--ds-hairline)] px-3 py-2">
          <button type="button" data-testid="pro-tips-again" onClick={onTips} className={`${cn('px-2.5 py-1 text-[12px] font-semibold', RADIUS_CONTROL, INK, 'hover:bg-[var(--ds-hover)]', DENSITY.coarse)} ${FOCUS_RING}`}>
            Show the Pro tips again
          </button>
        </footer>
      )}
    </div>
  );
};

// ── The phone Layers sheet (C9) ──────────────────────────────────────────────

export interface ProLayersSheetProps {
  onClose(): void;
  children: React.ReactNode;
  /**
   * 'bottom' (phone portrait): a sheet at the foot of the stage column, ABOVE the thumb bar, `height` px tall; the page
   * editor shrinks the stage by the same height, so the whole page stays above it. 'side' (phone landscape): a 320 px
   * column beside the stage (master plan §2.7: the rail plus a 320 px side sheet). Neither floats over the page.
   */
  variant?: 'bottom' | 'side';
  height?: number;
}

export const PRO_SIDE_SHEET_W = 320;

export const ProLayersSheet: React.FC<ProLayersSheetProps> = ({ onClose, children, variant = 'bottom', height }) => (
  <div
    role="dialog"
    aria-label="Layers"
    data-testid="pro-layers-sheet"
    data-variant={variant}
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }}
    className={cn(
      'flex min-h-0 flex-col overflow-hidden bg-[var(--ds-surface-strong)]',
      variant === 'side'
        ? 'shrink-0 border-l border-[var(--ds-hairline)]'
        : cn('absolute inset-x-0 bottom-0 border-t border-[var(--ds-hairline)] shadow-[shadow:var(--ds-shadow-overlay)]', editorZ('sheet'))
    )}
    style={variant === 'side' ? { width: PRO_SIDE_SHEET_W } : { height }}
  >
    <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-1.5">
      <h3 className={cn('m-0 min-w-0 flex-1 text-[13px] font-semibold', INK)}>Layers</h3>
      <IconButton label="Close Layers" onClick={onClose}>
        <X className="h-4 w-4" aria-hidden />
      </IconButton>
    </header>
    <ProPanelFrame>{children}</ProPanelFrame>
  </div>
);

// ── A mounted part (its Panel may be lazy: PE-INSPECT's loadPanel) ───────────

const PartSlot: React.FC<{ Panel: React.ComponentType<ProPanelProps>; props: ProPanelProps }> = ({ Panel, props }) => (
  <Suspense fallback={null}>
    <Panel {...props} />
  </Suspense>
);

// ── The docked workspace, composed (≥ 1024; the page editor hands it its pieces) ──

export interface ProDockedWorkspaceProps {
  layout: ProWorkspaceLayout;
  rootRef?: React.Ref<HTMLDivElement>;
  bodyRef?: React.Ref<HTMLDivElement>;
  dockRef?: React.Ref<HTMLElement>;
  tool: ProTool;
  onTool(tool: ProTool): void;
  tools: readonly ProTool[];
  disabled: Partial<Record<ProTool, string>>;
  parts: MountedParts;
  panelProps: ProPanelProps;
  /** Properties without the inspector part: the whole-comic lettering style; under it, always, the script. */
  letteringStyle: React.ReactNode;
  script: React.ReactNode;
  /** The AI tab: Edit with AI, page actions, QC, versions (the one priced place; no free footer). */
  ai: React.ReactNode;
  modeRow: React.ReactNode;
  stage: React.ReactNode;
  filmstrip: React.ReactNode;
  /** The coach cards, above the dock's tabs. */
  coach?: React.ReactNode;
  dockTab: DockTabId;
  onDockTab(id: DockTabId): void;
  leftTab: 'layers' | 'assets';
  onLeftTab(id: 'layers' | 'assets'): void;
  /** Floating pieces (the fallback lettering panel, the menu). */
  children?: React.ReactNode;
}

/**
 * The rail, the canvas, the dock (Properties | Layers | Assets | AI) and, from 1440 px, the Layers / Assets rail; the
 * animate part's timeline (proMotion) under the stage in its own free frame. Nothing floats over the page.
 */
export const ProDockedWorkspace: React.FC<ProDockedWorkspaceProps> = ({
  layout,
  rootRef,
  bodyRef,
  dockRef,
  tool,
  onTool,
  tools,
  disabled,
  parts,
  panelProps,
  letteringStyle,
  script,
  ai,
  modeRow,
  stage,
  filmstrip,
  coach,
  dockTab,
  onDockTab,
  leftTab,
  onLeftTab,
  children
}) => {
  const { inspector: InspectorPart, layers: LayersPart, assets: AssetsPart, animate: AnimatePart } = parts;
  const leftRailOn = layout.leftRailW > 0 && !!(LayersPart || AssetsPart);
  const properties = (
    <div className="flex min-w-0 flex-col gap-4">
      {InspectorPart ? <PartSlot Panel={InspectorPart} props={panelProps} /> : letteringStyle}
      {script}
    </div>
  );
  const tabs: DockTab[] = [
    { id: 'properties', label: 'Properties', content: properties, free: true },
    ...(!leftRailOn && LayersPart ? [{ id: 'layers' as const, label: 'Layers', content: <PartSlot Panel={LayersPart} props={panelProps} />, free: true }] : []),
    ...(!leftRailOn && AssetsPart ? [{ id: 'assets' as const, label: 'Assets', content: <PartSlot Panel={AssetsPart} props={panelProps} />, free: true }] : []),
    { id: 'ai', label: 'AI', content: <div className="flex min-w-0 flex-col gap-4">{ai}</div>, free: false }
  ];
  const leftTabs = [
    ...(LayersPart ? [{ id: 'layers' as const, label: 'Layers', node: <PartSlot Panel={LayersPart} props={panelProps} /> }] : []),
    ...(AssetsPart ? [{ id: 'assets' as const, label: 'Assets', node: <PartSlot Panel={AssetsPart} props={panelProps} /> }] : [])
  ];
  const leftValue = leftTabs.some((t) => t.id === leftTab) ? leftTab : leftTabs[0]?.id;
  const leftRail =
    leftRailOn && leftValue ? (
      <Tabs value={leftValue} onValueChange={(v) => onLeftTab(v as 'layers' | 'assets')} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b border-[var(--ds-hairline)] px-3 py-2">
          <TabsList label="Layers and assets" size="sm" fullWidth>
            {leftTabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {leftTabs.map((t) => (
          <TabsContent key={t.id} value={t.id} className="flex min-h-0 flex-1 flex-col focus-visible:outline-none">
            <ProPanelFrame>{t.node}</ProPanelFrame>
          </TabsContent>
        ))}
      </Tabs>
    ) : undefined;
  return (
    <ProWorkspace
      layout={layout}
      rootRef={rootRef}
      bodyRef={bodyRef}
      rail={<ToolRail tool={tool} onTool={onTool} tools={tools} disabled={disabled} orientation="vertical" />}
      leftRail={leftRail}
      main={
        <>
          {modeRow}
          {stage}
          {AnimatePart && (
            // The timeline strip is a Pro panel too: its free footer under it (the shell draws it).
            <div className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)]" data-testid="pro-timeline">
              <ProPanelFrame>
                <PartSlot Panel={AnimatePart} props={panelProps} />
              </ProPanelFrame>
            </div>
          )}
          {filmstrip}
        </>
      }
      dock={<ProDock ref={dockRef} tabs={tabs} value={dockTab} onChange={onDockTab} width={layout.dockW} top={coach} />}
    >
      {children}
    </ProWorkspace>
  );
};

// ── The tablet tool row (768: tools as a row; Layers / Assets toggles) ───────

export type ProDrawerId = 'layers' | 'assets';

export interface ProToolRowProps {
  tool: ProTool;
  onTool(tool: ProTool): void;
  tools: readonly ProTool[];
  disabled: Partial<Record<ProTool, string>>;
  /** The drawer toggles to show (a part that is mounted), and which drawer is open. */
  drawers: readonly ProDrawerId[];
  drawer: ProDrawerId | null;
  onDrawer(id: ProDrawerId | null): void;
}

const DRAWER_LABEL: Record<ProDrawerId, string> = { layers: 'Layers', assets: 'Assets' };

export const ProToolRow: React.FC<ProToolRowProps> = ({ tool, onTool, tools, disabled, drawers, drawer, onDrawer }) => (
  <ToolRail
    tool={tool}
    onTool={onTool}
    tools={tools}
    disabled={disabled}
    orientation="horizontal"
    extra={
      drawers.length ? (
        <span role="group" aria-label="Panels" className="ml-auto flex shrink-0 items-center gap-1 border-l border-[var(--ds-hairline)] pl-1" data-testid="pro-drawer-toggles">
          {drawers.map((id) => (
            <ToolButton
              key={id}
              label={DRAWER_LABEL[id]}
              icon={id === 'layers' ? <Layers className="h-4 w-4" /> : <Images className="h-4 w-4" />}
              active={drawer === id}
              // Only while the drawer is mounted: an aria-controls naming a missing id is invalid ARIA (axe critical).
              aria-controls={drawer ? 'pro-drawer' : undefined}
              data-drawer={id}
              data-testid={`pro-drawer-${id}`}
              onClick={() => onDrawer(drawer === id ? null : id)}
            />
          ))}
        </span>
      ) : undefined
    }
  />
);

// ── The tablet drawer (Layers / Assets) and the tablet inspector sheet ───────

export interface ProDrawerProps {
  id: ProDrawerId;
  onClose(): void;
  children: React.ReactNode;
}

/**
 * The 768 tablet's left overlay drawer (master plan §2.7: "Layers and Assets in a left overlay drawer"): over the stage,
 * on the sheet layer, a scrim behind it that closes it; Esc closes; its panel reads PRO_FREE_FOOTER.
 */
export const ProDrawer: React.FC<ProDrawerProps> = ({ id, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [id]);
  return (
    <>
      <button type="button" aria-label={`Close ${DRAWER_LABEL[id]}`} tabIndex={-1} data-testid="pro-drawer-scrim" onClick={onClose} className={cn('absolute inset-0 cursor-default', SCRIM, editorZ('scrim'))} />
      <div
        ref={ref}
        id="pro-drawer"
        role="dialog"
        aria-label={DRAWER_LABEL[id]}
        tabIndex={-1}
        data-testid="pro-drawer"
        data-drawer={id}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className={cn('absolute inset-y-0 left-0 flex min-h-0 flex-col overflow-hidden border-r border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[shadow:var(--ds-shadow-overlay)] focus-visible:outline-none', editorZ('sheet'))}
        style={{ width: `min(${PRO_SIDE_SHEET_W}px, 85vw)` }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-1.5">
          <h3 className={cn('m-0 min-w-0 flex-1 text-[13px] font-semibold', INK)}>{DRAWER_LABEL[id]}</h3>
          <IconButton label={`Close ${DRAWER_LABEL[id]}`} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </IconButton>
        </header>
        <ProPanelFrame>{children}</ProPanelFrame>
      </div>
    </>
  );
};

/** The 768 tablet's inspector (master plan §2.7: an AdaptiveSheet at most 40 % tall): the inspector part, at the stage's foot. */
export const ProInspectorSheet: React.FC<{ onClose(): void; height: number; children: React.ReactNode }> = ({ onClose, height, children }) => (
  <div
    role="dialog"
    aria-label="Properties"
    data-testid="pro-inspector-sheet"
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }}
    className={cn('absolute inset-x-0 bottom-0 flex max-h-[40vh] min-h-0 flex-col overflow-hidden border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[shadow:var(--ds-shadow-overlay)]', editorZ('sheet'))}
    style={{ height }}
  >
    <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-1.5">
      <h3 className={cn('m-0 min-w-0 flex-1 text-[13px] font-semibold', INK)}>Properties</h3>
      <IconButton label="Close Properties" onClick={onClose}>
        <X className="h-4 w-4" aria-hidden />
      </IconButton>
    </header>
    <ProPanelFrame>{children}</ProPanelFrame>
  </div>
);

export interface ProTabletPanelsProps {
  parts: MountedParts;
  panelProps: ProPanelProps;
  drawer: ProDrawerId | null;
  onDrawer(id: ProDrawerId | null): void;
  /** The inspector sheet shows (a selection, the inspector part mounted) and its height (≤ 40 % of the body). */
  inspector: boolean;
  inspectorHeight: number;
  onCloseInspector(): void;
}

/** The tablet's Pro panels: the left drawer and the inspector sheet, each with the mounted part in it. */
export const ProTabletPanels: React.FC<ProTabletPanelsProps> = ({ parts, panelProps, drawer, onDrawer, inspector, inspectorHeight, onCloseInspector }) => {
  const DrawerPart = drawer === 'layers' ? parts.layers : drawer === 'assets' ? parts.assets : undefined;
  const InspectorPart = parts.inspector;
  return (
    <>
      {inspector && InspectorPart && (
        <ProInspectorSheet onClose={onCloseInspector} height={inspectorHeight}>
          <PartSlot Panel={InspectorPart} props={panelProps} />
        </ProInspectorSheet>
      )}
      {drawer && DrawerPart && (
        <ProDrawer id={drawer} onClose={() => onDrawer(null)}>
          <PartSlot Panel={DrawerPart} props={panelProps} />
        </ProDrawer>
      )}
    </>
  );
};
