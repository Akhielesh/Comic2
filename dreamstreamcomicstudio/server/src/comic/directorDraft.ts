// A creator explicitly requested one private first draft. The action handler owns the
// durable reservation and takeover state. The creator approves a single itemized drawing run after the plan is ready.
import { DIRECTOR_DRAFT_IDEA_LIMIT, pageSpecHash, planInputHashOf, type ComicDoc } from '../../../shared/comic/doc.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import { offerDirectorDraftBook, pickDefaultPreset, planPages, presetStylePatch } from './jobs.js';
import { StudioError, type StudioContext } from './types.js';

const guidance = 'Adapt the supplied idea or script into the first editable comic draft. Choose coherent defaults for unspecified details, introduce only the cast the story needs, and give each page a clear beat and drawable panel descriptions. Keep stated characters, constraints, and ending.';

/** Match a direction to the studio, including a brief preceding a final “you decide”. */
export function delegatesComic(text: string): boolean {
  const directive = /^(?:(?:please|ok(?:ay)?)[, ]+)*(?:(?:you|u) (?:decide|choose|pick)(?: (?:the rest|everything|for me|what works best))?|(?:make|create|finish|draw) (?:the |my |this )?(?:whole |entire )?comic for me|take (?:the lead|it from here)|do (?:it all|the whole thing) for me)[.!\s]*$/i;
  return text.trim().split(/[.!\n]\s*|[,;]\s+(?=(?:you|u) (?:decide|choose|pick)\b)/i).some((part, i, parts) =>
    (i === 0 || parts.slice(i + 1).every(p => !p.trim())) && directive.test(part.trim()));
}

export function delegatedIdea(doc: ComicDoc, text: string): string {
  const previous = doc.conversation.filter(m => m.role === 'user' && m.text.trim()).slice(-12).map(m => m.text.trim());
  return [...previous, text].join('\n\n').slice(-DIRECTOR_DRAFT_IDEA_LIMIT);
}

/** Use an explicit format request when present; leave ordinary narrative numbers alone. */
function pagesForBrief(idea: string, current: number, maximum: number): number {
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const count = '(\\d{1,2}|' + words.join('|') + ')';
  const format = new RegExp('\\b' + count + '[- ]pages? (?:comic|manga|storybook|story|strip)\\b|\\b(?:in|make it|keep it to|length of) ' + count + ' pages?\\b', 'i').exec(idea);
  const token = (format?.[1] ?? format?.[2])?.toLowerCase();
  const requested = token ? Number(token) || words.indexOf(token) + 1 : current;
  return Math.min(maximum, Math.max(1, requested));
}

export async function runDirectorDraft(ctx: StudioContext, idea: string, screenNote?: string): Promise<{ pageId?: string }> {
  const session = ctx.session;
  const signal = session.abort.signal;
  const assertActive = () => {
    if (signal.aborted || ctx.signal.aborted || session.doc.directorDraft?.status !== 'planning') {
      throw new StudioError('CANCELLED', 'AI-led drafting stopped.', { status: 409 });
    }
    if (session.doc.gate?.status === 'open') {
      throw new StudioError('CONFLICT', 'Review the existing approval before starting a draft.', { status: 409 });
    }
  };
  assertActive();
  const before = session.doc;
  if (before.pages.length || before.planStatus !== 'none') {
    throw new StudioError('CONFLICT', 'This project already has a page plan. Open it to continue editing.', { status: 409 });
  }
  if (!idea.trim()) throw new StudioError('BAD_REQUEST', 'Enter an idea or script to start a draft.');
  const ops: DocOp[] = [];
  const pageCount = pagesForBrief(idea, before.format.pageCount, ctx.caps?.maxPages ?? DOC_LIMITS.pages);
  if (pageCount !== before.format.pageCount) ops.push({ op: 'format', patch: { pageCount } });
  const shortIdea = idea.trim().replace(/\s+/g, ' ');
  if (!before.source.script?.trim()) ops.push({ op: 'source', patch: { script: idea, updatedAt: Date.now() } });
  const title = !before.brief.title.trim() || /^untitled(?: comic)?$/i.test(before.brief.title.trim())
    ? shortIdea.split(/[.!?]\s|\n/)[0].split(/\s+/).slice(0, 9).join(' ').slice(0, 100)
    : undefined;
  if (title || !before.brief.premise) {
    ops.push({ op: 'brief', patch: { ...(title ? { title } : {}), ...(!before.brief.premise ? { premise: shortIdea.slice(0, 720) } : {}) } });
  }
  if (ops.length) session.commit(ops, { origin: 'director', label: 'Capture the draft idea' });
  const style = session.doc.style;
  if (style.status === 'empty' && !style.spec && !style.name && !style.refs.length && !style.options.length) {
    const preset = pickDefaultPreset(session.doc);
    const patch = presetStylePatch(preset, 'drafted');
    patch.avoid = [...new Set([...(style.avoid || []), ...preset.avoid])];
    session.commit([{ op: 'style', patch }], { origin: 'director', label: 'Choose a comic look' });
  }

  // Check the actual source, brief, format, cast, and visual decisions after each await.
  // Unrelated billing/activity events may advance the document revision while the writer runs.
  const inputHash = planInputHashOf(session.doc);
  const originalStyle = JSON.stringify(session.doc.style);
  const assertPlanUnchanged = () => {
    assertActive();
    if (session.doc.pages.length || session.doc.planStatus !== 'none' || planInputHashOf(session.doc) !== inputHash || JSON.stringify(session.doc.style) !== originalStyle) {
      throw new StudioError('CONFLICT', 'The project changed while the draft was being prepared. Your edits were kept.', { status: 409 });
    }
  };
  // Existing source is never replaced. The full added idea remains in directorDraft;
  // writePagePlan applies its usual long-source context policy to this combined input.
  const writerSource = before.source.script && before.source.script !== idea ? before.source.script + '\n\n' + idea : undefined;
  const instructions = [guidance, screenNote?.trim()].filter(Boolean).join('\n\n');
  const result = await planPages(ctx, { instructions }, { origin: 'director', draft: { assertActive, assertPlanUnchanged, writerSource } });
  assertActive();
  if (result.status !== 'done') throw new StudioError(result.status === 'blocked' && result.code ? result.code : 'CONFLICT', result.message);
  const page = [...session.doc.pages].sort((a, b) => a.n - b.n)[0];
  if (!page) throw new StudioError('PROVIDER_ERROR', 'The writer returned no pages. Your idea was saved.');
  const planSignature = () => JSON.stringify(session.doc.pages.map(p => [p.id, p.n, p.render.status, pageSpecHash(session.doc, p)]));
  const savedPlan = planSignature();
  await offerDirectorDraftBook(ctx, () => {
    assertActive();
    if (planSignature() !== savedPlan) {
      throw new StudioError('CONFLICT', 'Your page plan changed. Open the saved plan for a fresh drawing estimate.', { status: 409 });
    }
  });
  return { pageId: page.id };
}
