// Director tool group "refs" (contract §12.1/§12.2; refs.md §4.9, §6). Owner: P1-REFS.
//
//   attach_refs      FREE  file this turn's images (current + carried) on a character, place or the
//                          style; creates the owner when asked; labels views; picks the main photo
//   set_primary_ref  FREE  make a reference the main one (moves it first)
//   label_ref        FREE  name the view of references and add short notes
//   move_ref         FREE  "#3 is actually Bruno" — moves references to another owner, keeping metadata
//   remove_ref       FREE  remove references by position
//
// Phase gate: images this turn (current or carried) or any reference exists. Every result is an
// honest, deterministic sentence built from what was committed — counts against the caps, the main
// photo, the labels — and the model-sheet offer with its real price. These tools NEVER draw: a sheet
// is offered (quoted), never redrawn on upload; a ready sheet is never marked stale by an add.

import { newId, resolveCharacter, type Card, type CastKind, type Character, type ComicDoc, type RefAsset, type RefLabel, type RefOwner } from '../../../../shared/comic/doc.js';
import { applyOp, type DocOp } from '../../../../shared/comic/ops.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { formatUsd, resolveImageJob } from '../../../../shared/comic/models.js';
import { unitPrice } from '../../../../shared/comic/plan.js';
import { REF_LABELS, REF_LABELS_FOR, REF_LABEL_TEXT, REF_LIMITS, capFor, isRefLabel, refOwnerKey, refsOf, totalRefs } from '../../../../shared/comic/refs.js';
import { sheetRefs, sheetRefsChanged } from '../../../../shared/comic/refRanking.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import { sanitizeLook, spendIsByok } from '../jobs.js';
import { prefilterText } from '../safety/index.js';
import { turnImages, type DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';
import { cleanNote, limitMessage, numberRanges, ownerName, planRefAdds, plural, upperName } from '../refs/addRefs.js';
import { unassignedImages } from '../refs/carried.js';

// ── Arg helpers ──────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
};
const intList = (v: unknown): number[] =>
  [...new Set((Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(int).filter((n): n is number => n !== undefined))];

const CAST_KINDS: readonly CastKind[] = ['person', 'animal', 'creature', 'robot', 'toy', 'vehicle', 'object'];
const TIERS = ['lead', 'support', 'extra'] as const;

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const I = (description: string) => ({ type: 'integer', description });
const A = (items: Record<string, unknown>, description: string) => ({ type: 'array', items, description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

const ownerSchema = (description = 'Who the images belong to.') => ({
  type: 'object',
  description,
  properties: {
    kind: S('character, place or style', { enum: ['character', 'place', 'style'] }),
    id: S('Character/place id (optional).'),
    name: S('Character/place name (optional when id is given).')
  },
  required: ['kind']
});

const createSchema = {
  type: 'object',
  description: 'Create the character/place when it does not exist yet.',
  properties: {
    tier: S('Characters: lead, support or extra.', { enum: [...TIERS] }),
    role: S('Characters: their role in the story.'),
    kind: S('Characters: what they are.', { enum: [...CAST_KINDS] }),
    count: I('Characters: 2–12 for a group drawn as one ("three ducklings").'),
    look: {
      type: 'object',
      description: 'What you SEE in the photos, so identity holds even where no photo is sent.',
      properties: {
        summary: S('One dense, drawable visual sentence.'),
        species: S('Non-humans: what they are.'),
        markings: S('Non-humans: markings that never drift.'),
        hair: S('Hair / fur.'),
        outfit: S('Outfit.'),
        palette: S('Key colours.')
      }
    },
    description: S('Places: what the place looks like.')
  }
};

const LABEL_ENUM = [...REF_LABELS];

// ── Resolution ───────────────────────────────────────────────────────────────

const castList = (doc: ComicDoc) => (doc.cast.length ? doc.cast.map((c) => upperName(c.name)).join(', ') : '(none)');
const placeList = (doc: ComicDoc) => (doc.places.length ? doc.places.map((p) => upperName(p.name)).join(', ') : '(none)');

/** An owner argument → the owner (or undefined when it does not exist; throws on a malformed arg). */
const findOwner = (doc: ComicDoc, raw: unknown): { owner?: RefOwner; kind: 'character' | 'place' | 'style'; name: string } => {
  if (!isObject(raw)) throw toolArgError('owner must be {kind: "character"|"place"|"style", id?, name?}.');
  const kind = raw.kind === 'place' ? 'place' : raw.kind === 'style' ? 'style' : raw.kind === 'character' ? 'character' : undefined;
  if (!kind) throw toolArgError('owner.kind must be "character", "place" or "style".');
  if (kind === 'style') return { owner: { kind: 'style' }, kind, name: 'style' };
  const id = text(raw.id, 80);
  const name = text(raw.name, 80);
  if (!id && !name) throw toolArgError(`owner needs the ${kind}'s name or id.`);
  if (kind === 'character') {
    const c = (id && doc.cast.find((x) => x.id === id)) || (name ? resolveCharacter(doc, name) : undefined);
    return { ...(c ? { owner: { kind: 'character', id: c.id } } : {}), kind, name: c?.name || name || id };
  }
  const key = name.toLowerCase();
  const p = (id && doc.places.find((x) => x.id === id)) || (key ? doc.places.find((x) => x.name.trim().toLowerCase() === key) : undefined);
  return { ...(p ? { owner: { kind: 'place', id: p.id } } : {}), kind, name: p?.name || name || id };
};

/** Resolve an owner, creating it when `create` is given; returns the creation ops (not yet committed). */
const ownerOrCreate = (
  doc: ComicDoc,
  rawOwner: unknown,
  rawCreate: unknown
): { owner: RefOwner; createOps: DocOp[]; created?: string } => {
  const found = findOwner(doc, rawOwner);
  if (found.owner) return { owner: found.owner, createOps: [] };
  const wanted = found.name.trim().slice(0, 80);
  if (!isObject(rawCreate)) {
    throw toolArgError(
      found.kind === 'character'
        ? `No character named ${upperName(wanted)}. Cast: ${castList(doc)}. Pass create:{kind, tier, look} to add them.`
        : `No place named ${upperName(wanted)}. Places: ${placeList(doc)}. Pass create:{description} to add it.`
    );
  }
  if (!wanted) throw toolArgError('A new character or place needs a name.');
  if (found.kind === 'character') {
    if (doc.cast.length >= DOC_LIMITS.cast) throw toolArgError(`The cast is full (${DOC_LIMITS.cast}). Attach the images to an existing character instead.`);
    const kind = CAST_KINDS.includes(rawCreate.kind as CastKind) ? (rawCreate.kind as CastKind) : undefined;
    const tierArg = TIERS.includes(rawCreate.tier as (typeof TIERS)[number]) ? (rawCreate.tier as (typeof TIERS)[number]) : undefined;
    const tier = tierArg || (kind && kind !== 'person' ? 'support' : doc.cast.some((c) => c.tier === 'lead') ? 'support' : 'lead');
    const look = (sanitizeLook(rawCreate.look) || {}) as Record<string, string>;
    const count = int(rawCreate.count);
    const role = text(rawCreate.role, 200);
    const id = newId('c');
    const patch: Partial<Character> = {
      name: wanted,
      tier,
      look: { summary: '', ...look },
      ...(kind ? { kind } : {}),
      ...(role ? { role } : {}),
      ...(count !== undefined && count >= 2 ? { count: Math.min(12, count) } : {})
    };
    return { owner: { kind: 'character', id }, createOps: [{ op: 'character', id, patch }], created: `Created ${upperName(wanted)} (${[tier, kind && kind !== 'person' ? kind : ''].filter(Boolean).join(', ')}).` };
  }
  if (doc.places.length >= DOC_LIMITS.places) throw toolArgError(`The story already has ${DOC_LIMITS.places} places. Attach the images to an existing place instead.`);
  const id = newId('pl');
  const description = text(rawCreate.description, 1500) || text(isObject(rawCreate.look) ? rawCreate.look.summary : '', 1500);
  return { owner: { kind: 'place', id }, createOps: [{ op: 'place', id, patch: { name: wanted, look: description } }], created: `Created the place ${upperName(wanted)}.` };
};

/** Positions (1-based) in an owner's list → refs; throws an honest error listing what exists. */
const refsAt = (doc: ComicDoc, owner: RefOwner, raw: unknown, what = 'refs'): RefAsset[] => {
  const list = refsOf(doc, owner) || [];
  const ns = intList(raw);
  if (!ns.length) throw toolArgError(`${what} must list positions (1 = the main photo).`);
  const bad = ns.filter((n) => n < 1 || n > list.length);
  if (bad.length) {
    throw toolArgError(
      list.length
        ? `${ownerName(doc, owner)} has ${plural(list.length, 'reference')} (use 1–${list.length}); there is no ${numberRanges(bad)}.`
        : `${ownerName(doc, owner)} has no references yet.`
    );
  }
  return ns.map((n) => list[n - 1]);
};

/** The label a director may set for this owner (character labels for characters, …). */
const labelFor = (owner: RefOwner, raw: unknown): RefLabel | undefined => {
  if (!isRefLabel(raw)) return undefined;
  if (owner.kind === 'inbox') return raw;
  const allowed = REF_LABELS_FOR[owner.kind];
  return allowed.includes(raw) ? raw : 'other';
};

/** A director-written note, screened by the free pre-filter (a blocked note is dropped, never stored). */
const noteFor = (raw: unknown, ctx: StudioContext): string | undefined => {
  const note = cleanNote(raw);
  if (!note) return undefined;
  try {
    if (prefilterText(note, ctx.rating ?? 'PG-13').decision === 'block') return undefined;
  } catch {
    /* the pre-filter never throws in practice; a failure keeps the note out */
    return undefined;
  }
  return note;
};

// ── Sheet offer (quoted, never drawn) ────────────────────────────────────────

const sheetSlots = (doc: ComicDoc): number => {
  const spec = resolveImageJob('sheet', doc.settings.quality, doc.settings.imageModelOverride).spec;
  return spec.refs.characters > 0 ? spec.refs.characters : spec.refs.objects;
};

const sheetPrice = (ctx: StudioContext, doc: ComicDoc): string => {
  try {
    return formatUsd(unitPrice(doc, 'sheet', { byok: spendIsByok(ctx.keys) }).usd);
  } catch {
    return 'a few cents';
  }
};

/** The sentence that offers (never draws) a model sheet after photos changed. */
export const sheetOffer = (ctx: StudioContext, doc: ComicDoc, c: Character | undefined): string => {
  if (!c || c.tier === 'extra' || !c.refs.length) return '';
  const name = upperName(c.name);
  const price = sheetPrice(ctx, doc);
  if (c.sheet.status === 'ready' && c.sheet.asset) {
    return sheetRefsChanged(c, sheetSlots(doc))
      ? ` ${name}'s sheet was drawn from older photos — offer a redraw with the new ones (≈ ${price}); it stays as it is until the user asks.`
      : '';
  }
  if (c.sheet.status === 'queued' || c.sheet.status === 'rendering') return ` ${name}'s sheet is drawing now.`;
  return ` No sheet yet — offer "Draw ${name}'s model sheet from these photos · ≈ ${price}" (never draw it unasked).`;
};

/** One live `refs` card per owner per turn (merged when the director attaches twice). */
const pushRefsCard = (turn: DirectorTurn, owner: RefOwner, paths: string[]) => {
  if (!paths.length) return;
  const key = refOwnerKey(owner);
  const existing = turn.cards.find((c): c is Extract<Card, { type: 'refs' }> => c.type === 'refs' && refOwnerKey(c.owner) === key);
  if (existing) {
    for (const p of paths) if (!existing.paths.includes(p)) existing.paths.push(p);
    return;
  }
  turn.cards.push({ type: 'refs', id: newId('card'), owner, paths: [...paths] });
};

const labelWord = (l?: RefLabel) => (l ? REF_LABEL_TEXT[l].toLowerCase() : '');

// ── Tools ────────────────────────────────────────────────────────────────────

function attachRefsTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'attach_refs',
    'free',
    'Attach images to a character, place or the style. images = image numbers from this turn ("Attached image N"; numbers continue for earlier unassigned images). Creates the owner when create is set. Label every view you can see; main = the clearest front-facing image. Never draws anything.',
    schema(
      {
        images: A({ type: 'integer' }, 'Image numbers (1-based).'),
        owner: ownerSchema(),
        create: createSchema,
        labels: A(
          {
            type: 'object',
            properties: { image: I('Image number'), label: S('The view.', { enum: LABEL_ENUM }), note: S('≤140 chars, e.g. "her festival outfit".') },
            required: ['image']
          },
          'Per-image view labels / notes.'
        ),
        main: I('Image number to make the main reference (moves it first).')
      },
      ['images', 'owner']
    ),
    async (args) => {
      const images = turnImages(turn);
      if (!images.length) throw toolArgError('No images are attached this turn or waiting from the previous message.');
      const numbers = intList(args.images);
      if (!numbers.length) throw toolArgError(`images must list image numbers (1–${images.length}).`);
      const out = numbers.filter((n) => n < 1 || n > images.length);
      if (out.length) throw toolArgError(`There ${images.length === 1 ? 'is only 1 image' : `are only ${images.length} images`} this turn (use 1–${images.length}).`);
      let doc = ctx.session.doc;
      const { owner, createOps, created } = ownerOrCreate(doc, args.owner, args.create);
      for (const op of createOps) doc = applyOp(doc, op);
      const refs = numbers.map((n) => ({ ...images[n - 1], addedBy: images[n - 1].addedBy ?? 'user' }) as RefAsset);
      const labels: Record<number, { label?: RefLabel; note?: string }> = {};
      const labelNotes: string[] = [];
      for (const item of Array.isArray(args.labels) ? args.labels : []) {
        if (!isObject(item)) continue;
        const at = numbers.indexOf(int(item.image) ?? -1);
        if (at < 0) continue;
        const label = labelFor(owner, item.label);
        const note = noteFor(item.note, ctx);
        if (!label && !note) continue;
        labels[at] = { ...(label ? { label } : {}), ...(note ? { note } : {}) };
        if (label) labelNotes.push(`#${numbers[at]} ${labelWord(label)}`);
      }
      const mainNumber = int(args.main);
      const mainIndex = mainNumber !== undefined ? numbers.indexOf(mainNumber) : -1;
      const planned = planRefAdds(doc, owner, refs, { labels, ...(mainIndex >= 0 ? { mainIndex } : {}) });
      const ops = [...createOps, ...planned.ops];
      if (!ops.length) return `${planned.message}${owner.kind === 'character' ? sheetOffer(ctx, doc, doc.cast.find((c) => c.id === owner.id)) : ''}`;
      ctx.session.commit(ops, { origin: 'director', label: 'Attach photos' });
      const after = ctx.session.doc;
      const name = ownerName(after, owner) || 'it';
      pushRefsCard(turn, owner, planned.refs.map((r) => r.path));
      if (planned.added) turn.captured.push(`${plural(planned.added, 'photo')} → ${name}`);
      const details: string[] = [];
      if (mainIndex >= 0 && planned.refs.some((r) => r.path === refs[mainIndex].path)) {
        const l = labels[mainIndex]?.label;
        details.push(`main: #${numbers[mainIndex]}${l ? ` ${labelWord(l)}` : ''}`);
      } else if (mainIndex >= 0 && planned.ops.some((o) => o.op === 'ref_move')) {
        details.push(`#${numbers[mainIndex]}, already there, is now the main photo`);
      }
      if (labelNotes.length) details.push(`labels: ${labelNotes.join(', ')}`);
      const message = planned.message.replace(/\.$/, details.length ? ` (${details.join('; ')}).` : '.');
      const total = (refsOf(after, owner) || []).length;
      const capNote = total >= capFor(owner) ? ` ${name} is now at the ${capFor(owner)}-photo limit.` : '';
      const offer = owner.kind === 'character' ? sheetOffer(ctx, after, after.cast.find((c) => c.id === owner.id)) : '';
      return [created, message].filter(Boolean).join(' ') + capNote + offer;
    }
  );
}

function setPrimaryTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'set_primary_ref',
    'free',
    "Make one of an owner's references the main one (it moves first and leads every pick).",
    schema({ owner: ownerSchema('Whose references.'), ref: I('Position in that owner’s list (1 = current main), as in the doc summary.') }, ['owner', 'ref']),
    async (args) => {
      const doc = ctx.session.doc;
      const { owner } = findOwner(doc, args.owner);
      if (!owner) throw toolArgError(`No such ${isObject(args.owner) ? String(args.owner.kind) : 'owner'}. Cast: ${castList(doc)}. Places: ${placeList(doc)}.`);
      const [ref] = refsAt(doc, owner, args.ref, 'ref');
      const name = ownerName(doc, owner);
      if ((refsOf(doc, owner) || [])[0]?.path === ref.path) return `#1 is already ${name}'s main reference.`;
      ctx.session.commit([{ op: 'ref_move', owner, path: ref.path, to: 0 }], { origin: 'director', label: 'Make main photo' });
      const after = ctx.session.doc;
      const offer = owner.kind === 'character' ? sheetOffer(ctx, after, after.cast.find((c) => c.id === owner.id)) : '';
      return `${name}'s main reference is now the${ref.label ? ` ${labelWord(ref.label)}` : ''} photo (it was #${int(args.ref)}).${offer}`;
    }
  );
}

function labelRefTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'label_ref',
    'free',
    'Name the view of references (front, side, face, outfit…) and add short notes. Labels steer which photos reach the image model.',
    schema(
      {
        owner: ownerSchema('Whose references.'),
        items: A(
          {
            type: 'object',
            properties: { ref: I('Position (1 = main).'), label: S('The view.', { enum: LABEL_ENUM }), note: S('≤140 chars; empty clears it.') },
            required: ['ref']
          },
          'What to set.'
        )
      },
      ['owner', 'items']
    ),
    async (args) => {
      const doc = ctx.session.doc;
      const { owner } = findOwner(doc, args.owner);
      if (!owner) throw toolArgError(`No such owner. Cast: ${castList(doc)}. Places: ${placeList(doc)}.`);
      const list = refsOf(doc, owner) || [];
      const ops: DocOp[] = [];
      const done: string[] = [];
      for (const item of Array.isArray(args.items) ? args.items : []) {
        if (!isObject(item)) continue;
        const [ref] = refsAt(doc, owner, item.ref, 'ref');
        const patch: Record<string, unknown> = {};
        const label = labelFor(owner, item.label);
        if (label) patch.label = label;
        if (typeof item.note === 'string') patch.note = item.note.trim() ? noteFor(item.note, ctx) ?? null : null;
        if (!Object.keys(patch).length) continue;
        ops.push({ op: 'ref_patch', owner, path: ref.path, patch });
        done.push(`#${list.indexOf(ref) + 1}${label ? ` ${labelWord(label)}` : ''}${patch.note ? ' (note)' : ''}`);
      }
      if (!ops.length) throw toolArgError('items must set a label or a note for at least one reference.');
      ctx.session.commit(ops, { origin: 'director', label: 'Label photos' });
      return `Labeled ${ownerName(doc, owner)}'s references: ${done.join(', ')}.`;
    }
  );
}

function moveRefTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'move_ref',
    'free',
    'Move references from one owner to another ("#3 is actually Bruno"), keeping their labels. Creates the destination when create is set.',
    schema(
      {
        from: ownerSchema('Where the references are now.'),
        to: ownerSchema('Where they belong.'),
        refs: A({ type: 'integer' }, 'Positions in from’s list (1 = main).'),
        create: createSchema
      },
      ['from', 'to', 'refs']
    ),
    async (args) => {
      let doc = ctx.session.doc;
      const { owner: from } = findOwner(doc, args.from);
      if (!from) throw toolArgError(`No such source. Cast: ${castList(doc)}. Places: ${placeList(doc)}.`);
      const moving = refsAt(doc, from, args.refs);
      const { owner: to, createOps, created } = ownerOrCreate(doc, args.to, args.create);
      if (refOwnerKey(from) === refOwnerKey(to)) throw toolArgError('from and to are the same owner — use set_primary_ref to reorder.');
      for (const op of createOps) doc = applyOp(doc, op);
      const room = capFor(to) - (refsOf(doc, to) || []).length;
      const ops: DocOp[] = [...createOps];
      let moved = 0;
      let already = 0;
      for (const ref of moving) {
        if ((refsOf(doc, to) || []).some((r) => r.path === ref.path)) {
          // Already on the destination: just take it off the source.
          ops.push({ op: 'ref_remove', owner: from, path: ref.path });
          already += 1;
          continue;
        }
        if (moved >= room) continue;
        ops.push({ op: 'ref_transfer', from, to, path: ref.path });
        moved += 1;
      }
      const left = moving.length - moved - already;
      if (ops.length === createOps.length && !already) return limitMessage(doc, to);
      ctx.session.commit(ops, { origin: 'director', label: 'Move photos' });
      const after = ctx.session.doc;
      const toName = ownerName(after, to);
      const fromName = ownerName(after, from);
      if (moved) pushRefsCard(turn, to, moving.slice(0, moved).map((r) => r.path));
      const parts = [created, `Moved ${plural(moved + already, 'photo')} from ${fromName} to ${toName}.`];
      if (left > 0) parts.push(`${plural(left, 'photo')} stayed on ${fromName}: ${limitMessage(after, to)}`);
      const offer = to.kind === 'character' ? sheetOffer(ctx, after, after.cast.find((c) => c.id === to.id)) : '';
      return parts.filter(Boolean).join(' ') + offer;
    }
  );
}

function removeRefTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'remove_ref',
    'free',
    'Remove references by position (only when the user asks). The photos stay in the conversation.',
    schema({ owner: ownerSchema('Whose references.'), refs: A({ type: 'integer' }, 'Positions to remove (1 = main).') }, ['owner', 'refs']),
    async (args) => {
      const doc = ctx.session.doc;
      const { owner } = findOwner(doc, args.owner);
      if (!owner) throw toolArgError(`No such owner. Cast: ${castList(doc)}. Places: ${placeList(doc)}.`);
      const gone = refsAt(doc, owner, args.refs);
      ctx.session.commit(
        gone.map((r): DocOp => ({ op: 'ref_remove', owner, path: r.path })),
        { origin: 'director', label: 'Remove photos' }
      );
      const left = (refsOf(ctx.session.doc, owner) || []).length;
      return `Removed ${plural(gone.length, 'photo')} from ${ownerName(doc, owner)} (${left} left).`;
    }
  );
}

// promptRules(doc) has no turn argument: remember which turn this doc snapshot was gated for.
const turnByDoc = new WeakMap<ComicDoc, DirectorTurn>();

// ── Summary lines and prompt rules ───────────────────────────────────────────

/** "1★ front, 2 outfit, 3 face (+2) — sheet drawn from 1–3" */
export const refsLine = (doc: ComicDoc, refs: RefAsset[], c?: Character): string => {
  const shown = refs.slice(0, 6).map((r, i) => `${i + 1}${i === 0 ? '★' : ''}${r.label ? ` ${labelWord(r.label)}` : ''}${r.note ? ` ("${r.note.slice(0, 40)}")` : ''}`);
  const more = refs.length > 6 ? ` (+${refs.length - 6})` : '';
  let sheet = '';
  if (c && c.sheet.status === 'ready' && c.sheet.refPaths?.length) {
    const used = c.sheet.refPaths.map((p) => refs.findIndex((r) => r.path === p) + 1).filter((n) => n > 0);
    sheet = used.length ? ` — sheet drawn from ${numberRanges(used)}` : ' — sheet drawn from photos no longer here';
    if (sheetRefsChanged(c, sheetSlots(doc))) sheet += ' (new photos since)';
  } else if (c && c.tier !== 'extra' && c.sheet.status !== 'ready') {
    const k = Math.min(REF_LIMITS.sheetAuthorRefs, sheetSlots(doc));
    const would = sheetRefs(c, k).map((r) => refs.indexOf(r) + 1).filter((n) => n > 0);
    if (would.length) sheet = ` — no sheet yet (would use ${numberRanges(would)})`;
  }
  return `${shown.join(', ')}${more}${sheet}`;
};

export function refsSummaryLines(doc: ComicDoc, turn?: DirectorTurn): string[] {
  const lines: string[] = [];
  const owners: string[] = [];
  for (const c of doc.cast) if (c.refs.length) owners.push(`${upperName(c.name)}: ${refsLine(doc, c.refs, c)}`);
  for (const p of doc.places) if (p.refs.length) owners.push(`${upperName(p.name)} (place): ${refsLine(doc, p.refs)}`);
  if (doc.style.refs.length) owners.push(`STYLE: ${refsLine(doc, doc.style.refs)}`);
  if (owners.length) {
    lines.push(`REFERENCES (${totalRefs(doc)}/${REF_LIMITS.project}; ★ = main; positions for set_primary_ref/label_ref/move_ref/remove_ref):`);
    lines.push(...owners.slice(0, 12).map((l) => `- ${l}`));
    if (owners.length > 12) lines.push(`- …and ${owners.length - 12} more owners with references`);
  }
  if (turn) {
    const images = turnImages(turn);
    const open = unassignedImages(doc, images);
    if (open.length) {
      const current = turn.attachments.length;
      const nums = images.map((r, i) => (open.some((o) => o.path === r.path) ? i + 1 : 0)).filter((n) => n > 0);
      const carried = nums.filter((n) => n > current);
      lines.push(
        `UNASSIGNED IMAGES this turn: ${numberRanges(nums)}${carried.length ? ` (${numberRanges(carried)} from the user's previous message, still unassigned)` : ''} — file them with attach_refs.`
      );
    }
  }
  return lines;
}

const RULES_WITH_IMAGES = [
  'IMAGES: Images in the user\'s turn are numbered "Attached image N" (earlier unassigned images continue the numbering).',
  'Assign EVERY image with attach_refs to the character, place or style the user means; create the character when new (create: kind/tier/look).',
  'Label each view you can see (front, side, full_body, face, outfit, expression…) and make the clearest front-facing image the main one.',
  'Write what you see (face, hair/fur, markings, build, outfit, colours) into the look fields, so identity holds even where no photo is sent.',
  'Then confirm in ONE friendly sentence what went where, mentioning anything odd ("#4 looks like a dog — is that BRUNO?").',
  "If you can't tell who an image is, ask ONE ask_user question whose options are the likely owners.",
  'Never draw on upload: offer the model sheet with its price (the attach_refs result has it).'
].join(' ');

const RULES_REFS_ONLY =
  'REFERENCES: positions are 1-based per owner (1 = main, see REFERENCES). Use set_primary_ref / label_ref / move_ref / remove_ref only when the user asks; a sheet redraw after new photos is offered with its price, never done unasked.';

export const refsToolGroup: ToolGroup = {
  id: 'refs',
  priority: 15,
  when: (ctx, turn) => {
    turnByDoc.set(ctx.session.doc, turn);
    return turnImages(turn).length > 0 || totalRefs(ctx.session.doc) > 0;
  },
  tools: (ctx, turn) => {
    const doc = ctx.session.doc;
    turnByDoc.set(doc, turn);
    const tools: DirectorTool[] = [];
    if (turnImages(turn).length) tools.push(attachRefsTool(ctx, turn));
    if (totalRefs(doc) - (doc.refInbox?.length || 0) > 0 || turnImages(turn).length) {
      tools.push(setPrimaryTool(ctx), labelRefTool(ctx), moveRefTool(ctx, turn), removeRefTool(ctx));
    }
    return tools;
  },
  promptRules: (doc) => {
    const turn = turnByDoc.get(doc);
    const images = turn ? turnImages(turn).length > 0 : totalRefs(doc) === 0;
    const anyRefs = totalRefs(doc) > 0;
    return [images ? RULES_WITH_IMAGES : '', anyRefs ? RULES_REFS_ONLY : ''].filter(Boolean).join('\n') || undefined;
  },
  summaryLines: (doc, turn) => refsSummaryLines(doc, turn),
  activity: {
    attach_refs: 'Filing your photos',
    set_primary_ref: 'Choosing the main photo',
    label_ref: 'Labeling photos',
    move_ref: 'Moving photos',
    remove_ref: 'Removing photos'
  }
};
