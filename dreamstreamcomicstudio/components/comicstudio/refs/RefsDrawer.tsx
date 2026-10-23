// Reference images drawer for one owner (contract §13.3; refs.md §7.1). Owner: P1-REFS.
//
// Add many photos from the device (picker with `multiple`, a "Take photo" camera button, drop, or
// paste), watch each upload (real progress, cancel, retry), then manage them: drag or Alt+←/→ to
// reorder, ★ = the main photo, label the view, add a note, tighten the crop for free, move a photo
// to someone else, remove with a 5-second Undo. Characters also choose what pages see ("Sheet +
// main photo" / "Sheet only") and get the model-sheet offer with its real price — never drawn
// unasked. Full-height panel (full width on phones), 44 px targets, no horizontal overflow.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, Lock, Sparkles, Upload } from 'lucide-react';
import type { RefAsset, RefLabel, RefOwner } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { capFor, refOwnerKey, refsOf } from '../../../shared/comic/refs';
import { effectiveRating } from '../../../shared/comic/safety';
import { byokFromDoc } from '../board/boardModel';
import { SlideOver } from '../conversation/PopSheet';
import { cx } from '../conversation/ui';
import type { StudioController } from '../types';
import { ACCEPT_ATTR } from './downscale';
import { RefActions, RefTile } from './RefTile';
import { LIKENESS_OPTIONS, moveTargets, ownerLabel, ownerTitle, refUsage, sheetHint } from './refsModel';
import { UploadQueue } from './UploadQueue';
import { overCapCopy, useRefUpload, type UploadTransport } from './useRefUpload';
import { useCostFormat } from '../conversation/cost';

export interface RefsDrawerProps {
  studio: StudioController;
  owner: RefOwner;
  open: boolean;
  onClose(): void;
}

/** Test seam: the upload transport (defaults to XHR). */
export interface RefsDrawerInternalProps extends RefsDrawerProps {
  transport?: UploadTransport;
  undoMs?: number;
}

const BTN =
  'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50 disabled:cursor-not-allowed disabled:opacity-45';
const PRIMARY = `${BTN} bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]`;
const QUIET = `${BTN} border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`;

const imageFiles = (list: FileList | File[] | null | undefined): File[] =>
  Array.from(list || []).filter((f) => !f.type || f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));

/** Pointer-event reorder (mouse, pen and touch; the handle has touch-action: none). */
function useDragReorder(onDrop: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const start = useCallback(
    (from: number) => (e: React.PointerEvent) => {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      setDrag({ from, over: from });
      const move = (ev: PointerEvent) => {
        if (typeof document.elementFromPoint !== 'function') return;
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-ref-index]') as HTMLElement | null;
        const over = el ? Number(el.dataset.refIndex) : NaN;
        if (Number.isInteger(over) && dragRef.current && over !== dragRef.current.over) setDrag({ from, over });
      };
      const end = (ev: Event) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('keydown', esc);
        const d = dragRef.current;
        setDrag(null);
        if (ev.type === 'pointerup' && d && d.over !== d.from) onDrop(d.from, d.over);
      };
      const esc = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          dragRef.current = null;
          end(new Event('pointercancel'));
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('keydown', esc);
    },
    [onDrop]
  );
  return { drag, start };
}

export const RefsDrawerBody: React.FC<RefsDrawerInternalProps> = ({ studio, owner, transport, undoMs = 5000 }) => {
  const doc = studio.doc;
  const key = refOwnerKey(owner);
  const refs = useMemo(() => (doc ? refsOf(doc, owner) || [] : []), [doc, owner]);
  const exists = !!doc && !!refsOf(doc, owner);
  const uploads = useRefUpload(studio, transport ? { transport } : {});
  // Prices in the viewer's terms: governed users read a share of their usage, never dollars.
  const cost = useCostFormat(studio);
  const mine = uploads.items.filter((i) => refOwnerKey(i.owner) === key);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<{ ref: RefAsset; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const name = ownerLabel(doc, owner);
  const cap = capFor(owner);
  const visible = refs.filter((r) => r.path !== pending?.ref.path);
  const inflight = mine.filter((i) => i.state === 'queued' || i.state === 'preparing' || i.state === 'uploading' || i.state === 'checking').length;
  const full = visible.length + inflight >= cap;
  const rating = doc ? effectiveRating(doc, studio.caps?.ratingCeiling).rating : 'PG-13';
  const usage = useMemo(() => refUsage(doc, owner), [doc, owner]);
  const targets = useMemo(() => moveTargets(doc, owner), [doc, owner]);
  const byok = doc ? byokFromDoc(doc) : false;
  const hint = sheetHint(doc, owner, byok, cost.approx);
  const character = owner.kind === 'character' ? doc?.cast.find((c) => c.id === owner.id) : undefined;

  const patch = useCallback(
    async (ops: DocOp[], label: string) => {
      setError(null);
      try {
        await studio.patch(ops, { label });
      } catch (err) {
        setError((err as Error)?.message || "That change didn't save — try again.");
      }
    },
    [studio]
  );

  // Remove = hide now, send after the Undo window (or right away when the drawer closes).
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const flushRemoval = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    setPending(null);
    void patchRef.current([{ op: 'ref_remove', owner: ownerRef.current, path: p.ref.path }], 'Remove photo');
  }, []);
  useEffect(() => () => flushRemoval(), [flushRemoval]);

  const remove = (ref: RefAsset) => {
    if (pendingRef.current) flushRemoval();
    const index = refs.findIndex((r) => r.path === ref.path);
    setPending({ ref, index });
    pendingRef.current = { ref, index };
    if (selected === ref.path) setSelected(null);
    timer.current = setTimeout(flushRemoval, undoMs);
  };
  const undoRemove = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pendingRef.current = null;
    setPending(null);
  };

  const move = (ref: RefAsset, to: number) => void patch([{ op: 'ref_move', owner, path: ref.path, to }], to === 0 ? 'Make main photo' : 'Reorder photos');
  const reorder = useDragReorder((from, to) => {
    const ref = visible[from];
    if (ref) move(ref, refs.indexOf(visible[to] ?? ref));
  });

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    void uploads.add(files, owner);
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(imageFiles(e.target.files));
    e.target.value = '';
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = imageFiles(e.clipboardData?.files);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    addFiles(imageFiles(e.dataTransfer?.files));
  };

  const sel = visible.find((r) => r.path === selected);
  const selIndex = sel ? refs.indexOf(sel) : -1;

  if (!doc || !exists) {
    return <p className="text-[13px] text-[var(--ds-muted)]">{doc ? `${name} is no longer in the story.` : 'Loading…'}</p>;
  }

  return (
    <div
      className="min-w-0 space-y-4"
      onPaste={onPaste}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-[var(--ds-muted)]">
          <span className="font-semibold tabular-nums text-[var(--ds-ink)]">
            {visible.length} / {cap}
          </span>{' '}
          {owner.kind === 'style' ? 'style references' : 'photos'}
        </p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" className={PRIMARY} onClick={() => pickRef.current?.click()} disabled={full}>
            <ImagePlus className="h-4 w-4" aria-hidden /> Add photos
          </button>
          <button type="button" className={QUIET} onClick={() => cameraRef.current?.click()} disabled={full}>
            <Camera className="h-4 w-4" aria-hidden /> Take photo
          </button>
        </div>
        <input ref={pickRef} type="file" accept={ACCEPT_ATTR} multiple hidden onChange={onPick} data-testid="refs-picker" />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} data-testid="refs-camera" />
      </div>

      {full && !inflight && (
        <p role="status" className="rounded-xl bg-[#D97757]/10 px-3 py-2 text-[13px] text-[var(--ds-ink)]">
          {overCapCopy(doc, owner)}
        </p>
      )}

      <div
        className={cx(
          'flex min-h-[64px] items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-3 text-center text-[13px] transition-colors motion-reduce:transition-none',
          dropping ? 'border-[#D97757] bg-[#D97757]/10 text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] text-[var(--ds-muted)]'
        )}
      >
        <Upload className="h-4 w-4 shrink-0" aria-hidden />
        <span>Drop photos here, or paste with ⌘/Ctrl+V. JPG, PNG, WebP, GIF or AVIF, up to 40 MB each.</span>
      </div>

      <UploadQueue
        items={mine}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onDismiss={uploads.dismiss}
        onRemoveNew={(item) => {
          if (item.ref) void patch([{ op: 'ref_remove', owner, path: item.ref.path }], 'Remove photo');
          uploads.dismiss(item.id);
        }}
      />

      {visible.length > 0 ? (
        <ul className="grid min-w-0 grid-cols-3 gap-2 sm:grid-cols-4" aria-label={`${name} photos — Alt+arrows reorder, Home makes main`}>
          {visible.map((r, i) => (
            <li key={r.path} className="min-w-0">
              <RefTile
                refAsset={r}
                index={i}
                count={visible.length}
                owner={owner}
                src={studio.urlFor(r, { width: 240 })}
                rating={rating}
                usage={usage.get(r.path)}
                selected={selected === r.path}
                dropTarget={!!reorder.drag && reorder.drag.over === i && reorder.drag.from !== i}
                onSelect={() => setSelected((cur) => (cur === r.path ? null : r.path))}
                onMove={(to) => move(r, refs.indexOf(visible[to] ?? r))}
                onRemove={() => remove(r)}
                onDragHandleDown={reorder.start(i)}
              />
            </li>
          ))}
        </ul>
      ) : (
        !mine.length && <p className="text-[13px] text-[var(--ds-muted)]">No photos yet. Add a few from different angles — front, side and full body work best.</p>
      )}

      {sel && (
        <RefActions
          refAsset={sel}
          index={selIndex}
          owner={owner}
          moveTargets={targets}
          onMakeMain={() => move(sel, 0)}
          onLabel={(label: RefLabel | null) => void patch([{ op: 'ref_patch', owner, path: sel.path, patch: label ? { label } : ({ label: null } as never) }], 'Label photo')}
          onNote={(note) => void patch([{ op: 'ref_patch', owner, path: sel.path, patch: note ? { note } : ({ note: null } as never) }], 'Photo note')}
          onCrop={(mode) => {
            setError(null);
            void studio.act(mode === 'reset' ? { type: 'ref_crop', owner, path: sel.path, reset: true } : { type: 'ref_crop', owner, path: sel.path }).catch((err) => setError((err as Error)?.message || "Couldn't crop that photo."));
          }}
          onTransfer={(to) => {
            setSelected(null);
            void patch([{ op: 'ref_transfer', from: owner, to, path: sel.path }], 'Move photo');
          }}
          onRemove={() => remove(sel)}
        />
      )}

      {pending && (
        <div role="status" className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-[var(--ds-well)] px-3 py-1.5 text-[13px] text-[var(--ds-ink)]">
          <span className="min-w-0 truncate">Photo removed.</span>
          <button type="button" className={QUIET} onClick={undoRemove}>
            Undo
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-[var(--ds-ink)]">
          {error}
        </p>
      )}

      {character && character.tier !== 'extra' && (
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-[12px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Pages use</legend>
          <div className="flex min-w-0 flex-wrap gap-2" role="radiogroup" aria-label="What pages use">
            {LIKENESS_OPTIONS.map((o) => {
              const on = (character.likeness ?? 'auto') === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={o.hint}
                  className={cx(QUIET, on && 'border-[#D97757]/50 bg-[#D97757]/10')}
                  onClick={() => !on && void patch([{ op: 'character', id: character.id, patch: { likeness: o.value } }], 'Likeness')}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {hint && (hint.missing || hint.changed) && character && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#D97757]/30 bg-[#D97757]/[0.06] p-3">
          <p className="min-w-0 flex-1 text-[13px] text-[var(--ds-ink)]">
            {hint.changed
              ? `New photos since ${name}'s sheet was drawn. It stays as it is until you redraw it.`
              : `One drawn model sheet keeps ${name} the same on every page.`}
          </p>
          <button
            type="button"
            className={PRIMARY}
            disabled={studio.isRendering({ kind: 'sheet', id: character.id })}
            onClick={() => void studio.act({ type: 'render_sheets', characterIds: [character.id], ...(hint.changed ? { force: true } : {}) })}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            {hint.changed ? 'Redraw sheet' : 'Make the sheet'}
            {hint.price && <span className="font-normal opacity-90"> {hint.price}</span>}
          </button>
        </div>
      )}

      <p className="flex items-start gap-1.5 text-[12px] leading-snug text-[var(--ds-muted)]">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Your photos stay private to you. Readers only ever see the drawn comic. Only add photos you have the right to use.
          {owner.kind === 'style' && ' We borrow the look, never the content.'}
        </span>
      </p>
    </div>
  );
};

export const RefsDrawer: React.FC<RefsDrawerProps & { transport?: UploadTransport }> = ({ studio, owner, open, onClose, transport }) => {
  if (!open) return null;
  return (
    <SlideOver open={open} onClose={onClose} title={ownerTitle(studio.doc, owner)}>
      <RefsDrawerBody studio={studio} owner={owner} open={open} onClose={onClose} transport={transport} />
    </SlideOver>
  );
};

export default RefsDrawer;
