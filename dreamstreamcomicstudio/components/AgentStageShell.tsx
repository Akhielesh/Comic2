import React from 'react';
import { cn } from '../lib/utils';
import {
  HAIRLINE,
  HEADING,
  OVERLINE,
  RADIUS_PANEL,
  RISE_IN,
  SECTION_ICON_TILE,
  SHADOW_SOFT,
  SIDEBAR_BG,
  TEXT_XL,
  TRANSITION,
  WRAP_TEXT
} from './chat/studioDesign';

interface AgentStageShellProps {
  eyebrow: string;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  minHeightClassName?: string;
}

/**
 * The classic editor's stage frame in the Atlas language: one opaque panel (hairline, soft shadow, the panel
 * radius), a header with the step's eyebrow, title and actions, and an optional sidebar on the sidebar paper.
 * The recipes below are shared by the classic steps that lay out their own boards inside the frame.
 */
export const STAGE_FRAME = `overflow-hidden ${RADIUS_PANEL} ${HAIRLINE} ${SHADOW_SOFT} bg-[var(--ds-surface)] text-[var(--ds-ink)]`;
/** A board's own header row inside the frame (a title, a count, an action). */
export const STAGE_BOARD_HEADER = 'flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ds-hairline)] px-5 py-4';
/** A board's title (a small section heading, not an eyebrow). */
export const STAGE_BOARD_TITLE = 'm-0 text-[length:var(--ds-text-base)] font-semibold leading-5 text-[var(--ds-ink)]';
/** A card inside the frame: the surface step, hairline, control radius. */
export const STAGE_CARD = `${HAIRLINE} rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)]`;
/** A quiet well inside the frame (context lists, empty boards). */
export const STAGE_WELL = `${HAIRLINE} rounded-[var(--ds-radius-control)] bg-[var(--ds-well)]`;
/** A dashed drop / upload tile: a label wrapping a visually hidden (`sr-only`, still focusable) file input, so the
 *  focus-within ring shows when the keyboard reaches the picker. 44 px tall at least. */
export const UPLOAD_TILE = `relative flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--ds-radius-control)] border border-dashed border-[var(--ds-control-border)] bg-[var(--ds-well)] px-4 py-3 text-sm text-[var(--ds-muted)] hover:border-[var(--ds-control-border-hover)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--ds-focus)] ${TRANSITION}`;
/**
 * html2canvas `onclone` for the classic downloads (reference card PNG / PDF, the comic PDF): the capture is taken in
 * the light theme, so the exported file is the same light paper whatever theme the screen shows. Transitions are
 * held in the clone so no colour is read mid-fade.
 */
export function captureInLightTheme(doc: Document): void {
  const hold = doc.createElement('style');
  hold.textContent = '*,*::before,*::after{transition:none !important}';
  doc.head.appendChild(hold);
  doc.documentElement.classList.remove('dark');
}
/** Spread into an html2canvas options object (the loader's option type does not list `onclone`; html2canvas takes it). */
export const LIGHT_CAPTURE: { onclone: (doc: Document) => void } = { onclone: captureInLightTheme };

/** Body copy and its muted step. */
export const STAGE_BODY = `text-sm leading-6 text-[var(--ds-muted)] ${WRAP_TEXT}`;

export const AgentStageShell: React.FC<AgentStageShellProps> = ({
  eyebrow,
  title,
  description,
  icon,
  actions,
  sidebar,
  children,
  minHeightClassName = 'min-h-[680px]'
}) => {
  return (
    <div className={cn('mx-auto w-full max-w-7xl', RISE_IN)}>
      <div className={STAGE_FRAME}>
        <div className="flex flex-col gap-4 border-b border-[var(--ds-hairline)] px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {icon && <div className={SECTION_ICON_TILE}>{icon}</div>}
            <div className="min-w-0">
              <div className={OVERLINE}>{eyebrow}</div>
              <h2 className={cn('m-0', HEADING, TEXT_XL, WRAP_TEXT)}>{title}</h2>
              {description && <p className={cn('mt-1 max-w-2xl', STAGE_BODY)}>{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>

        {sidebar ? (
          <div className={`grid grid-cols-1 lg:grid-cols-[360px_1fr] ${minHeightClassName}`}>
            <aside className={cn('min-w-0 border-b border-[var(--ds-hairline)] px-5 py-5 lg:border-b-0 lg:border-r', SIDEBAR_BG)}>
              {sidebar}
            </aside>
            <section className="min-w-0 bg-[var(--ds-surface)]">{children}</section>
          </div>
        ) : (
          <section className={`${minHeightClassName} min-w-0 bg-[var(--ds-surface)]`}>{children}</section>
        )}
      </div>
    </div>
  );
};
