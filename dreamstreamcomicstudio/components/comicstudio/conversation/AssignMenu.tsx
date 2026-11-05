// "Who's in this photo?" — the quick-assign menu shared by the composer (sets the message's
// `attachmentTargets`, refs.md §7.2) and the user's sent photos in the conversation (MessageItem:
// "Unassigned · Assign" commits `ref_add` / `ref_transfer` right away). Free either way: the
// software files the photo, the director only confirms and enriches the look.
//
// Choices: the cast (leads and support first), "+ New character" (a name field), the places, and
// "Art style reference". The composer also offers "Let the director decide" (no target).
// Every row is 44 px on touch; long names truncate; the panel never overflows a 320 px phone.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, MapPin, Palette, Sparkles, UserPlus, UserRound } from 'lucide-react';
import type { CastTier, ComicDoc, RefOwner } from '../../../shared/comic/doc';
import type { AttachmentTarget } from '../../../shared/comic/events';
import { REF_LIMITS, capFor, refsOf } from '../../../shared/comic/refs';
import { cx } from './ui';

/** Cast rows shown (leads and support first). */
export const ASSIGN_CAST_MAX = 10;

const TIER_RANK: Record<CastTier, number> = { lead: 0, support: 1, extra: 2 };

/** The cast in menu order: leads, then support, then extras (stable within a tier). */
export const castForAssign = (doc: ComicDoc | null | undefined) =>
  (doc?.cast || [])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (TIER_RANK[a.c.tier] ?? 3) - (TIER_RANK[b.c.tier] ?? 3) || a.i - b.i)
    .map((x) => x.c)
    .slice(0, ASSIGN_CAST_MAX);

const sameTarget = (a: AttachmentTarget | undefined, b: AttachmentTarget | undefined): boolean => {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'new_character' && b.kind === 'new_character') return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
  return (a as { id?: string }).id === (b as { id?: string }).id;
};

/** Short words for a target ("MAYA", "New: BRUNO", "Style", "The docks"), or null for none. */
export const targetLabel = (doc: ComicDoc | null | undefined, target: AttachmentTarget | undefined): string | null => {
  if (!target) return null;
  switch (target.kind) {
    case 'character': {
      const c = doc?.cast.find((x) => x.id === target.id);
      return c ? c.name.toUpperCase() : null;
    }
    case 'place':
      return doc?.places.find((p) => p.id === target.id)?.name || null;
    case 'style':
      return 'Style';
    case 'new_character':
      return target.name.trim() ? `New: ${target.name.trim().toUpperCase()}` : null;
    default:
      return null;
  }
};

/** Free slots an owner has left (null when the owner is gone). */
const roomOn = (doc: ComicDoc, owner: RefOwner): number | null => {
  const list = refsOf(doc, owner);
  return list ? capFor(owner) - list.length : null;
};

export interface AssignMenuProps {
  doc: ComicDoc;
  /** How many photos this assigns (wording only). */
  count: number;
  /** The current choice (marked). */
  value?: AttachmentTarget;
  onPick(target: AttachmentTarget): void;
  /** Offer "Let the director decide" (clears the choice). */
  allowClear?: boolean;
  className?: string;
}

const ROW =
  'flex min-h-[40px] w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-[13.5px] text-[var(--ds-ink)] transition-colors duration-150 hover:bg-[var(--ds-hover)] focus-visible:bg-[var(--ds-hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-[48px]';
const ICON = 'grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--ds-surface-soft)] text-[var(--ds-muted)]';

export const AssignMenu: React.FC<AssignMenuProps> = ({ doc, count, value, onPick, allowClear, className }) => {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);
  const cast = castForAssign(doc);
  const places = doc.places.slice(0, ASSIGN_CAST_MAX);
  const photos = count === 1 ? 'this photo' : `these ${count} photos`;
  const full = (owner: RefOwner) => {
    const room = roomOn(doc, owner);
    return room !== null && room < count;
  };

  const row = (key: string, icon: React.ReactNode, label: React.ReactNode, target: AttachmentTarget, opts: { disabled?: boolean; detail?: string } = {}) => {
    const on = sameTarget(value, target);
    return (
      <button
        key={key}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        disabled={opts.disabled}
        onClick={() => onPick(target)}
        className={cx(ROW, on && 'bg-[#D97757]/10')}
      >
        <span className={ICON} aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {opts.detail && <span className="block truncate text-[11.5px] text-[var(--ds-muted)]">{opts.detail}</span>}
        </span>
        {on && <Check className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />}
      </button>
    );
  };

  const addNew = () => {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) return;
    onPick({ kind: 'new_character', name: clean });
    setNaming(false);
    setName('');
  };

  // Naming a new character is its own small step: a text field and a button are not menu items, so
  // they never sit inside role="menu" (axe aria-required-children), and on a phone the field is at
  // the top of the sheet, right above the keyboard it opens.
  if (naming) {
    return (
      <div className={cx('flex min-w-0 flex-col gap-0.5 p-1.5', className)}>
        <p className="px-2.5 pb-1 pt-0.5 text-[12px] text-[var(--ds-muted)]">Who’s the new character in {photos}?</p>
        <form
          className="flex min-w-0 items-center gap-1.5 px-1 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            addNew();
          }}
        >
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Their name"
            aria-label="New character's name"
            className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[14px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] focus:border-[#D97757]/45 coarse:h-11 coarse:text-[16px]"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="inline-flex h-10 shrink-0 items-center rounded-xl bg-[var(--ds-accent)] px-3 text-[13px] font-semibold text-white hover:bg-[var(--ds-accent-hover)] disabled:bg-[var(--ds-well-strong)] disabled:text-[var(--ds-muted)] coarse:h-11"
          >
            Add
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setNaming(false);
            setName('');
          }}
          className={ROW}
        >
          <span className={ICON} aria-hidden>
            <ArrowLeft className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate">Back to the cast</span>
        </button>
      </div>
    );
  }

  /** Arrow keys / Home / End move between the enabled rows, like a native menu. */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className={cx('flex min-w-0 flex-col gap-0.5 p-1.5', className)}>
      <p className="px-2.5 pb-1 pt-0.5 text-[12px] text-[var(--ds-muted)]">Who’s in {photos}? Filing photos is free.</p>
      <div role="menu" aria-label={`Who's in ${photos}?`} onKeyDown={onMenuKeyDown} className="flex min-w-0 flex-col gap-0.5">
        {cast.map((c) => {
          const owner: RefOwner = { kind: 'character', id: c.id };
          const isFull = full(owner);
          return row(c.id, <UserRound className="h-3.5 w-3.5" />, c.name.toUpperCase(), owner, {
            disabled: isFull,
            detail: isFull ? `Has ${capFor(owner)} photos — remove one first` : c.role || (c.tier === 'lead' ? 'Lead' : c.tier === 'support' ? 'Support' : undefined)
          });
        })}
        <button type="button" role="menuitem" onClick={() => setNaming(true)} className={ROW}>
          <span className={ICON} aria-hidden>
            <UserPlus className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate">New character…</span>
          {value?.kind === 'new_character' && (
            <span className="max-w-[40%] shrink-0 truncate text-[12px] text-[var(--ds-muted)]">{value.name.toUpperCase()}</span>
          )}
        </button>
        {places.map((p) => {
          const owner: RefOwner = { kind: 'place', id: p.id };
          return row(p.id, <MapPin className="h-3.5 w-3.5" />, p.name || 'Place', owner, {
            disabled: full(owner),
            detail: full(owner) ? `Has ${capFor(owner)} photos — remove one first` : 'A place in the story'
          });
        })}
        {row('style', <Palette className="h-3.5 w-3.5" />, 'Art style reference', { kind: 'style' }, {
          disabled: full({ kind: 'style' }),
          detail: full({ kind: 'style' }) ? `Holds ${REF_LIMITS.style} photos — remove one first` : 'We borrow the look, never the content'
        })}
        {allowClear && (
          <>
            <div className="mx-2.5 my-1 border-t border-[var(--ds-hairline-soft)]" aria-hidden />
            {row('none', <Sparkles className="h-3.5 w-3.5" />, 'Let the director decide', null, { detail: 'It asks if it can’t tell' })}
          </>
        )}
      </div>
    </div>
  );
};
