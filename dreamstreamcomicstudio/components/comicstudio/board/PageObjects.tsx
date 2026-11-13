import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { refInboxOf, type AssetRef, type Box, type ComicDoc, type Page } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import { canServeToOwner } from '../../../shared/comic/safety';
import { PRO_PAGE_LIMITS } from '../../../shared/comic/limits';
import { cn } from '../../../lib/utils';
import { DENSITY, FIELD } from '../../chat/studioDesign';
import { ACCEPT_ATTR, PrepareError, prepareImageFile } from '../refs/downscale';
import { StudioApiError } from '../studioApi';
import { GhostButton, InlineField } from './ui';

interface Props {
  doc: ComicDoc;
  page: Page;
  studio: StudioController;
  region: Box | null;
  onMark: () => void;
}

const dimensions = [
  ['x', 'Left'],
  ['y', 'Top'],
  ['w', 'Width'],
  ['h', 'Height']
] as const;

function canPlaceReference(asset: AssetRef, projectId: string): boolean {
  if (!canServeToOwner(asset) || asset.path.includes('..')) return false;
  if (/^library\/[\w.-]+(?:\/[\w.-]+)+$/.test(asset.path)) return true;
  const lane = /^u\/[\w-]+\/p\/([\w-]+)\/(img|ref)\/[\w@.-]+$/.exec(asset.path);
  return !!lane && lane[1] === projectId.replace(/[^\w-]/g, '-') && (lane[2] === 'ref' || asset.source !== 'upload');
}

export function PageObjects({ doc, page, studio, region, onMark }: Props) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  useEffect(() => () => upload.current?.abort(), []);
  const selectClass = cn(FIELD, DENSITY.coarse, 'min-w-0 px-2 py-1.5');
  const references = [...new Map(
    [...refInboxOf(doc), ...doc.style.refs, ...doc.cast.flatMap(({ refs }) => refs), ...doc.places.flatMap(({ refs }) => refs)]
      .filter((asset) => asset.path && canPlaceReference(asset, doc.id))
      .map((asset) => [asset.path, asset] as const)
  ).values()];
  const chosen = references.find((asset) => asset.path === path) ?? references[0];
  const objects = (page.layers ?? []).filter((layer) => layer.kind === 'image');
  const selection = studio.selection?.pageId === page.id ? studio.selection.layerIds?.[0] : undefined;
  const selected = objects.find((layer) => layer.id === selection);
  const select = (id: string | null) => studio.setSelection(id ? { pageId: page.id, surface: 'page_editor', layerIds: [id], lineIds: [] } : null);

  const importImage = async (file: File) => {
    if (busy || upload.current) return;
    const controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setMessage('Preparing the image…');
    try {
      const image = await prepareImageFile(file);
      if (controller.signal.aborted) return;
      const saved = await studio.uploadRef(image.blob, { kind: 'inbox' }, { name: image.name, hash: image.hash, signal: controller.signal });
      if (controller.signal.aborted) return;
      const ready = saved.ref?.path ?? saved.duplicateOf;
      if (!ready) throw new Error('The image upload did not finish.');
      setPath(ready);
      setMessage('Image ready to place.');
    } catch (cause) {
      const copy = cause instanceof PrepareError || cause instanceof StudioApiError ? cause.message : 'The image could not be added.';
      if (!controller.signal.aborted) setMessage(copy);
    } finally {
      if (upload.current === controller) upload.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const add = async () => {
    if (!chosen || busy || upload.current) return;
    setBusy(true);
    setMessage('');
    try {
      const { resolveDrop } = await import('../../../shared/comic/editor/drop');
      const point = region ? { x: region.x + region.w / 2, y: region.y + region.h / 2 } : { x: 0.5, y: 0.5 };
      const result = resolveDrop(doc, page, { kind: 'image', path: chosen.path, name: chosen.name }, {
        point, ref: { kind: 'page', id: page.id }
      }, { as: 'sticker' });
      if (result.ok === false) {
        setMessage(result.reason);
        return;
      }
      const op = result.ops.find((operation) => operation.op === 'layer');
      if (op?.patch?.box && region) {
        // Fit the image within the mark without stretching it.
        const { w, h } = op.patch.box;
        const scale = Math.min(region.w / w, region.h / h);
        const fitted = { w: w * scale, h: h * scale };
        if (Math.min(fitted.w, fitted.h) < PRO_PAGE_LIMITS.boxMin) {
          setMessage('Mark a larger area to place this image.');
          return;
        }
        op.patch.box = {
          ...fitted,
          x: region.x + (region.w - fitted.w) / 2,
          y: region.y + (region.h - fitted.h) / 2
        };
      }
      let failed = false;
      await studio.patch(result.ops, { undo: true, label: 'Add image object', onFailed: () => { failed = true; } });
      if (failed) return;
      if (op) select(op.id);
      setMessage(result.warning ?? 'Image placed. You can adjust or remove it below.');
    } catch {
      setMessage('The image could not be placed.');
    } finally {
      setBusy(false);
    }
  };

  const patchObject = async (patch: { box: Box } | null, label: string) => {
    if (!selected || selected.locked || busy) return;
    try {
      let failed = false;
      await studio.patch([{ op: 'layer', pageId: page.id, id: selected.id, patch }], {
        undo: true, label, onFailed: () => { failed = true; }
      });
      if (patch === null && !failed) select(null);
    } catch {
      setMessage('The object could not be updated.');
    }
  };

  const move = (field: keyof Box, value: string) => {
    if (!selected || selected.locked || value.trim() === '') return;
    const amount = Number(value) / 100;
    if (!Number.isFinite(amount)) return;
    const { x, y, w, h } = selected.box;
    const maximum = { x: 1 - w, y: 1 - h, w: 1 - x, h: 1 - y }[field];
    const minimum = field === 'w' || field === 'h' ? PRO_PAGE_LIMITS.boxMin : 0;
    const box = { ...selected.box, [field]: Math.max(minimum, Math.min(maximum, amount)) };
    void patchObject({ box }, 'Adjust image object');
  };

  return (
    <section className="space-y-2" aria-label="Page objects">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-ink)]">
        <ImagePlus className="size-4" aria-hidden /> Page objects
      </h3>
      <p className="text-[12px] leading-5 text-[var(--ds-muted)]">
        Place an uploaded image as a movable layer. The page drawing stays intact.
      </p>
      <input
        type="file"
        ref={picker}
        accept={ACCEPT_ATTR}
        hidden
        aria-label="Upload an image object"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importImage(file);
        }}
      />
      <GhostButton size="xs" disabled={busy} onClick={() => picker.current?.click()}>
        <ImagePlus className="size-3.5" aria-hidden /> Upload image
      </GhostButton>
      {chosen ? (
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] text-[var(--ds-muted)]">
            Image from Assets
            <select className={selectClass} value={chosen.path} onChange={(event) => setPath(event.target.value)}>
              {references.map((asset, index) => <option key={asset.path} value={asset.path}>{asset.name || `Image ${index + 1}`}</option>)}
            </select>
          </label>
          <GhostButton size="xs" disabled={busy} onClick={() => void add()}>
            {region ? 'Place in marked area' : 'Place image'}
          </GhostButton>
          {!region && <GhostButton size="xs" onClick={onMark}>Mark placement</GhostButton>}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--ds-muted)]">Upload an image to place it here.</p>
      )}
      {objects.length > 0 && (
        <label className="flex flex-col gap-1 text-[12px] text-[var(--ds-muted)]">
          Select an object
          <select className={selectClass} value={selected?.id ?? ''} onChange={(event) => select(event.target.value || null)}>
            <option value="">Choose an image layer</option>
            {objects.map((object, index) => <option key={object.id} value={object.id}>{object.name || `Image layer ${index + 1}`}</option>)}
          </select>
        </label>
      )}
      {selected && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {dimensions.map(([field, label]) => (
              <InlineField
                key={field}
                label={`${label} (%)`}
                showLabel
                value={String(Math.round(selected.box[field] * 100))}
                onCommit={(value) => move(field, value)}
                disabled={selected.locked || busy}
              />
            ))}
          </div>
          <GhostButton size="xs" disabled={selected.locked || busy} onClick={() => void patchObject(null, 'Remove image object')}>
            <Trash2 className="size-3.5" aria-hidden /> Remove object
          </GhostButton>
        </div>
      )}
      {message && <p role="status" className="text-[12px] text-[var(--ds-muted)]">{message}</p>}
    </section>
  );
}
