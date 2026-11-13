// Easy / Pro view toggle (softwarefirst.md §5.3; decisions-final #1). Mode is a VIEW, never a
// permission: every edit stays reachable in Easy (and by asking the director). The only gate is the
// `caps.proEditor` capability, which is true for everyone today.
//
// Placement: a 2-segment pill in the regular studio header (from 1024 px; 1100 on touch); below that —
// phones and narrow tablets, where the title and the pane switcher need the room — the header slot
// renders nothing and the same control lives at the top of the ⋯ menu (`variant="menu"`).

import React from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import { proEditorV2On, type StudioMode } from '../../../shared/comic/capabilities';
import type { StudioController } from '../types';
import { Segmented } from '../board/ui';
import { editorViewFor } from '../editor/useProEditor';
import { readStoredMode } from '../useStudioMode';
import { headerVariantFor } from './formFactor';
import { editorLayoutFor } from './editor/editorModel';
import { useFormFactor } from './useFormFactor';

// R00 SF-2: honest about what Pro changes today. The board ignores the mode; Pro's difference lives inside a page.
// With the Pro editor flag on (COMIC_PRO_EDITOR_V2) that is the Pro workspace: layers and numeric fields. With it off
// it is the older Pro lettering panel, which has no layers, so the words say only what that panel gives.
export const MODE_HINT = 'Easy keeps it simple. Pro adds layers and exact numbers inside a page.';
export const MODE_HINT_LETTERING = 'Easy keeps it simple. Pro shows every lettering setting for a selected balloon.';
const PRO_TITLE = 'Pro: layers and exact numbers inside a page';
const PRO_TITLE_LETTERING = 'Pro: every lettering setting for a selected balloon';

/** The hint for this viewer: what Pro really adds with their editor (proEditorV2 on or off). */
export const modeHintFor = (caps: StudioController['caps'] | undefined): string => (proEditorV2On(caps) ? MODE_HINT : MODE_HINT_LETTERING);

export interface ModeToggleProps {
  studio: Pick<StudioController, 'mode' | 'setMode' | 'caps'>;
  compact?: boolean;
  /** 'header' (default): only in the regular header (≥ 1024; ≥ 1100 on touch). 'menu': full width with a one-line explanation. */
  variant?: 'header' | 'menu';
}

export const ModeToggle: React.FC<ModeToggleProps> = ({ studio, compact = false, variant = 'header' }) => {
  const ff = useFormFactor();
  if (variant === 'header' && headerVariantFor(ff) !== 'regular') return null;
  const proAllowed = studio.caps?.proEditor !== false;
  const v2 = proEditorV2On(studio.caps);
  const hint = modeHintFor(studio.caps);
  // Show the view the page editor will really open in (R00 SF-2): with the Pro editor on, a phone opens in Easy until
  // this device has a stored choice (editorViewFor, D7), whatever the plan default says. Elsewhere it is studio.mode.
  const mode: StudioMode = editorViewFor({
    flag: v2,
    canPro: proAllowed,
    phone: editorLayoutFor(ff).toolbar !== 'top',
    studioMode: studio.mode,
    stored: readStoredMode()
  });
  const options = [
    {
      value: 'easy' as StudioMode,
      title: 'Easy: the essentials — ask the director for anything else',
      label: (
        <>
          {variant === 'menu' && <Gauge className="h-3.5 w-3.5" aria-hidden />}
          Easy
        </>
      )
    },
    {
      value: 'pro' as StudioMode,
      title: proAllowed ? (v2 ? PRO_TITLE : PRO_TITLE_LETTERING) : 'The Pro editor isn’t available on this plan',
      disabled: !proAllowed,
      label: (
        <>
          {variant === 'menu' && <Sparkles className="h-3.5 w-3.5" aria-hidden />}
          Pro
        </>
      )
    }
  ];

  // A tap always stores the choice, even on the option already shown (R00 SF-2), so this device's pick is kept.
  const pick = (m: StudioMode) => studio.setMode(m);

  if (variant === 'menu') {
    return (
      <div className="min-w-0" data-action="mode">
        <Segmented label="Editor view" value={mode} onChange={pick} options={options} className="w-full" />
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--ds-muted)]">{hint}</p>
      </div>
    );
  }

  return (
    // data-action: the one home of the Easy | Pro view switch in a viewport (declutter C2; DC-1 wave note 8).
    <span title={hint} className="inline-flex shrink-0" data-action="mode">
      <Segmented label="Editor view" value={mode} onChange={pick} options={options} size={compact ? 'xs' : 'sm'} />
    </span>
  );
};

/** Header-slot adapter (registered by mobile/index.ts). */
export const ModeToggleSlot: React.FC<{ studio: StudioController; compact: boolean }> = ({ studio, compact }) => <ModeToggle studio={studio} compact={compact} />;

export default ModeToggle;
