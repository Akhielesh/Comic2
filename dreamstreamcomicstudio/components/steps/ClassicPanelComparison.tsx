import React, { useEffect, useId, useMemo, useState } from 'react';
import type { ComicPanel } from '../../types';
import { cn } from '../../lib/utils';
import { getImageUrl } from '../../services/db';
import { IMAGE_TRANSFORMS } from '../../services/projectStorage';
import { REVIEW_GROUP_SIZE, reviewWindow, scanPanelWindow, similarPanelPairs, type PanelThumbnail } from '../../services/classicArtworkComparison';
import { STAGE_BOARD_TITLE, STAGE_BODY, STAGE_CARD, STAGE_WELL } from '../AgentStageShell';
import { FIELD, WRAP_TEXT } from '../chat/studioDesign';
import { Button } from '../ds/Button';

function PanelPair({ panels, first }: { panels: ComicPanel[]; first: number }) {
  const [pair, setPair] = useState({ left: 0, right: 1 });
  const [reads, setReads] = useState<{ source: ComicPanel[]; images: (PanelThumbnail | null | undefined)[] } | null>(null);
  const label = useId();

  useEffect(() => {
    const controller = new AbortController();
    const images = new Array<PanelThumbnail | null | undefined>(panels.length).fill(undefined);
    setReads({ source: panels, images });
    void scanPanelWindow(panels, id => getImageUrl(id, { transform: IMAGE_TRANSFORMS.thumb }), controller.signal, (index, image) => {
      images[index] = image;
      setReads({ source: panels, images: images.slice() });
    });
    return () => controller.abort();
  }, [panels]);

  const images = reads?.source === panels ? reads.images : undefined;
  const finished = images?.filter(img => img !== undefined).length ?? 0;
  const loaded = images?.filter(Boolean).length ?? 0;
  const done = finished === panels.length;
  const matches = useMemo(() => done && images ? similarPanelPairs(images.map(img => img ?? null)) : [], [images, done]);
  const adjacent = (right: number) => setPair({ left: right - 1, right });
  const right = Math.max(1, Math.min(panels.length - 1, pair.right));
  const left = Math.max(0, Math.min(right - 1, pair.left));
  const number = (i: number) => first + i + 1;
  const status = !done ? 'Checking available artwork…'
    : loaded < 2 ? 'At least two readable images are needed to check for repeats.'
    : matches.length ? `${matches.length} possible repeat${matches.length === 1 ? '' : 's'} in this group.`
    : 'No close visual matches in this group.';

  return <div className="mt-4 grid min-w-0 gap-4">
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid min-w-0 gap-1 text-sm" htmlFor={label}>Adjacent panels
        <select id={label} className={cn(FIELD, 'min-h-11 max-w-full px-2')} value={left === right - 1 ? right : ''} onChange={e => adjacent(Number(e.target.value))}>
          {left !== right - 1 && <option value="" disabled>Choose a turn</option>}
          {panels.slice(1).map((_, i) => <option key={i} value={i + 1}>Panels {number(i)} and {number(i + 1)}</option>)}
        </select>
      </label>
      <Button type="button" variant="outline" size="sm" disabled={right <= 1} onClick={() => adjacent(right - 1)}>Previous pair</Button>
      <Button type="button" variant="outline" size="sm" disabled={right >= panels.length - 1} onClick={() => adjacent(right + 1)}>Next pair</Button>
    </div>
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:gap-3" aria-label="Selected artwork comparison" role="group">
      {[left, right].map(index => {
        const panel = panels[index];
        const thumb = images?.[index];
        return <figure key={index} className={cn('m-0 min-w-0 overflow-hidden', STAGE_WELL)}>
          <figcaption className="px-2 py-2 text-sm font-semibold">Panel {number(index)}{panel.title && <span className={cn(WRAP_TEXT, 'block font-normal text-[var(--ds-muted)]')}>{panel.title}</span>}</figcaption>
          {thumb ? <img className="block h-auto max-h-80 w-full overflow-hidden object-contain" src={thumb.url} alt={panel.description || panel.title || `Artwork for panel ${number(index)}`} /> :
            <p className="p-3 text-sm text-[var(--ds-muted)]">{!panel.imageId && !panel.imageUrl ? 'No artwork saved.' : thumb === null ? 'Preview unavailable.' : 'Loading preview…'}</p>}
        </figure>;
      })}
    </div>
    <p className={STAGE_BODY} role="status">{status}{done && loaded < panels.length && ` ${loaded} of ${panels.length} panels were readable.`}</p>
    {matches.length > 0 && <label className="grid max-w-fit gap-1 text-sm">Possible repeats
      <select className={cn(FIELD, 'min-h-11 max-w-full px-2')} value={matches.slice(0, 12).findIndex(match => match.left === left && match.right === right)}
        onChange={event => { const match = matches[Number(event.target.value)]; if (match) setPair({ left: match.left, right: match.right }); }}>
        <option value={-1} disabled>Inspect a pair</option>
        {matches.slice(0, 12).map((match, i) => <option key={i} value={i}>Panels {number(match.left)} and {number(match.right)}</option>)}
      </select>
      <span className={STAGE_BODY}>{matches.length > 12 ? 'Showing the 12 closest pairs. ' : ''}A repeated shot may be intentional.</span>
    </label>}
  </div>;
}

export function ClassicPanelComparison({ panels }: { panels: ComicPanel[] }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(0);
  const contentId = useId();
  const groups = Math.ceil(panels.length / REVIEW_GROUP_SIZE);
  const active = Math.min(group, Math.max(0, groups - 1));
  const scoped = useMemo(() => reviewWindow(panels, active), [panels, active]);
  if (panels.filter(p => p.imageId || p.imageUrl).length < 2) return null;

  return <section className={cn('min-w-0 p-4', STAGE_CARD)} aria-labelledby={`${contentId}-title`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 id={`${contentId}-title`} className={STAGE_BOARD_TITLE}>Panel artwork</h3>
        <p className={cn('mt-1', STAGE_BODY)}>Compare finished panels side by side. This device checks the composition and color for repeated shots.</p>
      </div>
      <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}>
        {open ? 'Close comparison' : 'Compare artwork'}
      </Button>
    </div>
    <div id={contentId} hidden={!open}>
      {open && <>
        {groups > 1 && <label className="mt-3 grid max-w-fit gap-1 text-sm">Panel group
          <select className={cn(FIELD, 'min-h-11 px-2')} value={active} onChange={event => setGroup(Number(event.target.value))}>
            {Array.from({ length: groups }, (_, i) => <option key={i} value={i}>
              Panels {i === 0 ? 1 : i * REVIEW_GROUP_SIZE}–{Math.min((i + 1) * REVIEW_GROUP_SIZE, panels.length)}
            </option>)}
          </select>
        </label>}
        <PanelPair key={active} panels={scoped.panels} first={scoped.first} />
      </>}
    </div>
  </section>;
}
