// QA scene `shared` (DS-3; the scene contract is in qa/app/index.tsx): the four states a legacy share link
// (/share/<token>) can show before the comic opens — loading, sign in, not active (revoked, expired, not
// shared with you, moved to a studio link) and couldn't open — in the Atlas state views, one after another on
// one page with its one <main>. They are the same component the page renders (SharedViewerStateView); the
// buttons are no-ops, so nothing navigates or reaches the network.

import React from 'react';
import { SharedViewerStateView, type SharedViewerNotice } from '../../../components/SharedViewer';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE, RADIUS_PANEL } from '../../../components/chat/studioDesign';
import type { QaAppScene } from '../index';

const noop = () => undefined;

const STATES: Array<{ id: string; label: string; notice: SharedViewerNotice }> = [
  { id: 'loading', label: 'Checking the link', notice: { status: 'loading' } },
  { id: 'sign-in', label: 'The owner asks readers to sign in', notice: { status: 'login_required' } },
  { id: 'gone', label: 'Turned off or never existed', notice: { status: 'not_active', reason: 'gone' } },
  { id: 'expired', label: 'Expired', notice: { status: 'not_active', reason: 'expired' } },
  { id: 'no-access', label: 'Shared with other people', notice: { status: 'not_active', reason: 'no_access' } },
  { id: 'studio', label: 'Moved to a Comic Studio link', notice: { status: 'not_active', reason: 'studio' } },
  { id: 'error', label: 'Could not be checked', notice: { status: 'error', message: 'The network request did not finish.' } }
];

const SharedScene: React.FC = () => (
  <main aria-labelledby="qa-shared-title" className={cn('min-h-[100dvh] min-w-0 px-4 py-8 sm:px-6', CANVAS_BG, INK)}>
    <div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-1">
        <p className={cn('m-0', OVERLINE)}>Shared link</p>
        <h1 id="qa-shared-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          What a share link shows before the comic opens
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>Each state as the page renders it, centred on the canvas.</p>
      </header>
      {STATES.map((s) => (
        <section
          key={s.id}
          aria-label={s.label}
          data-qa-shared-state={s.id}
          className={cn('min-w-0 border border-[var(--ds-hairline-soft)] px-4 py-10', RADIUS_PANEL)}
        >
          <p className={cn('m-0 mb-6 text-center', OVERLINE)}>{s.label}</p>
          <SharedViewerStateView notice={s.notice} onSignIn={noop} onRetry={noop} onGoHome={noop} headingLevel={2} />
        </section>
      ))}
    </div>
  </main>
);

const scene: QaAppScene = { id: 'shared', title: 'Shared link states (loading, sign in, not active, couldn’t open)', Scene: SharedScene };
export default scene;
