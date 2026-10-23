// Director tool group "i18n" (contract §12.1/§12.2, i18n.md §9 as amended). Owner: P1-I18N.
//
//   translate_comic     PAID (quoted)  {languages, pages?, retranslate?, overwriteEdits?} → spend `translate`
//                                      ($0 when everything is cached: runs straight away, no gate)
//   set_comic_language  FREE / PAID    {language, mode: relabel | rewrite} → format / swap_source_language / translate
//   edit_translation    FREE           one translated line (status 'edited'), reports the balloon fit
//   read_translation    FREE           ≤ 6 KB: source → translation [status] gloss, stale/flag/fit markers
//   set_glossary        FREE           upsert terms; a changed form is renamed through the edition for $0
//
// Phase gate: language words in the turn, a non-English comic, or editions exist. No published list and
// no set_reader_languages: what readers can pick is the publication's job (editionReadiness gates it).

import type { ComicDoc, Line, Page } from '../../../../shared/comic/doc.js';
import { editionProgress, editionReadiness, i18nOf, lineSourceHash, normalizeSource, translationStatus } from '../../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import { formatUsd } from '../../../../shared/comic/models.js';
import type { DocOp, SpendAction } from '../../../../shared/comic/ops.js';
import { effectiveRating } from '../../../../shared/comic/safety.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { hashString } from '../../../../shared/comic/hash.js';
import { graphemes } from '../../../../shared/comic/textLayout.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { glossaryRenameOps, linesInOrder, planIsFree, translationBudget } from '../../../../shared/comic/translationPlan.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import { languageLabel, overlayFix, quoteTranslation, resolveLanguage, resolveLanguages, runTranslation, supportedLanguagesText, textlessCoverQuote } from '../i18n/index.js';
import { scriptShare } from '../i18n/translate.js';
import { swapSourceOps } from '../actions/i18n.js';
import { prefilterText } from '../safety/index.js';
import { startAction, type RunActionOptions } from '../jobs.js';
import { pushNextSteps, type DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';

const LANG_WORDS =
  /\b(translat\w*|languages?|telugu|hindi|tamil|kannada|malayalam|bengali|bangla|marathi|gujarati|punjabi|urdu|arabic|spanish|french|german|japanese|korean|chinese|mandarin|portuguese|indonesian|edition|glossary|subtitles?)\b|[ऀ-෿؀-ۿ぀-ヿ一-鿿가-힯]/i;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const englishName = (code: string) => languageSpec(code)?.english || code;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) && Math.round(n) === n ? n : undefined;
};

const langArg = (doc: ComicDoc, raw: unknown): string => {
  const code = resolveLanguage(raw);
  if (!code) throw toolArgError(`I don't know "${String(raw ?? '').slice(0, 40)}" as a language. ${supportedLanguagesText(doc)}`);
  return code;
};

const pagesArg = (doc: ComicDoc, raw: unknown): Page[] | undefined => {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const byN = new Map(doc.pages.map((p) => [p.n, p] as const));
  const pages: Page[] = [];
  const unknown: number[] = [];
  for (const v of list.slice(0, 200)) {
    const n = int(v);
    if (n === undefined || n < 1) throw toolArgError('pages must be page numbers like [1, 2].');
    const p = byN.get(n);
    if (p) pages.push(p);
    else unknown.push(n);
  }
  if (unknown.length) throw toolArgError(`There is no page ${unknown.join(', ')}. The comic has ${plural(doc.pages.length, 'page')}.`);
  return pages;
};

const ratingOf = (ctx: StudioContext) => ctx.rating ?? effectiveRating(ctx.session.doc, (ctx.caps ?? DEFAULT_CAPS).ratingCeiling).rating;

/** Start a quoted translate spend from the director (gated like any spend; $0 runs straight away). */
async function startTranslate(ctx: StudioContext, turn: DirectorTurn, action: Extract<SpendAction, { type: 'translate' }>): Promise<string> {
  const doc = ctx.session.doc;
  const quote = quoteTranslation(doc, ctx.keys, action);
  const opts: Omit<RunActionOptions, 'confirmed'> = {
    collectCard: (card) => {
      turn.cards.push(card);
    },
    collectNextSteps: (steps) => pushNextSteps(turn, steps),
    origin: 'director'
  };
  let message: string;
  // Free only when NO plan needs the translator or the linguist (a tiny quote that rounds to $0 still asks).
  if (quote.plans.every(planIsFree)) {
    // Nothing for a model to do: the free paths run now; there is nothing to approve.
    const started = await runTranslation(ctx, action, { ...opts, confirmed: true });
    void ctx.track(started.done);
    turn.outcome = started.outcome.status;
    message = started.outcome.message;
  } else {
    if (turn.gated) return 'Refused: a spend from this turn is already waiting for the user to approve it. Tell them the estimate and stop; continue after they approve.';
    // The user asked for languages in this turn → the policy decides; a proactive offer always asks.
    const asked = LANG_WORDS.test(turn.userText || '');
    const started = await startAction(ctx, action, { ...opts, confirmed: false, priorUsd: turn.spentUsd, ...(asked ? {} : { forceGate: 'no_intent' as const }) });
    const outcome = started.outcome;
    turn.outcome = outcome.status;
    if (outcome.status === 'started') turn.spentUsd += outcome.estimate.usd;
    else if (outcome.status === 'gated') turn.gated = true;
    void ctx.track(started.done);
    message = outcome.message;
  }
  const notes: string[] = [];
  const fix = overlayFix(ctx.session.doc, quote.byok);
  if (fix?.pages.length) {
    notes.push(
      `Note: the pages have the lettering painted into the art, so translated editions need overlay lettering (owner rule): redrawing ${plural(fix.pages.length, 'page')} without text costs ≈ ${formatUsd(fix.usd)} (ask before doing it; the Languages tab has the button).`
    );
  }
  const cover = textlessCoverQuote(ctx.session.doc, quote.byok);
  if (cover !== null) notes.push(`The cover title is painted; a textless cover with an editable per-language title is a one-time ≈ ${formatUsd(cover)} (render_cover textless, ask first).`);
  return [message, ...notes].join(' ');
}

// ── Tools ────────────────────────────────────────────────────────────────────

function translateComicTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'translate_comic',
    'paid',
    'Translate the comic into other languages so readers can pick theirs. Software reuses everything already translated for free; the rest goes to a writer-class translator and EVERY line gets a linguist review with a gloss. Quoted first; the gate handles approval. Never "translate" by rewriting lines with edit_panel_text.',
    {
      type: 'object',
      properties: {
        languages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 19, description: 'Codes or names: ["te", "Hindi", "తెలుగు"].' },
        pages: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Only these page numbers (default: the whole comic + titles).' },
        retranslate: { type: 'boolean', description: 'Translate again even lines that are up to date (costs money; only when the user asked).' },
        overwriteEdits: { type: 'boolean', description: "Also replace the author's own edited translations (only when the user asked)." }
      },
      required: ['languages'],
      additionalProperties: false
    },
    async (args) => {
      const doc = ctx.session.doc;
      const { codes, unknown, includedSource } = resolveLanguages(doc, args.languages);
      if (!codes.length) {
        if (includedSource) return `${englishName(doc.format.language)} is already the comic's language — nothing to translate. ${supportedLanguagesText(doc)}`;
        throw toolArgError(`${unknown.length ? `I don't know ${unknown.join(', ')} as a language. ` : ''}${supportedLanguagesText(doc)}`);
      }
      if (!doc.pages.some((p) => p.panels.some((panel) => panel.lines.some((l) => normalizeSource(l.text))))) {
        return 'There is no dialogue to translate yet — plan the pages first. To write the comic natively in another language, call set_comic_language with mode relabel before plan_pages.';
      }
      const pages = pagesArg(doc, args.pages);
      const action: Extract<SpendAction, { type: 'translate' }> = {
        type: 'translate',
        languages: codes,
        ...(pages?.length ? { pageIds: pages.map((p) => p.id) } : {}),
        ...(args.retranslate === true ? { force: true } : {}),
        ...(args.overwriteEdits === true ? { overwriteEdits: true } : {})
      };
      const out = await startTranslate(ctx, turn, action);
      return unknown.length ? `${out} (Skipped ${unknown.join(', ')}: not a language I know.)` : out;
    }
  );
}

function setComicLanguageTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'set_comic_language',
    'free',
    "Set the comic's own (source) language. relabel = the lines are already in that language or nothing is written yet (free; use it BEFORE plan_pages to write natively, e.g. a Telugu comic). rewrite = make an existing complete translation the source (free) or translate first (quoted).",
    {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Code or name ("te", "Telugu", "తెలుగు").' },
        mode: { type: 'string', enum: ['relabel', 'rewrite'] }
      },
      required: ['language', 'mode'],
      additionalProperties: false
    },
    async (args) => {
      const doc = ctx.session.doc;
      const lang = langArg(doc, args.language);
      const mode = args.mode === 'rewrite' ? 'rewrite' : 'relabel';
      if (sameLanguage(lang, doc.format.language)) return `${languageLabel(lang)} is already the comic's language.`;
      const edition = i18nOf(doc).editions[lang];
      const drawnInArt = doc.format.lettering === 'in_art' && doc.pages.some((p) => p.render.asset);
      if (mode === 'relabel') {
        if (edition) return `There is a ${englishName(lang)} translation already — call set_comic_language with mode rewrite to make it the source (free when it is complete).`;
        // Relabel only says what the lines ARE. Lines plainly written in another script would be
        // mislabelled (and never translated): that is a rewrite (quoted), not a relabel.
        const written = linesInOrder(doc).map(({ line }) => normalizeSource(line.text)).filter(Boolean).join(' ');
        if ((written.match(/\p{L}/gu) || []).length >= 12 && scriptShare(written, lang) < 0.5) {
          return `The lines are written in ${languageLabel(doc.format.language)}, not ${englishName(lang)}, so relabelling would mislabel them. Call set_comic_language with mode rewrite to translate them into ${englishName(lang)} (quoted first), or translate_comic to add ${englishName(lang)} for readers.`;
        }
        ctx.session.commit([{ op: 'format', patch: { language: lang } }], { origin: 'director' });
        const spec = languageSpec(lang)!;
        const warn = spec.script !== 'Latn' && doc.format.lettering === 'in_art' ? ' Image models often misspell non-Latin lettering painted into the art; overlay lettering keeps every word exact (set_format lettering overlay).' : '';
        return `The comic is now written in ${languageLabel(lang)} (free). New lines are written natively in ${spec.english}.${drawnInArt ? ' Drawn pages keep their painted lettering.' : ''}${warn}`;
      }
      const p = edition ? editionProgress(doc, lang) : undefined;
      if (edition && p && !p.missing && !p.stale && !p.staleEdited) {
        const ops: DocOp[] = swapSourceOps(doc, lang);
        ctx.session.commit(ops, { origin: 'director', label: `Make ${englishName(lang)} the source` });
        return `${languageLabel(lang)} is now the comic's language; ${languageLabel(doc.format.language)} became a reviewed translation (free). Other translations stay current.`;
      }
      const translated = await startTranslate(ctx, turn, { type: 'translate', languages: [lang] });
      return `${translated} Once the ${englishName(lang)} translation is complete, call set_comic_language rewrite again to make it the source (free).`;
    }
  );
}

/** Find a line by id, or by page/panel/line numbers (line defaults to the panel's only line). */
function lineArg(doc: ComicDoc, args: Record<string, unknown>): { page: Page; line: Line } {
  if (typeof args.lineId === 'string' && args.lineId) {
    const hit = linesInOrder(doc).find(({ line }) => line.id === args.lineId);
    if (!hit) throw toolArgError(`There is no line ${String(args.lineId).slice(0, 40)}.`);
    return hit;
  }
  const page = doc.pages.find((p) => p.n === int(args.page));
  if (!page) throw toolArgError(`page must be a page number (1–${doc.pages.length}).`);
  const panel = page.panels.find((p) => p.n === int(args.panel));
  if (!panel) throw toolArgError(`Page ${page.n} has panels 1–${page.panels.length}.`);
  const lines = panel.lines.filter((l) => normalizeSource(l.text));
  if (!lines.length) throw toolArgError(`Page ${page.n} panel ${panel.n} has no lines.`);
  const k = int(args.line) ?? (lines.length === 1 ? 1 : undefined);
  if (k === undefined || k < 1 || k > lines.length) throw toolArgError(`Page ${page.n} panel ${panel.n} has ${plural(lines.length, 'line')}; say which (line: 1–${lines.length}).`);
  return { page, line: lines[k - 1] };
}

function editTranslationTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'edit_translation',
    'free',
    'Change one translated line (the author\'s wording; never overwritten by a later translation). Reports whether it fits its balloon.',
    {
      type: 'object',
      properties: {
        language: { type: 'string' },
        page: { type: 'integer', minimum: 1 },
        panel: { type: 'integer', minimum: 1 },
        line: { type: 'integer', minimum: 1, description: '1-based line within the panel (optional when it has one line).' },
        lineId: { type: 'string' },
        text: { type: 'string', description: 'The new translated text.' }
      },
      required: ['language', 'text'],
      additionalProperties: false
    },
    async (args) => {
      const doc = ctx.session.doc;
      const lang = langArg(doc, args.language);
      if (sameLanguage(lang, doc.format.language)) throw toolArgError("That is the comic's own language — use edit_panel_text for the original lines.");
      const { page, line } = lineArg(doc, args);
      const text = typeof args.text === 'string' ? normalizeSource(args.text).slice(0, 600) : '';
      if (!text) throw toolArgError('text must be the new translated line.');
      const safety = prefilterText(text, ratingOf(ctx));
      if (safety.decision === 'block') throw toolArgError("That wording doesn't fit DreamStream's content rules — try different words.");
      const ops: DocOp[] = [];
      if (!i18nOf(doc).editions[lang]) {
        if (Object.keys(i18nOf(doc).editions).length >= DOC_LIMITS.editions) throw toolArgError(`A comic can have up to ${DOC_LIMITS.editions} translations; remove one in Languages first.`);
        ops.push({ op: 'edition', lang, patch: {} });
      }
      ops.push({ op: 'translation', lang, lineId: line.id, patch: { text, status: 'edited', at: Date.now(), sourceHash: lineSourceHash(line), gloss: undefined, issue: undefined, model: undefined } });
      ctx.session.commit(ops, { origin: 'director', label: 'Edit translation' });
      const budget = translationBudget(doc, page, line, lang);
      const over = graphemes(text, lang).length - budget;
      return over > 0
        ? `Updated, but it's ${plural(over, 'character')} longer than the balloon on page ${page.n} comfortably fits; it can grow, or the user can shorten it.`
        : 'Updated. Fits its balloon.';
    }
  );
}

const READ_LIMIT = 6000;

function readTranslationTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'read_translation',
    'free',
    'Read a translation line by line with the reviewer\'s gloss (what it really says), status, flags and fit — use it to answer "how does it read in Hindi?" honestly instead of guessing.',
    {
      type: 'object',
      properties: { language: { type: 'string' }, pages: { type: 'array', items: { type: 'integer', minimum: 1 } } },
      required: ['language'],
      additionalProperties: false
    },
    async (args) => {
      const doc = ctx.session.doc;
      const lang = langArg(doc, args.language);
      const edition = i18nOf(doc).editions[lang];
      if (!edition) {
        const usd = quoteTranslation(doc, ctx.keys, { languages: [lang] }).estimate.usd;
        return `There is no ${englishName(lang)} translation yet. translate_comic would cost ≈ ${formatUsd(usd)}.`;
      }
      const pages = pagesArg(doc, args.pages);
      const want = pages ? new Set(pages.map((p) => p.id)) : null;
      const rows: string[] = [];
      let size = 0;
      let cut = 0;
      for (const { page, line } of linesInOrder(doc)) {
        if (want && !want.has(page.id)) continue;
        if (!normalizeSource(line.text)) continue;
        const panel = page.panels.find((p) => p.lines.some((l) => l.id === line.id));
        const who = line.speakerId ? doc.cast.find((c) => c.id === line.speakerId)?.name?.toUpperCase() : undefined;
        const status = translationStatus(doc, lang, line);
        const t = edition.lines[line.id];
        const markers: string[] = [status];
        if (t?.issue) markers.push(`⚠ ${t.issue.severity}: ${t.issue.note.slice(0, 120)}`);
        if (t && graphemes(t.text, lang).length > translationBudget(doc, page, line, lang) * 1.2) markers.push('too long');
        const row = `P${page.n}·Panel ${panel?.n ?? '?'} · ${who ? `${who} ` : ''}(${line.kind}): "${normalizeSource(line.text).slice(0, 160)}" → ${t ? `"${t.text.slice(0, 200)}"` : '(missing)'} [${markers.join('; ')}]${t?.gloss ? ` gloss: "${t.gloss.slice(0, 160)}"` : ''}`;
        if (size + row.length > READ_LIMIT) {
          cut += 1;
          continue;
        }
        size += row.length + 1;
        rows.push(row);
      }
      const r = editionReadiness(doc, lang);
      const head = `${languageLabel(lang)} — ${r.publishable ? 'ready to publish' : `not ready: ${r.issues.filter((i) => i.blocking).map((i) => i.text).join(' ')}`}`;
      return [head, ...rows, cut ? `(${plural(cut, 'more line')} not shown — ask for specific pages.)` : ''].filter(Boolean).join('\n');
    }
  );
}

function setGlossaryTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'set_glossary',
    'free',
    'Set how names and recurring terms are written per language (transliterate / translate / keep). Changing a form renames it in every translated line for free.',
    {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              term: { type: 'string', description: 'The source-language wording ("Milo").' },
              policy: { type: 'string', enum: ['transliterate', 'translate', 'keep'] },
              forms: { type: 'object', additionalProperties: { type: 'string' }, description: 'language → form, e.g. {"te": "మైలో"}.' },
              note: { type: 'string' }
            },
            required: ['term'],
            additionalProperties: false
          }
        }
      },
      required: ['entries'],
      additionalProperties: false
    },
    async (args) => {
      if (!Array.isArray(args.entries) || !args.entries.length) throw toolArgError('entries must list at least one term.');
      const results: string[] = [];
      for (const raw of args.entries.slice(0, 40)) {
        if (!isObj(raw) || typeof raw.term !== 'string' || !normalizeSource(raw.term)) throw toolArgError('Each entry needs a term.');
        const doc = ctx.session.doc;
        const term = normalizeSource(raw.term).slice(0, 80);
        const rating = ratingOf(ctx);
        // Forms are copied into every translated line by the rename below, so they pass the same $0
        // content pre-filter a typed translation does (a director op never meets the client patch screen).
        if (prefilterText(term, rating).decision === 'block') {
          results.push(`${term.slice(0, 40)} (skipped: that wording doesn't fit the content rules)`);
          continue;
        }
        const existing = i18nOf(doc).glossary.find((g) => g.term.toLowerCase() === term.toLowerCase());
        if (!existing && i18nOf(doc).glossary.length >= DOC_LIMITS.glossaryTerms) {
          results.push(`${term} (skipped: the glossary holds up to ${DOC_LIMITS.glossaryTerms} terms)`);
          continue;
        }
        const id = existing?.id ?? `gl_t_${hashString(term.toLowerCase()).slice(0, 12)}`;
        const ops: DocOp[] = [];
        const patch: Record<string, unknown> = {};
        if (!existing) Object.assign(patch, { term, kind: 'term' });
        if (raw.policy === 'transliterate' || raw.policy === 'translate' || raw.policy === 'keep') patch.policy = raw.policy;
        if (typeof raw.note === 'string') patch.note = normalizeSource(raw.note).slice(0, 140);
        if (Object.keys(patch).length) ops.push({ op: 'glossary_term', id, patch });
        if (ops.length) ctx.session.commit(ops, { origin: 'director' });
        const renamed: string[] = [];
        if (isObj(raw.forms)) {
          for (const [k, v] of Object.entries(raw.forms).slice(0, 19)) {
            const lang = resolveLanguage(k);
            if (!lang || sameLanguage(lang, ctx.session.doc.format.language) || typeof v !== 'string' || !normalizeSource(v)) continue;
            const cur = ctx.session.doc;
            const old = i18nOf(cur).glossary.find((g) => g.id === id)?.forms[lang];
            const form = normalizeSource(v).slice(0, 80);
            if (prefilterText(form, rating).decision === 'block') {
              renamed.push(`${englishName(lang)}: skipped — that wording doesn't fit the content rules`);
              continue;
            }
            const rename = glossaryRenameOps(cur, lang, id, old || '', form);
            if (!rename.length) continue;
            ctx.session.commit(rename, { origin: 'director', label: 'Rename in translations' });
            const lines = rename.filter((o) => o.op === 'translation' || o.op === 'edition_text').length;
            renamed.push(old && lines ? `${old} → ${form} in ${plural(lines, `${englishName(lang)} line`)}` : `${englishName(lang)}: ${form}`);
          }
        }
        results.push(`${term}${renamed.length ? ` (${renamed.join('; ')})` : existing ? ' (updated)' : ' (added)'}`);
      }
      return `Glossary saved ($0): ${results.join(', ')}.`;
    }
  );
}

// ── Group ────────────────────────────────────────────────────────────────────

const hasEditions = (doc: ComicDoc) => Object.keys(i18nOf(doc).editions).length > 0;

/** "Languages: source te; editions hi (publishable, 100%), en (88%: 4 stale, 1 flagged)". */
export function languagesSummary(doc: ComicDoc): string | undefined {
  const editions = Object.keys(i18nOf(doc).editions);
  if (!editions.length && (doc.format.language || 'en') === 'en') return undefined;
  const parts = editions.map((lang) => {
    const p = editionProgress(doc, lang);
    const r = editionReadiness(doc, lang);
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
    const bits = [p.stale + p.staleEdited ? `${p.stale + p.staleEdited} stale` : '', p.missing ? `${p.missing} missing` : '', p.unreviewed ? `${p.unreviewed} unreviewed` : '', p.flagged ? `${p.flagged} flagged` : '']
      .filter(Boolean)
      .join(', ');
    return `${lang} (${r.publishable ? 'publishable' : 'draft'}, ${pct}%${bits ? `: ${bits}` : ''})`;
  });
  const lettering = doc.format.lettering === 'in_art' && editions.length ? '; lettering painted in the art (translations need overlay lettering)' : '';
  return `Languages: source ${doc.format.language}${parts.length ? `; editions ${parts.join(', ')}` : '; no translations'}${lettering}`;
}

export const I18N_PROMPT_RULES = `LANGUAGES. The comic is written in its source language (DOC SUMMARY). To make it readable in other languages call translate_comic: software reuses everything already translated for free, a writer-class translator does the rest and a linguist reviews every line; it quotes first and a waiting approval is handled like any other spend. Never "translate" by rewriting lines with edit_panel_text. To change one translated line use edit_translation; to check how a translation reads use read_translation (quote its gloss, never guess). To write the comic natively in another language, call set_comic_language with mode relabel BEFORE plan_pages. Reply in the user's language, but never change the comic's language unless they ask. Translated editions need overlay lettering: if the pages have lettering painted into the art, explain that converting means redrawing those pages without text (quote it) and ask before doing it. Readers choose among published languages when the comic is published; a language is publishable once it is translated and reviewed.`;

export const i18nToolGroup: ToolGroup = {
  id: 'i18n',
  priority: 50,
  when(ctx, turn) {
    const doc = ctx.session.doc;
    return hasEditions(doc) || LANG_WORDS.test(turn.userText || '') || !sameLanguage(doc.format.language || 'en', 'en');
  },
  tools: (ctx, turn) => [translateComicTool(ctx, turn), setComicLanguageTool(ctx, turn), editTranslationTool(ctx), readTranslationTool(ctx), setGlossaryTool(ctx)],
  promptRules: () => I18N_PROMPT_RULES,
  summaryLines(doc) {
    const line = languagesSummary(doc);
    return line ? [line] : [];
  },
  activity: {
    translate_comic: 'Pricing the translation…',
    set_comic_language: 'Setting the comic language…',
    edit_translation: 'Updating the translation…',
    read_translation: 'Reading the translation…',
    set_glossary: 'Updating the glossary…'
  }
};
