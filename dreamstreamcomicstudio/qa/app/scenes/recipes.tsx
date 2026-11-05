// QA scene `recipes` (DS-1b; the scene contract is in qa/app/index.tsx): the shared design recipes of
// components/chat/studioDesign.ts as they exist today — type, actions, fields, the segmented track, chips
// and the one status vocabulary, surfaces (glass panel, overlay, toast, inverse panel) and navigation rows —
// composed only from those constants and the --ds-* tokens, so the app layout smoke measures the recipes
// themselves at every viewport, light and dark, with and without the Atlas skin. Interactive pieces keep
// local state so keyboard and touch checks see a live control. Nothing here reaches the network.

import React, { useState } from 'react';
import { Bell, Check, Plus, Search, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  CANVAS_BG,
  CHIP,
  CHIP_VARIANT,
  CONTROL_BTN,
  DIALOG_TITLE,
  FIELD,
  FIELD_EMBEDDED,
  FIELD_GROUP,
  FOCUS_ITEM,
  FOCUS_RING,
  FOCUS_RING_FLUSH,
  HEADING,
  INK,
  INVERSE_SURFACE,
  MENU_ITEM,
  MUTED,
  NAV_ROW,
  NAV_ROW_ACTIVE,
  OVERLAY,
  OVERLINE,
  PANEL,
  PRESS,
  PRIMARY_BTN,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  SECTION_BODY,
  SECTION_CARD,
  SECTION_DESCRIPTION,
  SECTION_HEADER,
  SECTION_ICON_TILE,
  SECTION_TITLE,
  SEGMENTED_ACTIVE_FILL,
  SEGMENTED_ITEM,
  SEGMENTED_TRACK,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_DOT,
  STATUS_INK,
  TOAST,
  TOAST_EDGE,
  TOAST_MESSAGE,
  TOAST_TITLE,
  TONE_CHIP,
  TONE_TEXT,
  type StatusState,
  type StatusTone
} from '../../../components/chat/studioDesign';
import type { QaAppScene } from '../index';

/** Every control is 36 px on a fine pointer and 44 px under a coarse one (the smoke probes it). */
const CONTROL_H = 'h-9 coarse:h-11';
const ICON_BTN = 'inline-flex size-9 shrink-0 items-center justify-center coarse:size-11';
const BODY = 'm-0 text-[length:var(--ds-text-base)] leading-6';
const ROW = 'flex min-w-0 flex-wrap items-center gap-2';
const STACK = 'flex min-w-0 flex-col gap-4';

const STATES: ReadonlyArray<[StatusState, string]> = [
  ['healthy', 'Connected'],
  ['active', 'Drawing page 3'],
  ['waiting', 'Queued'],
  ['attention', 'Low on credits'],
  ['error', 'Upload failed']
];
const TONES: ReadonlyArray<[StatusTone, string]> = [
  ['success', 'Saved'],
  ['warning', 'Needs review'],
  ['danger', 'Blocked'],
  ['info', 'New'],
  ['neutral', 'Draft']
];
const MODES = ['Easy', 'Pro', 'Auto'] as const;

const Section: React.FC<{ id: string; title: string; description: string; icon: React.ReactNode; children: React.ReactNode }> = ({ id, title, description, icon, children }) => (
  <section aria-labelledby={`recipes-${id}`} data-qa-recipe={id} className={cn(SECTION_CARD, 'min-w-0')}>
    <header className={SECTION_HEADER}>
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className={SECTION_ICON_TILE}>
          {icon}
        </span>
        <div className="min-w-0">
          <h2 id={`recipes-${id}`} className={SECTION_TITLE}>
            {title}
          </h2>
          <p className={SECTION_DESCRIPTION}>{description}</p>
        </div>
      </div>
    </header>
    <div className={cn(SECTION_BODY, STACK)}>{children}</div>
  </section>
);

const Actions: React.FC = () => {
  const [count, setCount] = useState(0);
  return (
    <Section id="actions" title="Actions" description="PRIMARY_BTN, CONTROL_BTN and an icon button, with FOCUS_RING and PRESS." icon={<Plus className="size-4" />}>
      <div className={ROW}>
        <button type="button" onClick={() => setCount((n) => n + 1)} className={cn(PRIMARY_BTN, FOCUS_RING, PRESS, CONTROL_H, RADIUS_CONTROL, 'inline-flex items-center gap-2 px-4 text-[length:var(--ds-text-base)] font-medium')}>
          <Plus aria-hidden="true" className="size-4" />
          New comic
        </button>
        <button type="button" className={cn(CONTROL_BTN, FOCUS_RING, PRESS, CONTROL_H, INK, 'inline-flex items-center px-4 text-[length:var(--ds-text-base)] font-medium')}>
          Preview
        </button>
        <button type="button" disabled className={cn(CONTROL_BTN, CONTROL_H, INK, 'inline-flex items-center px-4 text-[length:var(--ds-text-base)] font-medium disabled:cursor-not-allowed disabled:opacity-50')}>
          Publishing…
        </button>
        <button type="button" aria-label="Notifications" className={cn(CONTROL_BTN, FOCUS_RING, PRESS, ICON_BTN, INK)}>
          <Bell aria-hidden="true" className="size-4" />
        </button>
      </div>
      <p className={cn(BODY, MUTED)} aria-live="polite">
        {count === 0 ? 'Nothing created yet.' : `Created ${count} ${count === 1 ? 'comic' : 'comics'} (locally, nothing is saved).`}
      </p>
    </Section>
  );
};

const Fields: React.FC = () => (
  <Section id="fields" title="Fields" description="FIELD alone, FIELD_GROUP around FIELD_EMBEDDED, and a FIELD textarea." icon={<Search className="size-4" />}>
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor="recipes-comic-title" className={cn('text-[length:var(--ds-text-sm)] font-medium', INK)}>
        Comic title
      </label>
      <input id="recipes-comic-title" defaultValue="The Lake at Night" className={cn(FIELD, CONTROL_H, 'w-full min-w-0 px-3 text-[length:var(--ds-text-base)]')} />
    </div>
    <div className={cn(FIELD_GROUP, 'min-w-0 pl-3')}>
      <Search aria-hidden="true" className={cn('size-4 shrink-0', MUTED)} />
      <input type="search" aria-label="Search your comics" placeholder="Search your comics" className={cn(FIELD_EMBEDDED, CONTROL_H, 'pr-3 text-[length:var(--ds-text-base)]', INK)} />
    </div>
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor="recipes-brief" className={cn('text-[length:var(--ds-text-sm)] font-medium', INK)}>
        Brief
      </label>
      <textarea
        id="recipes-brief"
        rows={3}
        defaultValue="Two friends find a lantern under the ice and follow it to a town that only exists at night."
        className={cn(FIELD, 'block w-full min-w-0 resize-y px-3 py-2 text-[length:var(--ds-text-base)] leading-6')}
      />
    </div>
  </Section>
);

const SegmentedDemo: React.FC = () => {
  const [mode, setMode] = useState<(typeof MODES)[number]>('Easy');
  return (
    <Section id="segmented" title="Segmented" description="SEGMENTED_TRACK with SEGMENTED_ACTIVE_FILL on the selected SEGMENTED_ITEM (its ink comes from aria-checked)." icon={<Check className="size-4" />}>
      <div role="radiogroup" aria-label="Editing mode" className={cn(SEGMENTED_TRACK, 'w-full sm:w-auto')}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn(SEGMENTED_ITEM, 'h-8 coarse:h-11', mode === m && SEGMENTED_ACTIVE_FILL)}
          >
            {m}
          </button>
        ))}
      </div>
      <p className={cn(BODY, MUTED)}>{mode === 'Pro' ? 'Pro shows every layer and lettering control.' : mode === 'Auto' ? 'Auto picks for each page.' : 'Easy keeps the essentials.'}</p>
    </Section>
  );
};

const Labels: React.FC = () => (
  <Section id="labels" title="Chips and status" description="CHIP variants, the five STATUS_CHIP states and the TONE_CHIP tones, each with its words." icon={<Bell className="size-4" />}>
    <div className={ROW} data-qa-recipe-row="chips">
      <span className={cn(CHIP, CHIP_VARIANT.outline)}>Webtoon</span>
      <span className={cn(CHIP, CHIP_VARIANT.filled)}>Lake series</span>
      <span className={cn(CHIP, CHIP_VARIANT.dashed)}>No style yet</span>
    </div>
    <ul aria-label="Status" className={cn(ROW, 'm-0 list-none p-0')}>
      {STATES.map(([state, words]) => (
        <li key={state} className={cn(STATUS_CHIP, STATUS_CHIP_TONE[state])} data-status={state}>
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[state])} />
          {words}
        </li>
      ))}
    </ul>
    <ul aria-label="Tones" className={cn(ROW, 'm-0 list-none p-0')}>
      {TONES.map(([tone, words]) => (
        <li key={tone} className={cn(CHIP, TONE_CHIP[tone])} data-tone={tone}>
          {words}
        </li>
      ))}
    </ul>
    <p className={BODY}>
      <span className={TONE_TEXT.danger}>Page 3 failed to draw.</span> <span className={MUTED}>Nothing was charged.</span>
    </p>
  </Section>
);

const Surfaces: React.FC = () => {
  const [toast, setToast] = useState(true);
  return (
    <Section id="surfaces" title="Surfaces" description="PANEL glass, an OVERLAY with MENU_ITEM rows, a TOAST and the INVERSE_SURFACE." icon={<Check className="size-4" />}>
      <div className={cn(PANEL, 'min-w-0 p-4')}>
        <p className={cn('m-0', OVERLINE)}>Panel</p>
        <p className={cn(BODY, INK)}>Glass over the canvas, with a hairline and the soft shadow.</p>
      </div>
      <div className={cn(OVERLAY, 'min-w-0 p-4')} data-qa-recipe-overlay="">
        <h3 className={cn('m-0', DIALOG_TITLE)}>Delete this page?</h3>
        <p className={cn(BODY, 'mt-1', MUTED)}>The overlay step a menu or a dialog uses. This one is drawn in place, not opened.</p>
        <ul aria-label="Page actions" className="m-0 mt-3 flex list-none flex-col p-0">
          {['Duplicate', 'Move to end', 'Delete'].map((label) => (
            <li key={label}>
              <button type="button" className={cn(MENU_ITEM, FOCUS_ITEM, 'coarse:min-h-11 rounded-[var(--ds-radius-sm)]', label === 'Delete' ? TONE_TEXT.danger : INK)}>
                {label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {toast ? (
        <div role="status" className={cn(TOAST, 'min-w-0')}>
          <span aria-hidden="true" className={cn(TOAST_EDGE, STATUS_DOT.healthy)} />
          <Check aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', STATUS_INK.healthy)} />
          <div className="min-w-0 flex-1">
            <p className={cn('m-0', TOAST_TITLE)}>Page 2 is drawn</p>
            <p className={cn('m-0', TOAST_MESSAGE)}>It matches the plan. Open it in the editor to letter it.</p>
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setToast(false)} className={cn(ICON_BTN, FOCUS_RING, RADIUS_CONTROL, 'hover:bg-[var(--ds-hover)]', MUTED)}>
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : (
        <p className={cn(BODY, MUTED)}>The toast was dismissed.</p>
      )}
      <div className={cn(INVERSE_SURFACE, RADIUS_PANEL, 'flex min-w-0 flex-wrap items-center justify-between gap-3 p-4')}>
        <p className="m-0 min-w-0 text-[length:var(--ds-text-base)] font-medium leading-6">Ready to share your comic?</p>
        <button type="button" className={cn(PRIMARY_BTN, FOCUS_RING, PRESS, CONTROL_H, RADIUS_CONTROL, 'inline-flex items-center px-4 text-[length:var(--ds-text-base)] font-medium')}>
          Publish
        </button>
      </div>
    </Section>
  );
};

const NAV = ['Home', 'My comics', 'Gallery', 'Settings'] as const;

const Navigation: React.FC = () => {
  const [current, setCurrent] = useState<(typeof NAV)[number]>('My comics');
  return (
    <Section id="navigation" title="Navigation rows" description="NAV_ROW, with NAV_ROW_ACTIVE on the current page." icon={<Search className="size-4" />}>
      <nav aria-label="Sample navigation">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {NAV.map((item) => (
            <li key={item}>
              <button
                type="button"
                aria-current={current === item ? 'page' : undefined}
                onClick={() => setCurrent(item)}
                className={cn(current === item ? NAV_ROW_ACTIVE : NAV_ROW, FOCUS_RING_FLUSH, 'coarse:min-h-11')}
              >
                {item}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </Section>
  );
};

function RecipesScene() {
  return (
    <main aria-labelledby="recipes-title" className={cn('min-h-[100dvh] min-w-0 px-4 py-6 sm:px-6', CANVAS_BG, INK)}>
      <div className="mx-auto flex max-w-5xl min-w-0 flex-col gap-6">
        <header className="flex min-w-0 flex-col gap-1">
          <p className={cn('m-0', OVERLINE)}>Design recipes</p>
          <h1 id="recipes-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
            The shared recipes, as they render today
          </h1>
          <p className={cn(BODY, MUTED)}>Every block below is composed from components/chat/studioDesign.ts and the theme tokens only: no hues, radii or durations of its own.</p>
        </header>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <Actions />
          <Fields />
          <SegmentedDemo />
          <Labels />
          <Surfaces />
          <Navigation />
        </div>
      </div>
    </main>
  );
}

const scene: QaAppScene = { id: 'recipes', title: 'Shared design recipes (studioDesign)', Scene: RecipesScene };
export default scene;
