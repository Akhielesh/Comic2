import React, { useState } from 'react';
import { Pencil } from 'lucide-react';
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
  const character = doc?.cast.find((entry) => entry.id === characterId);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [tab, setTab] = useState('portrait');
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
    requestAnimationFrame(() => document.getElementById(characterCardId(characterId))?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus());
  };
  return (
    <TimelineDialog open onClose={onClose} title={character?.name || 'Character'} wide
      footer={character && <GhostButton size="sm" onClick={edit}><Pencil className="h-3.5 w-3.5" aria-hidden /> Edit character</GhostButton>}>
      {!character ? <p className="text-sm text-[var(--ds-muted)]">This character is no longer in the comic.</p> : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList label="Character view" fullWidth>
            <TabsTrigger value="portrait" className="min-w-0 flex-1 px-2 text-[12px]">Portrait & details</TabsTrigger>
            <TabsTrigger value="versions" className="min-w-0 flex-1 px-2 text-[12px]">Saved sheets ({versions})</TabsTrigger>
          </TabsList>
          <TabsContent value="portrait" className="pt-3">
            <div className="grid min-w-0 items-start gap-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="min-w-0 space-y-3">
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
          <TabsContent value="versions" className="pt-3"><VersionStack studio={studio} target={{ kind: 'sheet', id: character.id }} /></TabsContent>
        </Tabs>
      )}
    </TimelineDialog>
  );
}
