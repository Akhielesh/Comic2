// Refine strategy for a library asset that missed its threshold (assets.md §4.4). Chosen by
// RULES, not by a model: a free re-request for a shape miss, a targeted edit pass for local
// defects (stray text, a misspelled title), a corrected prompt for composition/style misses,
// and an LLM prompt rewrite only on the last attempt when the brief or style match stays weak.

import { getImageModel } from '../../../../shared/comic/models.js';
import type { LibraryRefineStrategy } from '../../../../shared/comic/library.js';
import { completeStructured } from '../writer.js';
import type { LlmClient } from '../types.js';
import { NO_TEXT, isTextFree, type LibraryManifestEntry } from './manifest.js';
import type { LibraryIssueCode, MergedLibraryScore } from './analyze.js';

export type RefinePlan =
  | { strategy: 'rerequest' }
  | { strategy: 'edit'; instruction: string; fromRev: number }
  | { strategy: 'regenerate'; prompt: string }
  | { strategy: 'rewrite'; prompt: string; issues: string[] }
  | { strategy: 'stop'; reason: string };

export type NextAttempt = Exclude<RefinePlan, { strategy: 'stop' }> | { strategy: 'first' };

/** Est. cost of one prompt rewrite (writer role, ~1.5k tokens). */
export const REWRITE_USD = 0.005;

const EDITABLE: ReadonlySet<LibraryIssueCode> = new Set(['text', 'title']);
const quoteSafe = (s: string) => s.replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();

/** Deterministic edit instruction for local defects ("change nothing else"). */
export function editInstruction(entry: LibraryManifestEntry, merged: Pick<MergedLibraryScore, 'codes' | 'notes'>): string {
  const parts: string[] = [];
  if (merged.codes.includes('title') && entry.expectedText?.length) {
    parts.push(`Re-letter the title exactly as '${entry.expectedText.join(' ')}'`);
    parts.push('remove any other lettering, signatures and watermarks');
  } else if (merged.codes.includes('text')) {
    parts.push('Remove all lettering, signage text, signatures and watermarks');
  }
  if (merged.codes.includes('technical')) parts.push('fix malformed hands, faces and smudged areas');
  const head = parts.length ? parts[0] : 'Fix the visible defects';
  const rest = parts.slice(1);
  return `${[head, ...rest].join('; ')}; change nothing else.`;
}

/** Corrections appended to the prompt, one line per issue code (assets.md §4.4 rule 3). */
export function corrections(entry: LibraryManifestEntry, merged: MergedLibraryScore): string[] {
  const lines: string[] = [];
  for (const code of merged.codes) {
    switch (code) {
      case 'panels':
        if (entry.panels) lines.push(`Exactly ${entry.panels} panels as listed; do not merge or add panels.`);
        break;
      case 'theme':
        lines.push(
          entry.theme === 'dark'
            ? 'The overall image must be dark: a deep charcoal ground, low contrast, no large light areas.'
            : 'The overall image must be light: a warm off-white ground, airy and bright, no large dark areas.'
        );
        break;
      case 'text':
        lines.push('Absolutely no text, letters, numbers, signatures or watermarks anywhere in the image.');
        break;
      case 'title':
        if (entry.expectedText?.length) lines.push(`The only text is the title '${entry.expectedText.join(' ')}', spelled exactly, once.`);
        break;
      case 'aspect':
        lines.push(`Compose for a ${entry.aspect} frame, filling it edge to edge.`);
        break;
      case 'blank':
        lines.push('Draw the full scene with clear subjects; never a blank or near-empty frame.');
        break;
      case 'style':
        lines.push('Match the described style traits exactly: the linework, colour treatment and shading named above.');
        break;
      case 'technical':
        lines.push('Clean anatomy: correct hands, faces and limbs; no smudged, muddy or melted areas.');
        break;
      case 'brief':
        if (entry.mustHave?.length) lines.push(`Must clearly show: ${entry.mustHave.join('; ')}.`);
        break;
      default:
        break;
    }
  }
  for (const note of merged.notes.slice(-3)) {
    const clean = quoteSafe(note).slice(0, 120);
    if (clean && !lines.some((l) => l.includes(clean))) lines.push(`Fix: ${clean}.`.replace(/\.\.$/, '.'));
  }
  return [...new Set(lines)].slice(0, 10);
}

/** The corrected prompt: subject first when the brief match is weak, then a Corrections block. */
export function correctedPrompt(entry: LibraryManifestEntry, basePrompt: string, merged: MergedLibraryScore): string {
  let prompt = basePrompt;
  if (merged.codes.includes('brief') && entry.subject && !prompt.startsWith(entry.subject)) prompt = `${entry.subject}\n${prompt}`;
  const lines = corrections(entry, merged);
  return lines.length ? `${prompt}\nCorrections:\n${lines.map((l) => `- ${l}`).join('\n')}` : prompt;
}

/**
 * Pick the next attempt. `attempt` is the attempt that just finished (1-based); `maxAttempts` is
 * 1 + maxRetries. Returns `stop` when no further attempt should run.
 */
export function planRefine(
  entry: LibraryManifestEntry,
  merged: MergedLibraryScore,
  ctx: { attempt: number; maxAttempts: number; basePrompt: string; rev: number; blankBefore?: boolean }
): RefinePlan {
  if (ctx.attempt >= ctx.maxAttempts) return { strategy: 'stop', reason: 'No attempts left; kept the best candidate for review.' };
  if (merged.codes.includes('blank') && ctx.blankBefore) return { strategy: 'stop', reason: 'The model returned a blank image twice.' };
  const codes = merged.codes.filter((c) => c !== 'seam' && c !== 'analysis');
  if (merged.codes.includes('analysis') && !codes.length) {
    // The check itself failed: a fresh draw costs money and proves nothing; a human looks instead.
    return { strategy: 'stop', reason: "The automatic check couldn't read the image; review it by eye." };
  }
  // 1. Shape only → same prompt, same params (the aspect is a request parameter).
  if (codes.length === 1 && codes[0] === 'aspect') return { strategy: 'rerequest' };
  // 2. Local defects only (stray text, title, small technical) → an edit pass on the same image.
  const spec = getImageModel(entry.model);
  const canEdit = !!spec && (spec.edit === 'excellent' || spec.edit === 'good');
  const onlyLocal = codes.length > 0 && codes.every((c) => EDITABLE.has(c) || (c === 'technical' && merged.score >= 0.6));
  if (canEdit && onlyLocal) return { strategy: 'edit', instruction: editInstruction(entry, merged), fromRev: ctx.rev };
  // 3. Composition / style / brief failures → corrected prompt; the LAST attempt may get an LLM rewrite.
  const prompt = correctedPrompt(entry, ctx.basePrompt, merged);
  const weak = merged.scores.briefMatch < 0.6 || merged.scores.styleMatch < 0.6;
  if (weak && ctx.attempt >= 2) return { strategy: 'rewrite', prompt, issues: corrections(entry, merged) };
  return { strategy: 'regenerate', prompt };
}

/** The prompt an edit pass sends with the previous image attached as reference 1. */
export const editPrompt = (entry: LibraryManifestEntry, instruction: string): string =>
  [
    'Edit the attached CURRENT IMAGE.',
    instruction,
    isTextFree(entry) ? NO_TEXT : `The only text allowed is '${(entry.expectedText || []).join(' ')}'.`,
    'Keep the composition, characters, colours and style identical.'
  ].join('\n');

/** Keep NO_TEXT and the style spec verbatim in any rewritten prompt (appended when the model dropped them). */
export function guardRewrite(entry: LibraryManifestEntry, original: string, rewritten: string, styleSpec?: string): string {
  let out = rewritten.replace(/\s+\n/g, '\n').trim().slice(0, 1200);
  if (styleSpec && !out.includes(styleSpec)) out = `${out}\nStyle: ${styleSpec}`;
  if (isTextFree(entry) && !out.includes(NO_TEXT)) out = `${out}\n${NO_TEXT}`;
  if (entry.expectedText?.length) {
    for (const t of entry.expectedText) if (!out.includes(t)) out = `${out}\nThe title '${t}' appears exactly once.`;
  }
  return out.length >= 40 ? out : original;
}

/**
 * One writer-role call that rewrites a prompt that keeps missing its brief (≈ $0.005). Falls back
 * to the deterministic corrected prompt when the reply is unusable or the call fails.
 */
export async function rewritePrompt(
  llm: LlmClient,
  args: { entry: LibraryManifestEntry; prompt: string; issues: string[]; styleSpec?: string; signal?: AbortSignal }
): Promise<{ prompt: string; costUsd?: number; model: string; rewritten: boolean }> {
  try {
    const out = await completeStructured<string>({
      llm,
      role: 'writer',
      system:
        'You rewrite image-generation prompts for a comic app so the next image matches its brief. Keep every subject, the composition, the style ' +
        'description and the no-text rule word for word; make the must-have subjects impossible to miss; fix the listed problems. Never name an artist, studio, ' +
        'brand or franchise. At most 1200 characters. Reply with JSON {"prompt": "..."} only.',
      user: `PROMPT:\n${args.prompt}\n\nPROBLEMS:\n${args.issues.map((i) => `- ${i}`).join('\n') || '- weak match to the brief'}`,
      schemaName: 'library_prompt',
      schema: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string' } } },
      validate: (json) => {
        const p = typeof (json as { prompt?: unknown })?.prompt === 'string' ? ((json as { prompt: string }).prompt || '').trim() : '';
        if (p.length < 40) return { problems: ['prompt must be a full prompt of 40–1200 characters.'] };
        return { value: p.slice(0, 1200), problems: p.length > 1200 ? ['Keep the prompt under 1200 characters.'] : [] };
      },
      failure: "The prompt couldn't be rewritten.",
      fallback: () => '',
      temperature: 0.3,
      maxTokens: 700,
      signal: args.signal
    });
    if (!out.value) return { prompt: args.prompt, costUsd: out.costUsd, model: out.model, rewritten: false };
    return { prompt: guardRewrite(args.entry, args.prompt, out.value, args.styleSpec), costUsd: out.costUsd, model: out.model, rewritten: true };
  } catch {
    return { prompt: args.prompt, model: '', rewritten: false };
  }
}

/** Planned extra text spend of an attempt (for the budget check). */
export const plannedTextUsd = (next: NextAttempt | null | undefined): number => (next?.strategy === 'rewrite' ? REWRITE_USD : 0);

export const strategyOf = (next: NextAttempt | null | undefined): LibraryRefineStrategy => (next ? next.strategy : 'first');
