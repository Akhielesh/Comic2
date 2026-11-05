// Pro Edit QA surface (DS-1b stub; master plan §1.3 DS-1b and §3.2: Program 2 owns qa/pro/** from slot S2):
//
//   /qa/comic-qa.html?surface=pro[&scene=<id>]&fixture=…&theme=light|dark&skin=atlas|none
//
// Today it renders a placeholder page, so the URL, the crash boundary and the data-qa-ready contract are in
// place before the first Pro scene lands. Program 2 replaces this file in place: keep the export's name and
// props (the harness passes the parsed Comic Studio params with `surface: 'pro'`, and the `scene=` value).

import React from 'react';
import { cn } from '../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE } from '../../components/chat/studioDesign';
import type { QaParams } from '../../components/comicstudio/testing/qaController';

/** The Pro Edit scenes this surface can mount (none until Program 2 adds them). */
export const QA_PRO_SCENES: readonly string[] = [];

/** What the harness hands the Pro surface: the parsed Comic Studio params (fixture, theme, mode, …), on surface 'pro'. */
export type QaProParams = Omit<QaParams, 'surface'> & { surface: 'pro' };

export const QaProSurface: React.FC<{ params: QaProParams; scene: string | null }> = ({ params, scene }) => (
  <main id="qa-main" aria-labelledby="qa-pro-title" data-qa-pro="placeholder" data-qa-surface={params.surface} className={cn('min-h-[100dvh] min-w-0 px-4 py-6 sm:px-6', CANVAS_BG, INK)}>
    <div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-1">
      <p className={cn('m-0', OVERLINE)}>QA harness</p>
      <h1 id="qa-pro-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
        Pro Edit scenes
      </h1>
      <p className={cn('m-0 text-[length:var(--ds-text-sm)] [overflow-wrap:anywhere]', MUTED)}>
        {scene ? `No Pro Edit scene named "${scene}" yet. ` : ''}The Pro Edit program adds its editor scenes here; until then this page is a placeholder.
      </p>
    </div>
  </main>
);
