// Cast: every character as a card — the model sheet (the identity anchor every page is
// drawn from) or an initials placeholder, its honest status, name/role/tier and the full
// look editor (each field feeds the sheet and page prompts verbatim). Re-roll a sheet,
// restore an older one, manage the author's reference photos. Places get the same
// treatment: a look editor and an optional location sheet.

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, MapPin, Plus, Sparkles, Trash2, Users, X } from 'lucide-react';
import { newId, type Character, type CharacterLook, type ComicDoc, type Place } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import type { StudioController } from '../types';
import { ImageFrame, VersionStrip } from './ImageFrame';
import { byokFromDoc, estimateOne, hasImage, initials, isBusy, jobModel, nameHue, plural, renderModelNickname, sheetVisualStatus } from './boardModel';
import { ConfirmStrip, EmptyHint, GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, SectionTitle, Segmented, StatusChip, Surface, cx, useClickGuard } from './ui';

const LOOK_FIELDS: { key: Exclude<keyof CharacterLook, 'summary'>; label: string; placeholder: string }[] = [
  { key: 'age', label: 'Age', placeholder: 'e.g. 19' },
  { key: 'gender', label: 'Gender', placeholder: 'e.g. woman' },
  { key: 'build', label: 'Build', placeholder: 'e.g. wiry, 5′4″' },
  { key: 'face', label: 'Face', placeholder: 'e.g. sharp jaw, freckles' },
  { key: 'hair', label: 'Hair', placeholder: 'e.g. long black braid' },
  { key: 'eyes', label: 'Eyes', placeholder: 'e.g. dark brown, hooded' },
  { key: 'skin', label: 'Skin', placeholder: 'e.g. warm brown' },
  { key: 'outfit', label: 'Outfit', placeholder: 'e.g. mustard kurta, jeans' },
  { key: 'palette', label: 'Colors', placeholder: 'e.g. mustard, indigo' },
  { key: 'props', label: 'Props', placeholder: 'e.g. canvas satchel' },
  { key: 'marks', label: 'Distinguishing marks', placeholder: 'Never drift: scar over left eyebrow' }
];

const SHEET_ASPECT = '3 / 2';

const GRID = 'grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]';

const InitialsPlaceholder: React.FC<{ name: string; note?: string }> = ({ name, note }) => {
  const hue = nameHue(name);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <span
        className="grid h-14 w-14 place-items-center rounded-full text-[18px] font-semibold text-white shadow-sm"
        style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 55%), hsl(${(hue + 40) % 360} 55% 42%))` }}
        aria-hidden
      >
        {initials(name)}
      </span>
      {note && <span className="px-4 text-center text-[11.5px] text-[var(--ds-muted)]">{note}</span>}
    </div>
  );
};

/** Author reference images with remove. */
const RefStrip: React.FC<{ studio: StudioController; refs: Character['refs']; onRemove: (path: string) => void; label: string }> = ({ studio, refs, onRemove, label }) => {
  if (!refs.length) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-[var(--ds-muted)]">{label}</p>
      <ul className="flex flex-wrap gap-1.5">
        {refs.map((ref) => {
          const url = studio.urlFor(ref);
          return (
            <li key={ref.path} className="group relative h-12 w-12 overflow-hidden rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)]">
              {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
              <button
                type="button"
                aria-label="Remove reference"
                onClick={() => onRemove(ref.path)}
                className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const CharacterCard: React.FC<{ studio: StudioController; doc: ComicDoc; character: Character; byok: boolean }> = ({ studio, doc, character: c, byok }) => {
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { busyKey, fire } = useClickGuard();
  const status = sheetVisualStatus(c.sheet);
  const drawn = hasImage(c.sheet);
  const url = studio.urlFor(c.sheet.asset);
  const busy = isBusy(c.sheet);
  const price = estimateOne(doc, 'sheet', byok).usd;
  const spec = jobModel(doc, 'sheet');
  const set = (patch: Partial<Character>) => void studio.patch([{ op: 'character', id: c.id, patch }]);
  const setLook = (key: keyof CharacterLook, value: string) => set({ look: { [key]: value } as unknown as CharacterLook });
  const renderSheet = () => fire('sheet', () => studio.act({ type: 'render_sheets', characterIds: [c.id], force: true }));
  const appearances = doc.pages.reduce((n, p) => n + p.panels.filter((panel) => panel.castIds.includes(c.id)).length, 0);

  return (
    <Surface as="article" aria-label={c.name} data-testid="character-card" className="flex flex-col gap-2.5 p-3">
      <ImageFrame
        url={url}
        aspect={SHEET_ASPECT}
        alt={`${c.name} model sheet`}
        render={c.sheet}
        tone="paper"
        placeholder={
          <InitialsPlaceholder
            name={c.name}
            note={c.tier === 'extra' ? 'Extras are described in words only — no sheet needed.' : 'The model sheet keeps them on-model on every page.'}
          />
        }
        overlay={
          <RenderOverlay
            status={status === 'planned' ? 'planned' : status}
            since={c.sheet.updatedAt}
            model={renderModelNickname(doc, busy ? undefined : c.sheet, 'sheet')}
            typicalSec={spec.latencySec}
            error={c.sheet.error}
            onRetry={renderSheet}
            overImage={drawn && !!url}
            staleLabel="Look changed — re-render"
            onRerender={renderSheet}
            compact
          />
        }
      />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <InlineField label="Name" value={c.name} allowEmpty={false} onCommit={(name) => set({ name })} inputClassName="text-[15px] font-semibold" maxLength={80} />
          <InlineField label="Role" value={c.role || ''} placeholder="Role in the story" onCommit={(role) => set({ role })} inputClassName="text-[12.5px] text-[var(--ds-muted)]" />
        </div>
        {status !== 'planned' && <StatusChip status={status} className="mt-1.5" />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={`${c.name} tier`}
          size="xs"
          value={c.tier}
          onChange={(tier) => set({ tier })}
          options={[
            { value: 'lead', label: 'Lead', title: 'Gets a model sheet; first pick for references' },
            { value: 'support', label: 'Support', title: 'Gets a model sheet' },
            { value: 'extra', label: 'Extra', title: 'Described in words only' }
          ]}
        />
        <span className="text-[11px] text-[var(--ds-muted)]">{appearances ? `in ${plural(appearances, 'panel')}` : 'not on any page yet'}</span>
      </div>
      <InlineField
        label="Look summary"
        showLabel
        multiline
        value={c.look.summary || ''}
        placeholder="One dense visual sentence an artist could draw from"
        onCommit={(v) => setLook('summary', v)}
      />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 self-start rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        {expanded ? 'Hide look details' : 'Look details, personality & voice'}
      </button>
      {expanded && (
        <div className="space-y-1 rounded-xl bg-[var(--ds-well)] p-1.5">
          <div className="grid gap-x-1 gap-y-0.5 sm:grid-cols-2">
            {LOOK_FIELDS.map((f) => (
              <InlineField
                key={f.key}
                label={f.label}
                showLabel
                value={c.look[f.key] || ''}
                placeholder={f.placeholder}
                onCommit={(v) => setLook(f.key, v)}
                className={f.key === 'marks' || f.key === 'outfit' ? 'sm:col-span-2' : undefined}
              />
            ))}
          </div>
          <InlineField label="Personality" showLabel multiline value={c.personality || ''} placeholder="How they act" onCommit={(personality) => set({ personality })} />
          <InlineField label="Voice" showLabel multiline value={c.voice || ''} placeholder="How they talk (feeds dialogue)" onCommit={(voice) => set({ voice })} />
          <p className="px-2 pb-1 text-[11px] leading-snug text-[var(--ds-muted)]">Changing the look marks the sheet and their pages out of date — nothing is redrawn until you ask.</p>
        </div>
      )}
      <RefStrip studio={studio} refs={c.refs} label="Your reference images" onRemove={(path) => set({ refs: c.refs.filter((r) => r.path !== path) })} />
      <VersionStrip render={c.sheet} aspect={SHEET_ASPECT} urlFor={(p) => studio.urlFor(p)} disabled={busy} onRestore={(path) => void studio.act({ type: 'restore_render', target: { kind: 'sheet', id: c.id }, path })} />
      {confirmRemove ? (
        <ConfirmStrip
          message={`Remove ${c.name}? They’ll be taken out of every panel they appear in.`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmRemove(false);
            void studio.patch([{ op: 'character_remove', id: c.id }]);
          }}
          onCancel={() => setConfirmRemove(false)}
          cancelLabel="Keep"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {drawn ? (
            <GhostButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet}>
              <Sparkles className="h-3 w-3" aria-hidden /> Re-roll sheet <span className="text-[var(--ds-muted)]">≈ {formatUsd(price)}</span>
            </GhostButton>
          ) : (
            <PrimaryButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet}>
              <Sparkles className="h-3 w-3" aria-hidden /> Render sheet <span className="font-normal opacity-85">≈ {formatUsd(price)}</span>
            </PrimaryButton>
          )}
          <IconButton size="sm" label={`Remove ${c.name}`} className="ml-auto" onClick={() => setConfirmRemove(true)}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </Surface>
  );
};

export const PlaceCard: React.FC<{ studio: StudioController; doc: ComicDoc; place: Place; byok: boolean }> = ({ studio, doc, place: p, byok }) => {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { busyKey, fire } = useClickGuard();
  const drawn = hasImage(p.sheet);
  const busy = isBusy(p.sheet);
  const status = sheetVisualStatus(p.sheet);
  const url = studio.urlFor(p.sheet.asset);
  const price = estimateOne(doc, 'place', byok).usd;
  const set = (patch: Partial<Place>) => void studio.patch([{ op: 'place', id: p.id, patch }]);
  const renderSheet = () => fire('sheet', () => studio.act({ type: 'render_sheets', characterIds: [p.id], force: true }));
  const used = doc.pages.reduce((n, page) => n + page.panels.filter((panel) => panel.placeId === p.id).length, 0);
  const showFrame = drawn || busy || status === 'failed';

  return (
    <Surface as="article" aria-label={p.name} data-testid="place-card" className="flex flex-col gap-2 p-3">
      {showFrame && (
        <ImageFrame
          url={url}
          aspect={SHEET_ASPECT}
          alt={`${p.name} location sheet`}
          render={p.sheet}
          overlay={
            <RenderOverlay
              status={status}
              since={p.sheet.updatedAt}
              model={jobModel(doc, 'place').nickname}
              error={p.sheet.error}
              onRetry={renderSheet}
              overImage={drawn && !!url}
              staleLabel="Look changed — re-render"
              compact
            />
          }
        />
      )}
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <InlineField label="Place name" value={p.name} allowEmpty={false} onCommit={(name) => set({ name })} inputClassName="text-[14px] font-semibold" className="flex-1" />
        <span className="shrink-0 text-[11px] text-[var(--ds-muted)]">{used ? `in ${plural(used, 'panel')}` : 'unused'}</span>
      </div>
      <InlineField label="Look" showLabel multiline value={p.look} placeholder="Architecture, props, light, palette" onCommit={(look) => set({ look })} />
      <RefStrip studio={studio} refs={p.refs} label="Your reference images" onRemove={(path) => set({ refs: p.refs.filter((r) => r.path !== path) })} />
      {confirmRemove ? (
        <ConfirmStrip
          message={`Remove ${p.name}? Panels set there will have no location.`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmRemove(false);
            void studio.patch([{ op: 'place_remove', id: p.id }]);
          }}
          onCancel={() => setConfirmRemove(false)}
          cancelLabel="Keep"
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <GhostButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet} title="An optional reference image of this place, used on pages set there">
            <Sparkles className="h-3 w-3" aria-hidden /> {drawn ? 'Re-roll location sheet' : 'Render location sheet'}{' '}
            <span className="text-[var(--ds-muted)]">≈ {formatUsd(price)}</span>
          </GhostButton>
          <IconButton size="sm" label={`Remove ${p.name}`} className="ml-auto" onClick={() => setConfirmRemove(true)}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </Surface>
  );
};

export const CastTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const byok = byokFromDoc(doc);
  const { busyKey, fire } = useClickGuard(3000);
  const tierOrder = { lead: 0, support: 1, extra: 2 } as const;
  const cast = [...doc.cast].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
  const missing = doc.cast.filter((c) => c.tier !== 'extra' && c.sheet.status !== 'ready' && !isBusy(c.sheet));
  const missingPrice = estimateOne(doc, 'sheet', byok, missing.length).usd;
  const addCharacter = () =>
    void studio.patch([{ op: 'character', id: newId('ch'), patch: { name: `New character ${doc.cast.length + 1}`, tier: 'support', look: { summary: '' } } }]);
  const addPlace = () => void studio.patch([{ op: 'place', id: newId('pl'), patch: { name: `New place ${doc.places.length + 1}`, look: '' } }]);

  return (
    <div className="space-y-6 p-4 sm:p-5">
      <section aria-labelledby="cast-title">
        <SectionTitle
          id="cast-title"
          icon={<Users className="h-3.5 w-3.5" />}
          right={
            <>
              {missing.length > 0 && (
                <PrimaryButton
                  size="xs"
                  busy={busyKey === 'all'}
                  onClick={() => fire('all', () => studio.act({ type: 'render_sheets', characterIds: missing.map((c) => c.id) }))}
                >
                  <Sparkles className="h-3 w-3" aria-hidden /> Render {plural(missing.length, 'sheet')} <span className="font-normal opacity-85">≈ {formatUsd(missingPrice)}</span>
                </PrimaryButton>
              )}
              <GhostButton size="xs" onClick={addCharacter}>
                <Plus className="h-3 w-3" aria-hidden /> Add
              </GhostButton>
            </>
          }
        >
          Cast · {doc.cast.length}
        </SectionTitle>
        {cast.length ? (
          <div className={GRID}>
            {cast.map((c) => (
              <CharacterCard key={c.id} studio={studio} doc={doc} character={c} byok={byok} />
            ))}
          </div>
        ) : (
          <EmptyHint icon={<Users className="h-7 w-7" />} title="No characters yet">
            Describe your characters in the chat — or add photos of real people or drawings — and each gets a card here with a model sheet that keeps
            them looking the same on every page.
          </EmptyHint>
        )}
      </section>

      <section aria-labelledby="places-title">
        <SectionTitle
          id="places-title"
          icon={<MapPin className="h-3.5 w-3.5" />}
          right={
            <GhostButton size="xs" onClick={addPlace}>
              <Plus className="h-3 w-3" aria-hidden /> Add
            </GhostButton>
          }
        >
          Places · {doc.places.length}
        </SectionTitle>
        {doc.places.length ? (
          <div className={cx(GRID)}>
            {doc.places.map((p) => (
              <PlaceCard key={p.id} studio={studio} doc={doc} place={p} byok={byok} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-[var(--ds-hairline)] px-4 py-5 text-center text-[12.5px] text-[var(--ds-muted)]">
            Recurring locations land here, so the market looks like the same market on every page.
          </p>
        )}
      </section>
    </div>
  );
};
