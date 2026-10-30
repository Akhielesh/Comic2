// Cast: every character as a card — the model sheet (the identity anchor every page is
// drawn from) or an initials placeholder, its honest status, name/role/tier and the full
// look editor (each field feeds the sheet and page prompts verbatim). Re-roll a sheet,
// pick an older one (free), manage the author's reference photos. Places get the same
// treatment: a look editor and an optional location sheet.
//
// Wave 2 (P2-BOARD):
//   • non-human cast is first class: a kind icon, "Companion" for recurring non-humans, "×3" for a
//     group drawn as one identity ("three Ducklings"), species and markings in the look details;
//   • photos: the shared <RefStrip> (always an "Add photos" tile, the drawer on tap, drag/paste upload,
//     every refusal shown) replaces the hover-only strip and its whole-array `refs` patches;
//   • "Drawn from older photos": a soft hint (never a stale mark, never an automatic redraw) when the
//     sheet was drawn before today's photo pick, with the redraw price for THIS user;
//   • sheet versions open the shared VersionStack (v1 = oldest; free swap with undo; a swap that would
//     put drawn pages out of date asks first and lists them);
//   • calm failed sheets, the content-check veil, ≤ 480w thumbnails, 44 px controls, no hover-only UI.
//
// Gate (L15): what a character IS (person, animal, robot…), how many are drawn as one group (×2–×12) and how
// pages use their photo (likeness) are editable in the look details. Every change is an undoable `character`
// op; going back to the default (person / just one / automatic) CLEARS the key (null), so the doc and every
// page's spec hash read exactly as if it had never been set.

import React, { useId, useState } from 'react';
import { Bot, Box, Car, ChevronDown, ChevronUp, Ghost, MapPin, PawPrint, Plus, Sparkles, ToyBrick, Trash2, User, Users } from 'lucide-react';
import { CAST_KINDS, castKindOf, castNoun, isCompanion, newId, type CastKind, type Character, type CharacterLook, type ComicDoc, type Place } from '../../../shared/comic/doc';
import { effectiveRating, type ContentRating } from '../../../shared/comic/safety';
import type { StudioController } from '../types';
import { RefStrip } from '../refs/RefStrip';
import { sheetHint } from '../refs/refsModel';
import { EmptyIllustration, FrameBadge, ImageFrame, VersionsButton, frameSources } from './ImageFrame';
import { CLEAR, byokFromDoc, estimateOne, hasImage, initials, isBusy, jobModel, nameHue, plural, renderModelNickname, sheetVisualStatus } from './boardModel';
import { useCostFormat, type CostFormat } from './costFormat';
import { ConfirmStrip, EmptyHint, GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, SectionTitle, Segmented, StatusChip, Surface, cx, useClickGuard } from './ui';

type LookKey = Exclude<keyof CharacterLook, 'summary'>;

const LOOK_FIELDS: { key: LookKey; label: string; placeholder: string; nonHuman?: boolean; wide?: boolean }[] = [
  { key: 'species', label: 'Species', placeholder: 'e.g. mallard duckling', nonHuman: true, wide: true },
  { key: 'age', label: 'Age', placeholder: 'e.g. 19' },
  { key: 'gender', label: 'Gender', placeholder: 'e.g. woman' },
  { key: 'build', label: 'Build', placeholder: 'e.g. wiry, 5′4″' },
  { key: 'face', label: 'Face', placeholder: 'e.g. sharp jaw, freckles' },
  { key: 'hair', label: 'Hair', placeholder: 'e.g. long black braid' },
  { key: 'eyes', label: 'Eyes', placeholder: 'e.g. dark brown, hooded' },
  { key: 'skin', label: 'Skin', placeholder: 'e.g. warm brown' },
  { key: 'outfit', label: 'Outfit', placeholder: 'e.g. mustard kurta, jeans', wide: true },
  { key: 'palette', label: 'Colors', placeholder: 'e.g. mustard, indigo' },
  { key: 'props', label: 'Props', placeholder: 'e.g. canvas satchel' },
  { key: 'markings', label: 'Markings', placeholder: 'Never drift: white blaze on the chest', nonHuman: true, wide: true },
  { key: 'marks', label: 'Distinguishing marks', placeholder: 'Never drift: scar over left eyebrow', wide: true }
];

export const KIND_ICON: Record<CastKind, React.ComponentType<{ className?: string }>> = {
  person: User,
  animal: PawPrint,
  creature: Ghost,
  robot: Bot,
  toy: ToyBrick,
  vehicle: Car,
  object: Box
};

export const KIND_TEXT: Record<CastKind, string> = {
  person: 'Person',
  animal: 'Animal',
  creature: 'Creature',
  robot: 'Robot',
  toy: 'Toy',
  vehicle: 'Vehicle',
  object: 'Object'
};

const SHEET_ASPECT = '3 / 2';

const GRID = 'grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]';

/** Largest group drawn as one identity (the server's cap; castNoun spells out two–twelve). */
export const CAST_GROUP_MAX = 12;

const LIKENESS: { value: NonNullable<Character['likeness']>; label: string }[] = [
  { value: 'auto', label: 'Automatic — sheet, plus the main photo when there’s room' },
  { value: 'sheet_only', label: 'Model sheet only' },
  { value: 'sheet_and_photo', label: 'Sheet and main photo on every page' }
];

const groupLabel = (n: number) => (n <= 1 ? 'Just one' : `A group of ${n}`);

const SELECT =
  'h-8 w-full min-w-0 truncate rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 text-[12.5px] text-[var(--ds-ink)] focus:border-[#D97757]/50 focus:outline-none coarse:h-11';

/** A labelled native select (the platform picker on phones; 44 px on touch), laid out like an InlineField. */
const DetailSelect = <T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  className
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
  className?: string;
}) => {
  const id = useId();
  return (
    <div className={cx('min-w-0 px-0.5 py-0.5', className)}>
      <label htmlFor={id} className="mb-0.5 block px-1.5 text-[11px] font-medium text-[var(--ds-muted)]">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={SELECT} aria-describedby={hint ? `${id}-hint` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="mt-0.5 px-1.5 text-[11px] leading-snug text-[var(--ds-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
};

/**
 * The cast details a person can change (kind, group size, photo likeness) as `character` patches. Choosing the
 * default (person / just one / automatic) clears the key (null) instead of storing it; choosing what is
 * already there sends nothing.
 */
export const castDetailPatch = (c: Character, field: 'kind' | 'count' | 'likeness', raw: string): Partial<Character> | null => {
  if (field === 'kind') {
    const kind = (CAST_KINDS as readonly string[]).includes(raw) ? (raw as CastKind) : null;
    if (!kind || kind === castKindOf(c)) return null;
    return { kind: kind === 'person' ? CLEAR : kind };
  }
  if (field === 'count') {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > CAST_GROUP_MAX) return null;
    const current = typeof c.count === 'number' && c.count > 1 ? Math.floor(c.count) : 1;
    if (n === current) return null;
    return { count: n === 1 ? CLEAR : n };
  }
  const likeness = LIKENESS.find((l) => l.value === raw)?.value;
  if (!likeness || likeness === (c.likeness ?? 'auto')) return null;
  return { likeness: likeness === 'auto' ? CLEAR : likeness };
};

const InitialsPlaceholder: React.FC<{ name: string; note?: string; kind: CastKind }> = ({ name, note, kind }) => {
  const hue = nameHue(name);
  const Icon = KIND_ICON[kind];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <span
        className="grid h-14 w-14 place-items-center rounded-full text-[18px] font-semibold text-white shadow-sm"
        style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 55%), hsl(${(hue + 40) % 360} 55% 42%))` }}
        aria-hidden
      >
        {kind === 'person' ? initials(name) : <Icon className="h-6 w-6" />}
      </span>
      {note && <span className="px-4 text-center text-[11.5px] text-[var(--ds-muted)]">{note}</span>}
    </div>
  );
};

/** Kind, companion and group size at a glance ("🐾 Animal · Companion · ×3"). */
export const CastKindLine: React.FC<{ character: Character }> = ({ character: c }) => {
  const kind = castKindOf(c);
  const count = typeof c.count === 'number' && c.count > 1 ? Math.floor(c.count) : 1;
  if (kind === 'person' && count === 1) return null;
  const Icon = KIND_ICON[kind];
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2 text-[11.5px] text-[var(--ds-muted)]" data-testid="cast-kind">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{KIND_TEXT[kind]}</span>
      {isCompanion(c) && (
        <span className="rounded-full bg-[#D97757]/10 px-1.5 py-px text-[10.5px] font-semibold text-[var(--ds-ink)]" title="A recurring non-human character with its own model sheet">
          Companion
        </span>
      )}
      {count > 1 && (
        <span className="rounded-full bg-[var(--ds-well-strong)] px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-[var(--ds-ink)]" title={`Drawn as a group: ${castNoun(c)}`}>
          ×{count}
        </span>
      )}
      {c.look.species && <span className="min-w-0 truncate" title={c.look.species}>· {c.look.species}</span>}
    </p>
  );
};

const photoPhrase = (n: number) => (n ? `, and ${n === 1 ? 'their reference photo goes' : `their ${n} reference photos go`} with them` : '');

export const CharacterCard: React.FC<{ studio: StudioController; doc: ComicDoc; character: Character; byok: boolean; cost?: CostFormat; rating?: ContentRating }> = ({
  studio,
  doc,
  character: c,
  byok,
  cost: costProp,
  rating: ratingProp
}) => {
  const fallbackCost = useCostFormat(studio.caps);
  const cost = costProp ?? fallbackCost;
  const rating = ratingProp ?? effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { busyKey, fire } = useClickGuard();
  const kind = castKindOf(c);
  const status = sheetVisualStatus(c.sheet);
  const drawn = hasImage(c.sheet);
  const src = frameSources(studio.urlFor, c.sheet.asset, { sizes: '(max-width: 640px) 90vw, 320px' });
  const busy = isBusy(c.sheet);
  const price = estimateOne(doc, 'sheet', byok).usd;
  const spec = jobModel(doc, 'sheet');
  const set = (patch: Partial<Character>) => void studio.patch([{ op: 'character', id: c.id, patch }]);
  const setLook = (key: keyof CharacterLook, value: string) => set({ look: { [key]: value } as unknown as CharacterLook });
  const setDetail = (field: 'kind' | 'count' | 'likeness', value: string) => {
    const patch = castDetailPatch(c, field, value);
    if (patch) set(patch);
  };
  const groupSize = typeof c.count === 'number' && c.count > 1 ? Math.min(CAST_GROUP_MAX, Math.floor(c.count)) : 1;
  // Likeness only matters once there is a photo to use (or someone already chose one).
  const showLikeness = c.refs.length > 0 || !!c.likeness;
  const renderSheet = () => fire('sheet', () => studio.act({ type: 'render_sheets', characterIds: [c.id], force: true }));
  const appearances = doc.pages.reduce((n, p) => n + p.panels.filter((panel) => panel.castIds.includes(c.id)).length, 0);
  // "Drawn from older photos": the ready sheet's photos differ from today's pick (a SET compare).
  const hint = sheetHint(doc, { kind: 'character', id: c.id }, byok);
  const olderPhotos = !!hint?.changed;
  const priceId = `price-sheet-${c.id}`;
  const lookFields = LOOK_FIELDS.filter((f) => !f.nonHuman || kind !== 'person' || !!c.look[f.key]);

  return (
    <Surface as="article" aria-label={c.name} data-testid="character-card" data-kind={kind} className="flex min-w-0 flex-col gap-2.5 p-3">
      <ImageFrame
        url={src.url}
        srcSet={src.srcSet}
        sizes={src.sizes}
        heavy={src.heavy}
        // Extras without a sheet get a slim placeholder — they don't need one.
        aspect={c.tier === 'extra' && !drawn && !busy && status !== 'failed' ? '5 / 2' : SHEET_ASPECT}
        alt={`${c.name} model sheet`}
        render={c.sheet}
        tone="paper"
        safety={{ rating, onCheckAgain: () => void studio.act({ type: 'safety_recheck', target: { kind: 'sheet', id: c.id } }), onChangeRating: () => studio.setTab('story') }}
        badges={olderPhotos ? <FrameBadge title="This sheet was drawn before your newest photos. It still works; redraw it to use them.">From older photos</FrameBadge> : undefined}
        placeholder={
          <InitialsPlaceholder
            name={c.name}
            kind={kind}
            note={c.tier === 'extra' ? 'Extras are described in words until they have a sheet; a ready sheet is attached on every page they appear on.' : 'The model sheet keeps them on-model on every page.'}
          />
        }
        overlay={
          <RenderOverlay
            status={status === 'planned' ? 'planned' : status}
            since={c.sheet.updatedAt}
            render={c.sheet}
            label={`${c.name} sheet`}
            model={renderModelNickname(doc, busy ? undefined : c.sheet, 'sheet')}
            typicalSec={spec.latencySec}
            error={c.sheet.error}
            onRetry={renderSheet}
            overImage={drawn && !!src.url}
            staleLabel="Look changed — re-render"
            onRerender={renderSheet}
            compact
          />
        }
      />
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <InlineField label="Name" value={c.name} allowEmpty={false} multiline rows={1} submitOnEnter onCommit={(name) => set({ name })} inputClassName="text-[15px] font-semibold" maxLength={80} />
          <InlineField label="Role" value={c.role || ''} placeholder="Role in the story" multiline rows={1} submitOnEnter onCommit={(role) => set({ role })} inputClassName="text-[12.5px] text-[var(--ds-muted)]" maxLength={200} />
          <CastKindLine character={c} />
        </div>
        {status !== 'planned' && <StatusChip status={status} className="mt-1.5 shrink-0" />}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        className="tap-target inline-flex min-h-[32px] items-center gap-1 self-start rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-[44px]"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        {expanded ? 'Hide look details' : 'Look details, personality & voice'}
      </button>
      {expanded && (
        <div className="space-y-1 rounded-xl bg-[var(--ds-well)] p-1.5">
          <div className="grid gap-x-1 gap-y-0.5 sm:grid-cols-2" data-testid="cast-details">
            <DetailSelect
              label="What they are"
              value={kind}
              options={CAST_KINDS.map((k) => ({ value: k, label: KIND_TEXT[k] }))}
              onChange={(v) => setDetail('kind', v)}
            />
            <DetailSelect
              label="How many"
              value={String(groupSize)}
              options={Array.from({ length: CAST_GROUP_MAX }, (_, i) => ({ value: String(i + 1), label: groupLabel(i + 1) }))}
              onChange={(v) => setDetail('count', v)}
              hint={groupSize > 1 ? `Drawn as one group: ${castNoun(c)}.` : undefined}
            />
            {showLikeness && (
              <DetailSelect
                label="Their photo on pages"
                value={c.likeness ?? 'auto'}
                options={LIKENESS}
                onChange={(v) => setDetail('likeness', v)}
                className="sm:col-span-2"
              />
            )}
          </div>
          <div className="grid gap-x-1 gap-y-0.5 sm:grid-cols-2">
            {lookFields.map((f) => (
              <InlineField
                key={f.key}
                label={f.label}
                showLabel
                value={c.look[f.key] || ''}
                placeholder={f.placeholder}
                maxLength={f.nonHuman ? 120 : undefined}
                onCommit={(v) => setLook(f.key, v)}
                className={f.wide ? 'sm:col-span-2' : undefined}
              />
            ))}
          </div>
          <InlineField label="Personality" showLabel multiline value={c.personality || ''} placeholder="How they act" onCommit={(personality) => set({ personality })} />
          <InlineField label="Voice" showLabel multiline value={c.voice || ''} placeholder="How they talk (feeds dialogue)" onCommit={(voice) => set({ voice })} />
          <p className="px-2 pb-1 text-[11px] leading-snug text-[var(--ds-muted)]">Changing the look marks the sheet and their pages out of date — nothing is redrawn until you ask.</p>
        </div>
      )}
      <div className="min-w-0">
        <p className="mb-0.5 px-1 text-[11px] font-medium text-[var(--ds-muted)]">Your photos</p>
        <RefStrip studio={studio} owner={{ kind: 'character', id: c.id }} hideSheetHint />
      </div>
      {olderPhotos && !busy && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-[#D97757]/[0.07] px-2.5 py-1.5" data-testid="older-photos-hint">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--ds-ink)]">Drawn from older photos — redraw to use your new ones?</span>
          <GhostButton size="xs" busy={busyKey === 'sheet'} onClick={renderSheet} aria-describedby={`${priceId}-hint`}>
            Redraw sheet
          </GhostButton>
          <span id={`${priceId}-hint`} className="text-[11px] tabular-nums text-[var(--ds-muted)]">
            {cost.quote(price)}
          </span>
        </div>
      )}
      {confirmRemove ? (
        <ConfirmStrip
          message={`Remove ${c.name}? They’ll be taken out of every panel they appear in${photoPhrase(c.refs.length)}.`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmRemove(false);
            void studio.patch([{ op: 'character_remove', id: c.id }], { label: `Remove ${c.name}` });
          }}
          onCancel={() => setConfirmRemove(false)}
          cancelLabel="Keep"
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {drawn ? (
            <GhostButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet} aria-describedby={priceId}>
              <Sparkles className="h-3 w-3" aria-hidden /> Re-roll sheet
            </GhostButton>
          ) : c.tier === 'extra' ? (
            <GhostButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet} title="Optional — a ready sheet is attached on every page this extra appears on" aria-describedby={priceId}>
              <Sparkles className="h-3 w-3" aria-hidden /> Draw a sheet anyway
            </GhostButton>
          ) : (
            <PrimaryButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet} aria-describedby={priceId}>
              <Sparkles className="h-3 w-3" aria-hidden /> Render sheet
            </PrimaryButton>
          )}
          <span id={priceId} className="text-[11px] tabular-nums text-[var(--ds-muted)]">
            {cost.quote(price)}
          </span>
          <VersionsButton studio={studio} target={{ kind: 'sheet', id: c.id }} label={`${c.name} sheet`} />
          <IconButton size="sm" label={`Remove ${c.name}`} className="ml-auto" onClick={() => setConfirmRemove(true)}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </Surface>
  );
};

export const PlaceCard: React.FC<{ studio: StudioController; doc: ComicDoc; place: Place; byok: boolean; cost?: CostFormat; rating?: ContentRating }> = ({
  studio,
  doc,
  place: p,
  byok,
  cost: costProp,
  rating: ratingProp
}) => {
  const fallbackCost = useCostFormat(studio.caps);
  const cost = costProp ?? fallbackCost;
  const rating = ratingProp ?? effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { busyKey, fire } = useClickGuard();
  const drawn = hasImage(p.sheet);
  const busy = isBusy(p.sheet);
  const status = sheetVisualStatus(p.sheet);
  const src = frameSources(studio.urlFor, p.sheet.asset, { sizes: '(max-width: 640px) 90vw, 320px' });
  const price = estimateOne(doc, 'place', byok).usd;
  const set = (patch: Partial<Place>) => void studio.patch([{ op: 'place', id: p.id, patch }]);
  const renderSheet = () => fire('sheet', () => studio.act({ type: 'render_sheets', characterIds: [p.id], force: true }));
  const used = doc.pages.reduce((n, page) => n + page.panels.filter((panel) => panel.placeId === p.id).length, 0);
  const showFrame = drawn || busy || status === 'failed';
  const priceId = `price-place-${p.id}`;

  return (
    <Surface as="article" aria-label={p.name} data-testid="place-card" className="flex min-w-0 flex-col gap-2 p-3">
      {showFrame && (
        <ImageFrame
          url={src.url}
          srcSet={src.srcSet}
          sizes={src.sizes}
          heavy={src.heavy}
          aspect={SHEET_ASPECT}
          alt={`${p.name} location sheet`}
          render={p.sheet}
          safety={{ rating, onCheckAgain: () => void studio.act({ type: 'safety_recheck', target: { kind: 'place', id: p.id } }), onChangeRating: () => studio.setTab('story') }}
          overlay={
            <RenderOverlay
              status={status}
              since={p.sheet.updatedAt}
              render={p.sheet}
              label={`${p.name} sheet`}
              model={jobModel(doc, 'place').nickname}
              error={p.sheet.error}
              onRetry={renderSheet}
              overImage={drawn && !!src.url}
              staleLabel="Look changed — re-render"
              compact
            />
          }
        />
      )}
      <div className="flex min-w-0 items-start gap-2">
        <MapPin className="mt-2 h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <InlineField label="Place name" value={p.name} allowEmpty={false} multiline rows={1} submitOnEnter maxLength={80} onCommit={(name) => set({ name })} inputClassName="text-[14px] font-semibold" className="flex-1" />
        <span className="mt-2 shrink-0 text-[11px] text-[var(--ds-muted)]">{used ? `in ${plural(used, 'panel')}` : 'unused'}</span>
      </div>
      <InlineField label="Look" showLabel multiline value={p.look} placeholder="Architecture, props, light, palette" onCommit={(look) => set({ look })} />
      <div className="min-w-0">
        <p className="mb-0.5 px-1 text-[11px] font-medium text-[var(--ds-muted)]">Your photos</p>
        <RefStrip studio={studio} owner={{ kind: 'place', id: p.id }} />
      </div>
      {confirmRemove ? (
        <ConfirmStrip
          message={`Remove ${p.name}? Panels set there will have no location${p.refs.length ? `, and its ${plural(p.refs.length, 'reference photo')} go with it` : ''}.`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmRemove(false);
            void studio.patch([{ op: 'place_remove', id: p.id }], { label: `Remove ${p.name}` });
          }}
          onCancel={() => setConfirmRemove(false)}
          cancelLabel="Keep"
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <GhostButton size="xs" busy={busyKey === 'sheet'} disabled={busy} onClick={renderSheet} title="An optional reference image of this place, used on pages set there" aria-describedby={priceId}>
            <Sparkles className="h-3 w-3" aria-hidden /> {drawn ? 'Re-roll location sheet' : 'Render location sheet'}
          </GhostButton>
          <span id={priceId} className="text-[11px] tabular-nums text-[var(--ds-muted)]">
            {cost.quote(price)}
          </span>
          <VersionsButton studio={studio} target={{ kind: 'place', id: p.id }} label={`${p.name} sheet`} />
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
  const cost = useCostFormat(studio.caps);
  const rating = effectiveRating(doc, studio.caps?.ratingCeiling).rating;
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
            <GhostButton size="xs" onClick={addCharacter} aria-label="Add a character">
              <Plus className="h-3 w-3" aria-hidden /> Add
            </GhostButton>
          }
        >
          Cast · {doc.cast.length}
        </SectionTitle>
        {missing.length > 0 && (
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PrimaryButton
              size="xs"
              busy={busyKey === 'all'}
              aria-describedby="cast-missing-price"
              onClick={() => fire('all', () => studio.act({ type: 'render_sheets', characterIds: missing.map((c) => c.id) }))}
            >
              <Sparkles className="h-3 w-3" aria-hidden /> Render {plural(missing.length, 'sheet')}
            </PrimaryButton>
            <span id="cast-missing-price" className="text-[11px] tabular-nums text-[var(--ds-muted)]">
              {cost.quote(missingPrice)} · {missing.map((c) => c.name).join(', ')}
            </span>
          </div>
        )}
        {cast.length ? (
          <div className={GRID}>
            {cast.map((c) => (
              <CharacterCard key={c.id} studio={studio} doc={doc} character={c} byok={byok} cost={cost} rating={rating} />
            ))}
          </div>
        ) : (
          <EmptyHint icon={<EmptyIllustration variant="cast" />} title="No characters yet">
            Describe your characters in the chat — people, pets, robots or a whole flock of ducklings — or add photos of real people or drawings,
            and each gets a card here with a model sheet that keeps them looking the same on every page.
          </EmptyHint>
        )}
      </section>

      <section aria-labelledby="places-title">
        <SectionTitle
          id="places-title"
          icon={<MapPin className="h-3.5 w-3.5" />}
          right={
            <GhostButton size="xs" onClick={addPlace} aria-label="Add a place">
              <Plus className="h-3 w-3" aria-hidden /> Add
            </GhostButton>
          }
        >
          Places · {doc.places.length}
        </SectionTitle>
        {doc.places.length ? (
          <div className={cx(GRID)}>
            {doc.places.map((p) => (
              <PlaceCard key={p.id} studio={studio} doc={doc} place={p} byok={byok} cost={cost} rating={rating} />
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
