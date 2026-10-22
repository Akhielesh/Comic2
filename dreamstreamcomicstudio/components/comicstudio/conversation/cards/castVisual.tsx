// Cast visuals shared by the conversation cards (cast, recap, options): a kind icon for
// non-human cast (animals, creatures, robots, toys, vehicles, props are first-class), the
// "×3" group badge, the derived "Companion" label and a small avatar (sheet thumb, first
// reference, or initials on a stable tint). Pure presentation; reads nothing but the
// character it is given.

import React from 'react';
import { Bot, Car, Ghost, Package, PawPrint, ToyBrick, User, type LucideIcon } from 'lucide-react';
import { castKindOf, isCompanion, type AssetRef, type CastKind, type Character } from '../../../../shared/comic/doc';
import { cx } from '../ui';

export const KIND_NAME: Record<CastKind, string> = {
  person: 'Person',
  animal: 'Animal',
  creature: 'Creature',
  robot: 'Robot',
  toy: 'Toy',
  vehicle: 'Vehicle',
  object: 'Prop'
};

const KIND_ICON: Record<CastKind, LucideIcon> = {
  person: User,
  animal: PawPrint,
  creature: Ghost,
  robot: Bot,
  toy: ToyBrick,
  vehicle: Car,
  object: Package
};

/** The lucide glyph for a cast kind (person is the plain silhouette). */
export const KindIcon: React.FC<{ kind?: CastKind; className?: string }> = ({ kind = 'person', className }) => {
  const Icon = KIND_ICON[kind] || User;
  return <Icon className={cx('shrink-0', className)} aria-hidden />;
};

/** Group size when the character is a group ("three ducklings"), else undefined. */
export const groupCount = (c: Character): number | undefined => {
  const n = typeof c.count === 'number' && Number.isFinite(c.count) ? Math.floor(c.count) : 1;
  return n > 1 ? n : undefined;
};

/**
 * Role label shown on chips: leads stay "Lead"; a non-human support is a "Companion"
 * (director.md §3.5 — derived, no new tier); a non-human extra prop is a "Prop".
 */
export const castRoleLabel = (c: Character): string => {
  if (c.tier === 'lead') return 'Lead';
  if (isCompanion(c)) return 'Companion';
  if (c.tier === 'extra') return castKindOf(c) === 'object' ? 'Prop' : 'Extra';
  return 'Support';
};

/** Spoken description for screen readers: "Ducklings, group of 3 animals, Companion". */
export const castAriaLabel = (c: Character): string => {
  const kind = castKindOf(c);
  const n = groupCount(c);
  const what = kind === 'person' ? (n ? `group of ${n}` : '') : n ? `group of ${n} ${KIND_NAME[kind].toLowerCase()}s` : KIND_NAME[kind].toLowerCase();
  return [c.name || 'Unnamed', what, castRoleLabel(c)].filter(Boolean).join(', ');
};

const TINTS = ['#E9D5C9', '#D6E4E5', '#E3DCEF', '#DDE7D3', '#F0E1C6', '#D9DFF0'];
export const tintFor = (id: string) => TINTS[[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % TINTS.length];
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

/** Square avatar: sheet art when ready, else the first reference, else initials (or the kind icon). */
export const CastAvatar: React.FC<{
  character: Character;
  urlFor: (asset?: AssetRef | string | null) => string | undefined;
  size?: number;
  busy?: boolean;
  /** Draw the "×3" group badge (off where the name line already says it). */
  showCount?: boolean;
  className?: string;
}> = ({ character: c, urlFor, size = 40, busy, showCount = true, className }) => {
  const kind = castKindOf(c);
  const url = c.sheet.status === 'ready' && c.sheet.asset ? urlFor(c.sheet.asset) : c.refs[0] ? urlFor(c.refs[0]) : undefined;
  const n = groupCount(c);
  const badge = Math.max(14, Math.round(size * 0.42));
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      <span className="block h-full w-full overflow-hidden rounded-xl" style={{ background: tintFor(c.id) }}>
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover object-left" />
        ) : kind !== 'person' ? (
          <span className="grid h-full w-full place-items-center text-[#3d3a33]">
            <KindIcon kind={kind} className={size >= 32 ? 'h-4 w-4' : 'h-3 w-3'} />
          </span>
        ) : (
          <span className="grid h-full w-full place-items-center font-semibold text-[#3d3a33]" style={{ fontSize: Math.max(9, Math.round(size * 0.32)) }}>
            {initialsOf(c.name)}
          </span>
        )}
        {busy && <span className="studio-shimmer absolute inset-0 rounded-xl" aria-hidden />}
      </span>
      {/* Kind badge (non-humans) — icon on art, so the avatar still says "animal". */}
      {kind !== 'person' && url && (
        <span
          className="absolute -bottom-1 -left-1 grid place-items-center rounded-full border border-[var(--ds-surface)] bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm"
          style={{ width: badge, height: badge }}
          aria-hidden
        >
          <KindIcon kind={kind} className="h-2.5 w-2.5" />
        </span>
      )}
      {n && showCount && (
        <span
          className="absolute -right-1 -top-1 rounded-full bg-[var(--ds-accent)] px-1 text-[9.5px] font-semibold leading-[14px] tabular-nums text-white shadow-sm"
          aria-hidden
        >
          ×{n}
        </span>
      )}
    </span>
  );
};
