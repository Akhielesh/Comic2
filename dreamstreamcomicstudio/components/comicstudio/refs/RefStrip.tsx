// Compact reference strip for Cast / Place cards, the Style tab and the refs conversation card
// (refs.md §7.2). Owner: P1-REFS; mounted by P2-BOARD (CastTab, StyleTab) and RefsCard.
//
// Always shows an "Add photos" tile (camera-roll friendly multi-picker) — the old strip had no way to
// add and a hover-only remove that touch screens could never reach. Tapping a thumbnail or the count
// opens the drawer. Dropping or pasting images onto the strip uploads to this owner. A character whose
// ready sheet was drawn from older photos shows the soft hint "New photos since this sheet — redraw
// ≈ $0.07" (a hint, never a stale mark, never an automatic redraw).

import React, { useRef, useState } from 'react';
import { ImagePlus, Loader2, Sparkles } from 'lucide-react';
import type { RefOwner } from '../../../shared/comic/doc';
import { capFor, refOwnerKey, refsOf } from '../../../shared/comic/refs';
import { effectiveRating } from '../../../shared/comic/safety';
import { byokFromDoc } from '../board/boardModel';
import { cx } from '../conversation/ui';
import { SafetyVeil } from '../safety/SafetyVeil';
import type { StudioController } from '../types';
import { ACCEPT_ATTR } from './downscale';
import { RefsDrawer } from './RefsDrawer';
import { ownerLabel, sheetHint } from './refsModel';
import { isActiveUpload, useRefUpload, type UploadTransport } from './useRefUpload';

export interface RefStripProps {
  studio: StudioController;
  owner: RefOwner;
  /** Thumbnails shown before "+N" (default 5). */
  max?: number;
  /** Open an external drawer instead of the strip's own. */
  onOpen?(): void;
  /** Hide the sheet hint (e.g. when the card already shows its own sheet controls). */
  hideSheetHint?: boolean;
  className?: string;
  transport?: UploadTransport;
}

const TILE = 'relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50';

export const RefStrip: React.FC<RefStripProps> = ({ studio, owner, max = 5, onOpen, hideSheetHint, className, transport }) => {
  const doc = studio.doc;
  const refs = doc ? refsOf(doc, owner) || [] : [];
  const uploads = useRefUpload(studio, transport ? { transport } : {});
  const key = refOwnerKey(owner);
  const active = uploads.items.filter((i) => refOwnerKey(i.owner) === key && isActiveUpload(i.state)).length;
  const [open, setOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  if (!doc || !refsOf(doc, owner)) return null;

  const cap = capFor(owner);
  const name = ownerLabel(doc, owner);
  const rating = effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const hint = hideSheetHint ? null : sheetHint(doc, owner, byokFromDoc(doc));
  const shown = refs.slice(0, max);
  const more = refs.length - shown.length;
  const openDrawer = () => (onOpen ? onOpen() : setOpen(true));
  const add = (files: File[]) => files.length && void uploads.add(files, owner);
  const imgs = (list: FileList | null | undefined) => Array.from(list || []).filter((f) => !f.type || f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));

  return (
    <div className={cx('min-w-0', className)}>
      <div
        className={cx('flex min-w-0 items-center gap-2 overflow-x-auto rounded-2xl p-1 [scrollbar-width:thin]', dropping && 'bg-[#D97757]/10 ring-2 ring-[#D97757]/60')}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          add(imgs(e.dataTransfer?.files));
        }}
        onPaste={(e) => {
          const files = imgs(e.clipboardData?.files);
          if (files.length) {
            e.preventDefault();
            add(files);
          }
        }}
        aria-label={`${name} reference photos`}
        role="group"
      >
        {shown.map((r, i) => (
          <button key={r.path} type="button" className={TILE} onClick={openDrawer} aria-label={`Photo ${i + 1}${i === 0 ? ' (main)' : ''} — manage photos`}>
            <SafetyVeil asset={r} rating={rating}>
              {studio.urlFor(r, { width: 120 }) ? (
                <img src={studio.urlFor(r, { width: 120 })} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
              ) : (
                <span className="block h-full w-full" />
              )}
            </SafetyVeil>
            {i === 0 && refs.length > 1 && <span className="absolute left-0.5 top-0.5 rounded-full bg-black/55 px-1 text-[9px] font-semibold leading-4 text-white">★</span>}
          </button>
        ))}
        {more > 0 && (
          <button type="button" className={cx(TILE, 'text-[12px] font-semibold text-[var(--ds-ink)]')} onClick={openDrawer} aria-label={`${more} more photos — manage photos`}>
            +{more}
          </button>
        )}
        {active > 0 && (
          <span className={cx(TILE, 'flex items-center justify-center')} role="status" aria-label={`Uploading ${active}`}>
            <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-muted)] motion-reduce:animate-none" aria-hidden />
          </span>
        )}
        <button
          type="button"
          className={cx(TILE, 'flex flex-col items-center justify-center gap-0.5 border-dashed text-[10px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]')}
          onClick={() => (refs.length + active >= cap ? openDrawer() : pick.current?.click())}
          aria-label={refs.length >= cap ? `${name} has ${cap} photos (the limit) — manage photos` : `Add photos to ${name}`}
        >
          <ImagePlus className="h-4 w-4" aria-hidden />
          {refs.length >= cap ? 'Full' : 'Add'}
        </button>
        <input
          ref={pick}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          hidden
          onChange={(e) => {
            add(imgs(e.target.files));
            e.target.value = '';
          }}
        />
        {refs.length > 0 && (
          <button type="button" onClick={openDrawer} className="min-h-[44px] shrink-0 rounded-xl px-2 text-[12px] tabular-nums text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
            {refs.length}/{cap}
          </button>
        )}
      </div>
      {hint?.changed && (
        <button
          type="button"
          onClick={openDrawer}
          className="mt-1 inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-xl px-2 text-left text-[12px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
          <span className="min-w-0">New photos since this sheet — redraw{hint.price ? ` ≈ ${hint.price}` : ''}</span>
        </button>
      )}
      {!onOpen && <RefsDrawer studio={studio} owner={owner} open={open} onClose={() => setOpen(false)} transport={transport} />}
    </div>
  );
};

export default RefStrip;
