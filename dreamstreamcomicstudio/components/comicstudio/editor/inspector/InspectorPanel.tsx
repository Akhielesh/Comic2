// The docked inspector (agent-editor plan §3 C2; master plan §2.4, §2.7): the Pro workspace's Properties tab, in the
// page flow (never floating over the page). With a selection it is the lettering inspector, docked, with the Pro Edit
// controls on (kind row, typed transform and fields, align / distribute, Copy / Paste style, and the Pro lettering
// controls behind PRO_EDIT_OPS_PATCHABLE). With nothing selected it shows the comic's lettering style and the page's
// facts, so the column is never blank. Every edit is free and goes through the shell's `apply` (studio.patch).

import React from 'react';
import type { ComicDoc, Page } from '../../../../shared/comic/doc';
import type { LetterPlan } from '../../../../shared/comic/lettering/layout';
import { aspectRatioOf } from '../../../../shared/comic/models';
import { IN_ART_LETTERING_NOTE } from '../../../../shared/comic/pro/types';
import { languageSpec } from '../../../../shared/comic/languages';
import { LETTERING_PRESETS, type LetteringPresetId } from '../../../../shared/comic/lettering/style';
import { cn } from '../../../../lib/utils';
import { INK, MUTED, OVERLINE, RADIUS_CONTROL } from '../../../chat/studioDesign';
import { LetteringInspector } from '../../lettering/LetteringInspector';
import { PresetGallery } from '../../lettering/PresetGallery';
import { NamedStyles } from '../../lettering/NamedStyles';
import { linesOf, presetOps } from '../../lettering/styleOps';
import { proFieldsWritable, proLooks } from './proGate';
import type { PartPanelProps } from './types';

/** What the empty inspector says (a selection fills it). */
export const INSPECTOR_EMPTY_HINT = 'Select a balloon on the page or in Layers to change its words’ look, position and size. Lettering edits are free — done by the editor, no AI cost.';

/** The page's facts for the empty inspector, in plain words. */
export function pageFacts(doc: ComicDoc, page: Page): { label: string; value: string }[] {
  const lines = page.panels.flatMap((p) => p.lines);
  const spoken = lines.filter((l) => l.text.trim());
  const placed = page.balloons.length;
  const ls = doc.letterStyle;
  const preset = ls ? (LETTERING_PRESETS[ls.presetId as LetteringPresetId]?.name ?? proLooks().find((l) => l.id === ls.presetId)?.name ?? 'Classic') : 'Classic';
  const ratio = doc.format?.pageAspect;
  const facts = [
    { label: 'Page', value: `${page.n} of ${doc.pages.length}` },
    { label: 'Panels', value: String(page.panels.length) },
    { label: 'Lines', value: `${spoken.length}${placed ? ` · ${placed} placed by you` : ''}` },
    { label: 'Language', value: languageSpec(doc.format?.language || 'en')?.english ?? (doc.format?.language || 'en') },
    { label: 'Lettering', value: doc.format?.lettering === 'overlay' ? preset : 'Drawn into the art' }
  ];
  if (ratio && aspectRatioOf(ratio) > 0) facts.push({ label: 'Shape', value: ratio });
  return facts;
}

/** The inspector with nothing selected: the comic's lettering style and the page's facts. */
export const EmptySelection: React.FC<Pick<PartPanelProps, 'doc' | 'page' | 'apply' | 'editionLang'>> = ({ doc, page, apply, editionLang }) => {
  const overlay = doc.format?.lettering === 'overlay';
  return (
    <div className="min-w-0 space-y-4" data-testid="inspector-empty">
      {overlay ? (
        <section aria-label="Lettering style" className="min-w-0 space-y-2">
          <h4 className={cn('m-0', OVERLINE)}>Lettering style</h4>
          <PresetGallery
            pro
            value={doc.letterStyle?.presetId ?? 'classic'}
            lang={editionLang ?? doc.format?.language}
            onChange={(id) => {
              if (!editionLang) apply(presetOps(id), { label: 'Change lettering style' });
            }}
          />
          {editionLang && <p className={cn('m-0 text-[11px] leading-snug', MUTED)}>The lettering style belongs to the original language — switch to it to change the look.</p>}
        </section>
      ) : (
        <p role="note" className={cn('m-0 bg-[var(--ds-well)] px-2 py-1.5 text-[11.5px] leading-snug', RADIUS_CONTROL, INK)}>
          {IN_ART_LETTERING_NOTE}
        </p>
      )}
      <section aria-label="This page" className="min-w-0 space-y-1.5">
        <h4 className={cn('m-0', OVERLINE)}>This page</h4>
        <dl className="m-0 grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
          {pageFacts(doc, page).map((f) => (
            <React.Fragment key={f.label}>
              <dt className={cn('min-w-0 text-[11.5px]', MUTED)}>{f.label}</dt>
              <dd className={cn('m-0 min-w-0 text-[12px] tabular-nums [overflow-wrap:anywhere]', INK)}>{f.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
      {overlay && proFieldsWritable() && <NamedStyles doc={doc} page={page} lines={[]} apply={apply} editionLang={editionLang} />}
      <p className={cn('m-0 text-[11px] leading-snug', MUTED)}>{INSPECTOR_EMPTY_HINT}</p>
    </div>
  );
};

/** The inspector part's panel (the shell mounts it as the docked Properties tab). */
export const InspectorPanel: React.FC<PartPanelProps> = (props) => {
  const { studio, doc, page, plans, placements, H, selection, apply, onEditText, editionLang, mode } = props;
  const ids = linesOf(page, selection.ids).map((l) => l.id);
  if (!ids.length || doc.format?.lettering !== 'overlay') return <EmptySelection doc={doc} page={page} apply={apply} editionLang={editionLang} />;
  return (
    <LetteringInspector
      doc={doc}
      page={page}
      lineIds={ids}
      plans={plans as LetterPlan[]}
      placements={placements}
      H={H}
      apply={apply}
      onEditText={onEditText}
      onDeselect={selection.clear}
      editionLang={editionLang}
      mode={mode === 'easy' ? 'easy' : 'pro'}
      onModeChange={(m) => studio.setMode(m)}
      canPro
      anchor={null}
      compact={false}
      onClose={selection.clear}
      proEdit
      docked
    />
  );
};

export default InspectorPanel;
