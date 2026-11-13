// The one Easy | Pro switch (master plan §2.2 "The switch"; redesign plan §11.3 M6): ONE Segmented (SEGMENTED_ACTIVE on
// --ds-segment-track) bound to the studio's mode (useStudioMode through studio.setMode); its group is "Easy or Pro mode"
// and its Pro option reads "Pro mode" to a screen reader (no ⋯ copy). Switching never sends an op (zero-confusion rule 1).
// Its own small module: the page editor's header shows it on the Easy path, where the Pro top bar is not loaded
// (master plan §2.8). ProTopBar re-exports it; DS-R10 reuses it for the Pages toolbar.

import React from 'react';
import { cn } from '../../../lib/utils';
import type { StudioMode } from '../../../shared/comic/capabilities';
import { Segmented } from '../board/ui';

/** The switch's group name (M6: not "Editor view"). */
export const MODE_GROUP_LABEL = 'Easy or Pro mode';

export interface ProModeSwitchProps {
  value: StudioMode;
  onChange(mode: StudioMode): void;
  /** caps.proEditor (true for everyone today; "Pro" is never "paid"). */
  canPro: boolean;
  size?: 'xs' | 'sm';
  className?: string;
}

/** The one Easy | Pro switch (header on every layout; the Pages toolbar under DS-R10). */
export const ProModeSwitch: React.FC<ProModeSwitchProps> = ({ value, onChange, canPro, size = 'xs', className }) => (
  <span className={cn('inline-flex shrink-0', className)} data-testid="pro-mode-switch">
    <Segmented<StudioMode>
      label={MODE_GROUP_LABEL}
      size={size}
      value={canPro ? value : 'easy'}
      onChange={(m) => m !== value && onChange(m)}
      options={[
        {
          value: 'easy',
          title: 'Easy mode: the essentials. Everything stays on the page.',
          label: (
            <>
              Easy <span className="sr-only">mode</span>
            </>
          )
        },
        {
          value: 'pro',
          disabled: !canPro,
          title: canPro ? 'Pro mode: tools, layers and exact numbers. Free, done by the editor.' : 'Pro mode isn’t available here',
          label: (
            <>
              Pro <span className="sr-only">mode</span>
            </>
          )
        }
      ]}
    />
  </span>
);
