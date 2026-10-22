// Reference images — owners, caps and labels (contract §9.2). Pure.

import { refInboxOf, type ComicDoc, type RefAsset, type RefLabel, type RefOwner } from './doc.js';
import { DOC_LIMITS } from './limits.js';

export const REF_LIMITS = {
  character: DOC_LIMITS.refsPerCharacter,
  place: DOC_LIMITS.refsPerPlace,
  style: DOC_LIMITS.refsStyle,
  inbox: DOC_LIMITS.refInbox,
  project: DOC_LIMITS.refsProject,
  perMessageImages: DOC_LIMITS.imagesPerMessage,
  noteChars: DOC_LIMITS.refNoteChars,
  nameChars: DOC_LIMITS.refNameChars,
  sheetAuthorRefs: 4, // was AUTHOR_REF_LIMIT 3 (prompts.ts); still ≤ spec.refs.characters
  pagePhotosPerCharacter: 2,
  minEdgePx: 128,
  maxUploadBytes: 10 * 1024 * 1024, // after client downscale
  maxSourceBytes: 40 * 1024 * 1024, // before client downscale (fixes the 10 MB pre-shrink rejection)
  inboxTtlMs: 24 * 3600_000
} as const;

export const REF_LABELS: readonly RefLabel[] = [
  'face', 'front', 'three_quarter', 'side', 'back', 'full_body', 'outfit', 'expression', 'pose', 'detail',
  'wide', 'exterior', 'interior', 'lighting',
  'linework', 'color', 'texture', 'mood', 'composition',
  'other'
];
export const REF_LABELS_FOR: Record<'character' | 'place' | 'style', RefLabel[]> = {
  character: ['face', 'front', 'three_quarter', 'side', 'back', 'full_body', 'outfit', 'expression', 'pose', 'detail', 'other'],
  place: ['wide', 'exterior', 'interior', 'lighting', 'detail', 'mood', 'other'],
  style: ['linework', 'color', 'texture', 'mood', 'composition', 'lighting', 'other']
};
export const REF_LABEL_TEXT: Record<RefLabel, string> = {
  face: 'Face close-up',
  front: 'Front',
  three_quarter: '¾ view',
  side: 'Side',
  back: 'Back',
  full_body: 'Full body',
  outfit: 'Outfit',
  expression: 'Expression',
  pose: 'Pose',
  detail: 'Detail',
  wide: 'Wide view',
  exterior: 'Exterior',
  interior: 'Interior',
  lighting: 'Lighting',
  linework: 'Linework',
  color: 'Colour',
  texture: 'Texture',
  mood: 'Mood',
  composition: 'Composition',
  other: 'Other'
};
export const UPLOAD_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'] as const; // never SVG/HTML/HEIC

export const isRefLabel = (v: unknown): v is RefLabel => typeof v === 'string' && (REF_LABELS as readonly string[]).includes(v);

/** 'style' | 'inbox' | 'character:<id>' | 'place:<id>' */
export const refOwnerKey = (o: RefOwner): string =>
  o.kind === 'style' || o.kind === 'inbox' ? o.kind : `${o.kind}:${o.id}`;

export const parseRefOwnerKey = (key: string): RefOwner | null => {
  if (key === 'style') return { kind: 'style' };
  if (key === 'inbox') return { kind: 'inbox' };
  const m = /^(character|place):(.+)$/.exec(typeof key === 'string' ? key : '');
  return m ? { kind: m[1] as 'character' | 'place', id: m[2] } : null;
};

/** The ref list of an owner; undefined = owner missing. */
export const refsOf = (doc: ComicDoc, o: RefOwner): RefAsset[] | undefined => {
  switch (o?.kind) {
    case 'character':
      return doc.cast.find((c) => c.id === o.id)?.refs;
    case 'place':
      return doc.places.find((p) => p.id === o.id)?.refs;
    case 'style':
      return doc.style.refs;
    case 'inbox':
      return refInboxOf(doc);
    default:
      return undefined;
  }
};

export const capFor = (o: RefOwner): number => {
  switch (o?.kind) {
    case 'character':
      return REF_LIMITS.character;
    case 'place':
      return REF_LIMITS.place;
    case 'style':
      return REF_LIMITS.style;
    case 'inbox':
      return REF_LIMITS.inbox;
    default:
      return 0;
  }
};

/** style + cast + places + inbox (conversation attachments excluded). */
export const totalRefs = (doc: ComicDoc): number =>
  doc.style.refs.length +
  doc.cast.reduce((n, c) => n + c.refs.length, 0) +
  doc.places.reduce((n, p) => n + p.refs.length, 0) +
  refInboxOf(doc).length;

export const findRefOwners = (doc: ComicDoc, path: string): RefOwner[] => {
  const out: RefOwner[] = [];
  if (doc.style.refs.some((r) => r.path === path)) out.push({ kind: 'style' });
  for (const c of doc.cast) if (c.refs.some((r) => r.path === path)) out.push({ kind: 'character', id: c.id });
  for (const p of doc.places) if (p.refs.some((r) => r.path === path)) out.push({ kind: 'place', id: p.id });
  if (refInboxOf(doc).some((r) => r.path === path)) out.push({ kind: 'inbox' });
  return out;
};

export const sameRefOwner = (a: RefOwner, b: RefOwner): boolean => refOwnerKey(a) === refOwnerKey(b);
