// Director tool group "library" (contract §12.1/§12.2). Owned by P1-LIBRARY.
//
//   suggest_presets {presetIds? (1–6), note?}  FREE — posts a `style_presets` card: the best-fitting
//                                             curated looks (rankPresets, deterministic) shown with
//                                             the platform library's preview art (procedural art
//                                             when none is published). For "which look fits?"; an
//                                             ask to SEE drawn looks (styleAsk.ts) is refused toward
//                                             propose_styles (stylepick SC-0).
//   use_preset {presetId, withBoard?}         FREE — the use_preset action (software only).
//
// Phase gate: the style is empty or drafted. Neither tool ever generates an image: library
// generation runs only from the admin console after an explicit admin click.

import { newId, type Card, type ComicDoc } from '../../../../shared/comic/doc.js';
import { STYLE_PRESETS, getStylePreset, rankPresets } from '../../../../shared/comic/stylePresets.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import type { DirectorTurn } from '../tools.js';
import { styleLooksAsk } from '../styleAsk.js';
import type { StudioContext } from '../types.js';
import { FREE_NOTE, runUsePreset } from '../actions/library.js';

export const MAX_SUGGESTED_PRESETS = 6;
export const DEFAULT_SUGGESTED_PRESETS = 4;
const NOTE_MAX = 200;

const presetList = () => STYLE_PRESETS.map((p) => p.id).join(', ');

/** Validate preset ids from the model (dedupe, cap, known only); undefined ⇒ rankPresets picks. */
export function parsePresetIds(doc: ComicDoc, raw: unknown): string[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return rankPresets(doc).slice(0, DEFAULT_SUGGESTED_PRESETS);
  const list = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const v of list) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!id) continue;
    if (!getStylePreset(id)) unknown.push(id.slice(0, 40));
    else if (!ids.includes(id)) ids.push(id);
  }
  if (unknown.length) throw toolArgError(`Unknown preset${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Use ids from: ${presetList()}.`);
  if (!ids.length) throw toolArgError(`presetIds must list 1–${MAX_SUGGESTED_PRESETS} preset ids from: ${presetList()}.`);
  return ids.slice(0, MAX_SUGGESTED_PRESETS);
}

const cleanNote = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const note = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  return note || undefined;
};

/** The card suggest_presets posts (one per turn: a second call replaces the first). */
export function stylePresetsCard(presetIds: string[], note?: string): Extract<Card, { type: 'style_presets' }> {
  return { type: 'style_presets', id: newId('card'), presetIds, ...(note ? { note } : {}) };
}

function suggestPresetsTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'suggest_presets',
    'free',
    'Show curated art styles as a visual card the user can tap (no images are drawn, nothing is spent). Omit presetIds to show the best fits for this story. For WHICH look fits; an ask to see drawn looks is propose_styles.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        presetIds: {
          type: 'array',
          items: { type: 'string', enum: STYLE_PRESETS.map((p) => p.id) },
          minItems: 1,
          maxItems: MAX_SUGGESTED_PRESETS,
          description: 'Preset ids to show, best first (1–6). Omit to use the story-fit ranking.'
        },
        note: { type: 'string', description: 'One short line shown above the styles (≤ 200 chars).' }
      }
    },
    (args) => {
      // An ask to SEE drawn looks is not answered with clip art (stylepick SC-0): a deterministic redirect, no model
      // judgement. The free card stays for "which look fits?".
      const ask = styleLooksAsk(turn.userText);
      if (ask) {
        throw toolArgError(
          `The user asked to see drawn looks. Call propose_styles with count ${ask.count} (and presetIds or directions only for looks they named). It shows the price and waits for their Approve.`
        );
      }
      const doc = ctx.session.doc;
      const ids = parsePresetIds(doc, args.presetIds);
      const note = cleanNote(args.note);
      const card = stylePresetsCard(ids, note);
      const existing = turn.cards.findIndex((c) => c.type === 'style_presets');
      if (existing >= 0) turn.cards.splice(existing, 1, card);
      else turn.cards.push(card);
      const names = ids.map((id) => getStylePreset(id)!.name);
      return `Showing ${names.length} style${names.length === 1 ? '' : 's'} as a card: ${names.join(', ')}. Tapping one sets it (${FREE_NOTE.toLowerCase().replace(/\.$/, '')}). Say one short sentence about why these fit; don't list them again.`;
    }
  );
}

function usePresetTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'use_preset',
    'free',
    'Make one of the curated presets the comic\'s style (drafted, not locked). Free and instant: no images are drawn. Use when the user names or picks a preset ("watercolor storybook style").',
    {
      type: 'object',
      additionalProperties: false,
      required: ['presetId'],
      properties: {
        presetId: { type: 'string', enum: STYLE_PRESETS.map((p) => p.id), description: 'The preset id.' },
        withBoard: { type: 'boolean', description: "Also use the preset's library preview as the style anchor (only when enabled on the server)." }
      }
    },
    async (args) => {
      const presetId = typeof args.presetId === 'string' ? args.presetId.trim() : '';
      if (!getStylePreset(presetId)) throw toolArgError(`Unknown preset. Use one of: ${presetList()}.`);
      const started = await runUsePreset(
        ctx,
        { type: 'use_preset', presetId, ...(args.withBoard === true ? { withBoard: true } : {}) },
        { confirmed: true, origin: 'director', collectCard: (c) => turn.cards.push(c), collectNextSteps: (s) => turn.nextSteps.push(...s) }
      );
      return started.outcome.message;
    }
  );
}

const styleOpen = (doc: ComicDoc) => doc.style.status === 'empty' || doc.style.status === 'drafted';

export const libraryToolGroup: ToolGroup = {
  id: 'library',
  priority: 60,
  when: (ctx) => styleOpen(ctx.session.doc),
  tools: (ctx, turn) => [suggestPresetsTool(ctx, turn), usePresetTool(ctx, turn)],
  promptRules: (doc) =>
    styleOpen(doc)
      ? 'STYLE PRESETS: when the user asks which look fits, call suggest_presets (free; a visual card of curated looks). When the user asks to see, draw or generate looks or style options, call propose_styles instead (it waits for their Approve). When the user names or taps a preset, call use_preset (free).'
      : undefined,
  summaryLines: (doc) => {
    if (!styleOpen(doc)) return [];
    const top = rankPresets(doc)
      .slice(0, DEFAULT_SUGGESTED_PRESETS)
      .map((id) => getStylePreset(id)!.name);
    return [`Style presets that fit this story: ${top.join(', ')} (suggest_presets shows them free).`];
  },
  activity: { suggest_presets: 'Picking styles that fit', use_preset: 'Setting the style' }
};
