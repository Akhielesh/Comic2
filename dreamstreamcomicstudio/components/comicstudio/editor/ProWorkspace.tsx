// The Pro workspace (master plan §2.7 slice 1; PE-SHELL = the C-INSPECT dock + the C-LAYERS mount + C7 slice 1).
//
//   1024 × 768   rail 48 · canvas on --ds-well with a faint dot grid · docked inspector 360 (Properties | Layers |
//                Assets | AI)
//   1280 × 800   the same with a 400 px inspector: the dock is a COLUMN, so it never overlaps the page
//   1440 × 900+  adds the 280 px Layers / Assets rail on the left (only while a part fills it); nothing floats over
//                the page
//   768 tablet   today's layout with the tools as a row under the top bar (ToolRail horizontal)
//   phones       today's layout: the inspector stays a bottom sheet; the thumb bar gains Layers (C9)
//
// The shell only arranges: the panels come from the PE-0 parts (inspector and layers from PE-INSPECT, assets and
// animate in S3), mounted when `part.ready` is true and COMIC_PRO_EDITOR_V2 is on. Every Pro panel reads
// PRO_FREE_FOOTER; "Edit with AI" is the only priced tool and lives in its own AI tab with today's quote.
//
// Also here: the coach cards (Layers, Effects & assets, Animate — shown on the first open of Pro, dismissible, back
// from ?), the shortcut sheet (?), the phone Layers sheet and the frame every Pro panel sits in.

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { PRO_FREE_FOOTER, type ProSample } from '../../../shared/comic/pro/types';
import { DENSITY, FOCUS_RING, INK, MUTED, OVERLAY, OVERLINE, RADIUS_CONTROL, RADIUS_PANEL, ACCENT_SOFT_BG } from '../../chat/studioDesign';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs';
import type { ProWorkspaceLayout } from '../mobile/editor/editorModel';
import { IconButton } from '../board/ui';
import { SHORTCUT_SHEET } from './shortcuts';
import type { ProCoachCard } from './useProEditor';
import { editorZ } from './kit/zLayers';

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

export const ProLayersSheet: React.FC<{ onClose(): void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div
    role="dialog"
    aria-label="Layers"
    data-testid="pro-layers-sheet"
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }}
    className={cn('fixed inset-x-0 bottom-0 flex max-h-[50vh] flex-col overflow-hidden border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[shadow:var(--ds-shadow-overlay)]', editorZ('sheet'))}
    style={{ paddingBottom: 'var(--sa-bottom-eff, env(safe-area-inset-bottom, 0px))' }}
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
