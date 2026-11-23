import type { ComicDoc, RenderState } from './doc.js';
import { anyRenderBusy, needsYouOf, type NeedsWhy } from './attention.js';
import { canServeToOwner } from './safety.js';

export type WorkAttention = NeedsWhy | 'interrupted' | 'render_failed';
export const FINISHED_KINDS = ['plan', 'pages', 'cover', 'sheets', 'looks', 'translation', 'reply', 'published'] as const;
export type FinishedKind = (typeof FINISHED_KINDS)[number];
export type FinishedWork = { kind: FinishedKind; at: number; count?: number };
/** Only coarse outcomes go into this private listing projection. No prompts, prices, messages, asset paths or signed URLs. */
export interface ComicWorkSummary {
  v: 1;
  attention: WorkAttention | null;
  working: boolean;
  finished: FinishedWork[];
}

export function summarizeComicWork(doc: ComicDoc): ComicWorkSummary {
  const finished: FinishedWork[] = [];
  let renderFailed = false;
  const renders = (kind: FinishedKind, targets: (RenderState | undefined)[]) => {
    let latest = 0;
    let count = 0;
    for (const render of targets) {
      if (render?.status === 'failed') renderFailed = true;
      const asset = render?.asset;
      if (!asset || asset.source !== 'generated' || !asset.at || !canServeToOwner(asset)) continue;
      count += 1;
      latest = Math.max(latest, asset.at);
    }
    if (count) finished.push({ kind, at: latest, count });
  };
  renders('pages', (doc.pages ?? []).map((page) => page.render));
  renders('cover', [doc.cover?.render]);
  renders('sheets', [...(doc.cast ?? []).map((person) => person.sheet), ...(doc.places ?? []).map((place) => place.sheet)]);
  renders('looks', (doc.style?.options ?? []).map((option) => option.render));

  let translatedAt = 0;
  for (const edition of Object.values(doc.i18n?.editions ?? {})) {
    for (const text of [...Object.values(edition?.lines ?? {}), ...Object.values(edition?.cover ?? {}), ...Object.values(edition?.brief ?? {})]) {
      if (text && text.status !== 'edited' && text.at > translatedAt) translatedAt = text.at;
    }
  }
  if (translatedAt) finished.push({ kind: 'translation', at: translatedAt });
  if (doc.publication?.status === 'live') finished.push({ kind: 'published', at: doc.publication.publishedAt });
  // Include a Director reply only after an actual request, never a canned welcome or a background notice.
  let requested = false;
  let replyAt = 0;
  let planAt = 0;
  for (const message of doc.conversation ?? []) {
    if (message.role === 'assistant' && message.cards?.some((card) => card.type === 'plan' || card.type === 'breakdown' && card.view === 'plan')) planAt = message.at;
    if (message.role === 'user') requested = true;
    else if (requested && !message.runAt && !message.cards?.length && message.text?.trim()) replyAt = message.at;
  }
  if (replyAt) finished.push({ kind: 'reply', at: replyAt });

  if (planAt && doc.pages.length) finished.push({ kind: 'plan', at: planAt });

  const need = needsYouOf(doc)?.why ?? (doc.directorDraft?.status === 'interrupted' ? 'interrupted' : doc.directorDraft?.status === 'review' && doc.planStatus === 'draft' ? 'plan' : null);
  return {
    v: 1, attention: need ?? (renderFailed ? 'render_failed' : null),
    working: anyRenderBusy(doc) || doc.directorDraft?.status === 'planning',
    finished: finished.sort((a, b) => b.at - a.at)
  };
}
