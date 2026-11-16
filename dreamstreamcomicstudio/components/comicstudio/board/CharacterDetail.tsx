import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { IconButton } from '../../ds/IconButton';
import { prefersReducedMotion } from '../../ds/useReducedMotion';
import type { AssetRef, CharacterLook } from '../../../shared/comic/doc';
import { versionList } from '../../../shared/comic/book';
import { effectiveRating } from '../../../shared/comic/safety';
import type { StudioController } from '../types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs';
import { castRoleLabel, KIND_NAME, kindOf } from '../conversation/cards/castVisual';
import { VersionStack } from '../timeline/VersionStack';
import { TimelineDialog } from '../timeline/ui';
import { ImageFrame, frameSources, VIEW_MAX_W } from './ImageFrame';
import { GhostButton } from './ui';

const LOOK_LABELS: Partial<Record<keyof CharacterLook, string>> = {
  species: 'Species', age: 'Age', gender: 'Gender', build: 'Build', face: 'Face', hair: 'Hair', eyes: 'Eyes',
  skin: 'Skin', outfit: 'Outfit', palette: 'Colors', props: 'Props', markings: 'Markings', marks: 'Distinguishing marks'
};

export const characterCardId = (id: string) => `cast-character-${id}`;

/** Read a character at portrait size; changing a saved sheet still uses the existing version/undo flow. */
export function CharacterDetail({ studio, characterId, onClose }: { studio: StudioController; characterId: string; onClose: () => void }) {
  const doc = studio.doc;
  const [activeId, setActiveId] = useState(characterId);
  const [views, setViews] = useState<Record<string, { path?: string; tab?: string }>>({});
  const castStrip = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; pointer: number } | null>(null);
  useEffect(() => { setActiveId(characterId); }, [characterId]);
  const cast = doc?.cast ?? [];
  const index = cast.findIndex((entry) => entry.id === activeId);
  const character = cast[index];
  const selectedPath = views[activeId]?.path;
  const tab = views[activeId]?.tab ?? 'portrait';
  const setSelectedPath = (path: string) => setViews(previous => ({ ...previous, [activeId]: { ...previous[activeId], path } }));
  const setTab = (value: string) => setViews(previous => ({ ...previous, [activeId]: { ...previous[activeId], tab: value } }));
  const browse = (next: number, focus = false) => {
    const entry = cast[next];
    if (!entry) return;
    setActiveId(entry.id);
    const button = castStrip.current?.querySelectorAll<HTMLButtonElement>('button')[next];
    button?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (focus) button?.focus({ preventScroll: true });
  };
  const choices: { label: string; asset: AssetRef }[] = character ? [
    ...(character.sheet.asset ? [{ label: 'Model sheet', asset: character.sheet.asset }] : []),
    ...character.refs.map((asset, index) => ({ label: `Reference photo ${index + 1}`, asset }))
  ].filter((choice, index, all) => all.findIndex(({ asset }) => asset.path === choice.asset.path) === index) : [];
  const selected = choices.find(({ asset }) => asset.path === selectedPath) ?? choices[0];
  const sources = frameSources(studio.urlFor, selected?.asset, { maxW: VIEW_MAX_W, sizes: '(max-width: 640px) 90vw, 560px' });
  const versions = doc && character ? versionList(doc, { kind: 'sheet', id: character.id }).length : 0;
  const rating = doc ? effectiveRating(doc, studio.caps?.ratingCeiling).rating : 'PG';
  const edit = () => {
    onClose();
    studio.setTab('cast');
    requestAnimationFrame(() => document.getElementById(characterCardId(activeId))?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus());
  };
  return (
    <TimelineDialog open onClose={onClose} title={character?.name || 'Character'} wide
      footer={character && <div className="flex flex-wrap items-center justify-between gap-2">
        {cast.length > 1 && <div role="group" aria-label="Browse cast" className="flex items-center gap-2">
          <IconButton label="Previous character" variant="outline" disabled={index <= 0} onClick={() => browse(index - 1)}><ChevronLeft /></IconButton>
          <span role="status" aria-live="polite" className="text-[12px] tabular-nums text-[var(--ds-muted)]"><span aria-hidden>{index + 1} / {cast.length}</span><span className="sr-only">{character.name}, character {index + 1} of {cast.length}</span></span>
          <IconButton label="Next character" variant="outline" disabled={index === cast.length - 1} onClick={() => browse(index + 1)}><ChevronRight /></IconButton>
        </div>}
        <GhostButton size="sm" onClick={edit}><Pencil className="h-3.5 w-3.5" aria-hidden /> Edit character</GhostButton>
      </div>}>
      {!character ? <p className="text-sm text-[var(--ds-muted)]">This character is no longer in the comic.</p> : (
        <>
        {cast.length > 1 && <div ref={castStrip} role="group" aria-label="Characters" className="mb-3 flex gap-2 overflow-x-auto overscroll-x-contain pb-2"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            browse(event.key === 'Home' ? 0 : event.key === 'End' ? cast.length - 1 : Math.max(0, Math.min(cast.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), true);
          }}>
          {cast.map((entry, at) => <GhostButton key={entry.id} size="sm" aria-current={entry.id === activeId ? 'true' : undefined}
            onClick={() => browse(at)} className={`shrink-0 ${entry.id === activeId ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : ''}`}>{entry.name}</GhostButton>)}
        </div>}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList label="Character view" fullWidth>
            <TabsTrigger value="portrait" className="min-w-0 flex-1 px-2 text-[12px]">Portrait & details</TabsTrigger>
            <TabsTrigger value="versions" className="min-w-0 flex-1 px-2 text-[12px]">Saved sheets ({versions})</TabsTrigger>
          </TabsList>
          <TabsContent value="portrait" className="pt-3">
            <div className="grid min-w-0 items-start gap-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="min-w-0 space-y-3 [touch-action:pan-y_pinch-zoom]"
                onPointerDown={(event) => {
                  if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest('button')) return;
                  gesture.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerUp={(event) => {
                  const start = gesture.current;
                  gesture.current = null;
                  if (!start || start.pointer !== event.pointerId) return;
                  const dx = event.clientX - start.x, dy = event.clientY - start.y;
                  if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) browse(index + (dx < 0 ? 1 : -1));
                }}
                onPointerCancel={() => { gesture.current = null; }}>
                {cast.length > 1 && <p className="sr-only">Swipe horizontally on the portrait, or use the previous and next character buttons to browse the cast.</p>}
                {selected ? <ImageFrame {...sources} asset={selected.asset} aspect={selected.asset.w && selected.asset.h ? selected.asset.w / selected.asset.h : '3 / 2'}
                  alt={`${character.name} — ${selected.label.toLowerCase()}`} tone="paper" className="max-h-[60dvh] overflow-hidden"
                  placeholder={<div className="grid h-full place-items-center p-4 text-sm text-[var(--ds-muted)]">Portrait unavailable. Your character details are still here.</div>}
                  safety={{ rating, onChangeRating: () => { onClose(); studio.setTab('story'); } }} />
                  : <div className="grid min-h-40 place-items-center rounded-xl bg-[var(--ds-well)] p-6 text-center text-sm text-[var(--ds-muted)]">No portrait yet. Character details are saved below.</div>}
                {choices.length > 1 && <div role="group" aria-label="Portrait source" className="flex flex-wrap gap-2">
                  {choices.map(({ label, asset }) => <GhostButton key={asset.path} size="xs" aria-pressed={selected?.asset.path === asset.path}
                    onClick={() => setSelectedPath(asset.path)} className={selected?.asset.path === asset.path ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : undefined}>{label}</GhostButton>)}
                </div>}
                {selected?.label === 'Model sheet' && character.sheet.status === 'stale' && <p className="text-[12px] text-[var(--ds-muted)]">This sheet predates the latest character details.</p>}
              </div>
              <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
                <p className="text-[12px] font-medium text-[var(--ds-muted)]">{castRoleLabel(character)} · {KIND_NAME[kindOf(character)]}{character.count && character.count > 1 ? ` · Group of ${character.count}` : ''}</p>
                {character.role && <p data-user-content className="text-[14px] font-medium text-[var(--ds-ink)]">{character.role}</p>}
                {character.look.summary && <p data-user-content className="text-[14px] leading-relaxed text-[var(--ds-ink)]">{character.look.summary}</p>}
                <dl className="grid gap-3 text-[13px]">
                  {Object.entries(LOOK_LABELS).flatMap(([key, label]) => {
                    const value = character.look[key as keyof CharacterLook];
                    return value ? [<div key={key}><dt className="font-medium text-[var(--ds-muted)]">{label}</dt><dd data-user-content className="mt-0.5 whitespace-pre-wrap text-[var(--ds-ink)]">{value}</dd></div>] : [];
                  })}
                  {character.personality && <div><dt className="font-medium text-[var(--ds-muted)]">Personality</dt><dd data-user-content className="mt-0.5 whitespace-pre-wrap text-[var(--ds-ink)]">{character.personality}</dd></div>}
                  {character.voice && <div><dt className="font-medium text-[var(--ds-muted)]">Voice</dt><dd data-user-content className="mt-0.5 whitespace-pre-wrap text-[var(--ds-ink)]">{character.voice}</dd></div>}
                </dl>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="versions" className="pt-3"><VersionStack key={character.id} studio={studio} target={{ kind: 'sheet', id: character.id }} /></TabsContent>
        </Tabs>
        </>
      )}
    </TimelineDialog>
  );
}
