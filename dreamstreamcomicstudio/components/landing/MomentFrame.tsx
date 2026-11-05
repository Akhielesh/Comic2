/**
 * The frame every studio's motion moment plays in (bridge §8): a fixed-shape card (square on a phone, 5:4
 * from 600 px, so nothing below it
 * moves when the demo arrives) with the studio's mark and a caption, drawn eagerly; the demo inside is a
 * lazily loaded chunk (./moments/homeMoments.ts), requested when the page goes idle or the frame nears the viewport.
 *
 * The frame is the accessible thing: `role="img"` named by `label` from first paint. Everything inside it
 * is decoration (aria-hidden). If the chunk fails, the frame simply stays empty (QuietBoundary).
 */
import React, { Suspense, useRef } from 'react';
import { StudioMark } from '../brand/StudioMark';
import type { Studio } from '../brand/studios';
import { INVERSE_SURFACE } from '../chat/studioDesign';
import { FRAME_SHADOW } from './landingStyles';
import { QuietBoundary } from './QuietBoundary';
import { useNearViewport } from './useNearViewport';

const loadMoments = () => import('./moments/homeMoments');

/** Warm the demos' chunk (called when the page is idle), so a frame scrolled into view fills at once. */
export const preloadMoments = (): void => {
  loadMoments().catch(() => undefined);
};

export type MomentId = 'comic' | 'stream' | 'chat' | 'atlas';

const BODIES: Record<MomentId, React.LazyExoticComponent<React.ComponentType>> = {
  comic: React.lazy(() => loadMoments().then((m) => ({ default: m.ComicMoment }))),
  stream: React.lazy(() => loadMoments().then((m) => ({ default: m.StreamMoment }))),
  chat: React.lazy(() => loadMoments().then((m) => ({ default: m.ChatMoment }))),
  atlas: React.lazy(() => loadMoments().then((m) => ({ default: m.AtlasMoment })))
};

export interface MomentFrameProps {
  moment: MomentId;
  studio: Studio;
  /** The caption beside the mark. */
  title: string;
  /** What the demo shows, for assistive tech. */
  label: string;
  /** The dark stage (Stream Studio): an inverse surface in both themes. */
  stage?: boolean;
}

const SURFACE_FRAME = 'border border-ds-hairline bg-ds-surface text-ds-ink';
const STAGE_FRAME = `${INVERSE_SURFACE} border border-transparent`;

export function MomentFrame({ moment, studio, title, label, stage = false }: MomentFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const Body = BODIES[moment];

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-moment={moment}
      className={`relative aspect-square w-full overflow-hidden medium:aspect-[5/4] rounded-[var(--ds-radius-feature)] ${FRAME_SHADOW} ${stage ? STAGE_FRAME : SURFACE_FRAME}`}
    >
      <div
        aria-hidden="true"
        className={`flex h-10 items-center gap-2 border-b px-4 text-xs font-medium ${stage ? 'border-ds-canvas/10' : 'border-ds-hairline'}`}
      >
        <StudioMark studio={studio} size={16} />
        <span>{title}</span>
      </div>
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 top-10">
        {near ? (
          <QuietBoundary fallback={null}>
            <Suspense fallback={null}>
              <Body />
            </Suspense>
          </QuietBoundary>
        ) : null}
      </div>
    </div>
  );
}
