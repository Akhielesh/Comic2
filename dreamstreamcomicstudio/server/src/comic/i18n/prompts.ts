// Translator + linguist prompts and JSON schemas (i18n.md §8.5 / §8.7). Owner: P1-I18N.
//
// Pure string builders: no model calls, no clock. The translator localizes (a reader of the target
// language must feel it was written in it); the linguist reviews every translated line and writes a
// short gloss in the SOURCE language so an author who cannot read Telugu sees what it actually says.

import type { ComicDoc, LanguageEdition, Line, Page, TextTranslation, TranslationRegister } from '../../../../shared/comic/doc.js';
import { i18nOf, lineSourceHash, normalizeSource } from '../../../../shared/comic/i18n.js';
import { languageSpec, type LanguageSpec } from '../../../../shared/comic/languages.js';
import { glossaryForm, linesInOrder, translationBudget } from '../../../../shared/comic/translationPlan.js';

const SCRIPT_NAMES: Record<string, string> = {
  Latn: 'Latin',
  Deva: 'Devanagari',
  Telu: 'Telugu',
  Taml: 'Tamil',
  Knda: 'Kannada',
  Mlym: 'Malayalam',
  Beng: 'Bengali',
  Gujr: 'Gujarati',
  Guru: 'Gurmukhi',
  Arab: 'Arabic',
  Aran: 'Perso-Arabic (Nastaliq)',
  Jpan: 'Japanese (kanji + kana)',
  Kore: 'Hangul',
  Hans: 'Simplified Chinese'
};
export const scriptName = (spec: LanguageSpec): string => SCRIPT_NAMES[spec.script] || spec.script;

/** Honorific hints that matter for comic voices (age, family, friendship). */
const HONORIFIC_HINTS: Record<string, string> = {
  hi: ' (आप / तुम / तू; -जी for elders)',
  te: ' (మీరు / నువ్వు; -గారు for elders; అన్నయ్య, అక్క for older siblings)',
  ta: ' (நீங்கள் / நீ; அண்ணா, அக்கா for older siblings)',
  kn: ' (ನೀವು / ನೀನು; ಅಣ್ಣ, ಅಕ್ಕ)',
  ml: ' (നിങ്ങൾ / നീ; ചേട്ടൻ, ചേച്ചി)',
  mr: ' (तुम्ही / तू; दादा, ताई)',
  bn: ' (আপনি / তুমি / তুই; দাদা, দিদি)',
  gu: ' (તમે / તું; ભાઈ, બેન)',
  pa: ' (ਤੁਸੀਂ / ਤੂੰ; ਜੀ for elders)',
  ur: ' (آپ / تم / تو)',
  ja: ' (keigo vs casual speech, -san / -chan / -kun, first-person pronouns that fit each character)',
  ko: ' (존댓말 vs 반말 by age and closeness; 형/오빠/누나/언니)',
  'zh-Hans': ' (您 / 你; 哥哥, 姐姐)',
  es: ' (tú / usted)',
  fr: ' (tu / vous)',
  de: ' (du / Sie)',
  pt: ' (você / tu / o senhor)',
  id: ' (kamu / Anda; Kak, Pak, Bu)',
  ar: ' (أنتَ / أنتِ / حضرتك)'
};

const REGISTER_RULES: Record<TranslationRegister, (target: string, script: string) => string> = {
  everyday: (t) =>
    `Everyday spoken ${t} as people really talk at home — e.g. conversational Hindi/Hindustani, not Sanskritized formal Hindi; spoken Telugu, not grānthika.`,
  formal: (t) => `Polished written ${t}.`,
  code_mixed: (t, s) => `Natural code-mixed ${t} as urban speakers talk: common English words may stay (written in ${s} script) where a ${t} speaker would use them.`
};

const KIDS_RE = /\b(kid|kids|child|children|toddler|preschool|baby|babies|ages?\s*\d)|\b([2-9]|1[0-2])\s*[-–]\s*\d+\b/i;
export const isKidsAudience = (doc: ComicDoc): boolean => KIDS_RE.test(`${doc.brief?.audience || ''} ${doc.format?.kind === 'storybook' ? 'kids' : ''}`);

const clip = (s: string, n: number) => {
  const t = normalizeSource(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const words = (s: string, n: number) => {
  const parts = normalizeSource(s || '').split(' ').filter(Boolean);
  return parts.length > n ? `${parts.slice(0, n).join(' ')}…` : parts.join(' ');
};

/** Built by translatorSystemPrompt(doc, lang, edition) — §8.5. */
export function translatorSystemPrompt(doc: ComicDoc, lang: string, edition?: Pick<LanguageEdition, 'register'>): string {
  const target = languageSpec(lang);
  const source = languageSpec(doc.format.language);
  if (!target) throw new Error(`Unknown language ${lang}`);
  const t = target.english;
  const s = source?.english || doc.format.language;
  const script = scriptName(target);
  const register = edition?.register ?? 'everyday';
  const audience = doc.brief?.audience ? `${clip(doc.brief.audience, 40)} ` : '';
  const kids = isKidsAudience(doc)
    ? `\n- Readers are children (${clip(doc.brief?.audience || 'young readers', 40)}). Simple, warm, vivid words a child hears at home; short sentences; nothing rude, crude or scarier than the source.`
    : '';
  return `You are a professional comics localizer. Translate this ${audience}comic from ${s} into ${t} (${target.endonym}, ${script} script). Localize: a ${t}-speaking reader must feel it was written in ${t}.

MEANING
- Keep every plot fact, name, number and promise. Keep humor, emotion and intent; translate meaning, not words.
- Wordplay, idioms and cultural references: use an equivalent that works for ${t} readers when a literal version would fall flat; say what you changed in "notes".
- Never add, explain, censor or soften content beyond what the source says. Never add romanization, brackets or translator notes inside a line.

VOICE
- Each speaker keeps their personality and way of talking (see CAST: personality, voice). A grumpy frog stays grumpy; a toddler talks like a toddler.
- Address and honorifics: choose the natural ${t} forms for how characters relate (age, family, friendship)${HONORIFIC_HINTS[target.code] || ''}, and keep each character's choice consistent across the comic (see PRIOR CHOICES).

REGISTER
- ${REGISTER_RULES[register](t, script)}${kids}

NAMES (GLOSSARY)
- Use GLOSSARY forms exactly. A term marked "translate" is rendered as the natural ${t} word (a name like "The Baby" becomes what a ${t} reader calls a baby); "transliterate" is written in ${script} script by sound; "keep" stays as written.
- A name not in the glossary: transliterate it into ${script} script (don't translate its meaning) unless it is a meaningful nickname or pun the reader must understand; then adapt it. Return every name or recurring term you wrote in "glossary" (term = the source form, form = your ${t} form).

SOUND EFFECTS (kind sfx)
- Localize idiomatically: the sound word a ${t} comic would print, in ${script} script, short and punchy (at most 1.3× the source length). Keep a Latin SFX only if ${t} comics commonly do.

FIT
- Every line has maxChars = how many characters (grapheme clusters) fit its balloon. Stay within it. If the meaning truly needs more, exceed by at most 20% and set fits=false. Shorter and natural beats long and literal.

TYPOGRAPHY
- ${target.typography}

OUTPUT
JSON only, matching the schema. Every requested id exactly once; text in ${t} only (${script} script; digits and glossary "keep" terms excepted).`;
}

export interface TranslatorItem {
  id: string;
  kind: Line['kind'] | 'title' | 'tagline' | 'logline';
  speaker?: string;
  text: string;
  maxChars: number;
  previous?: string;
}

const speakerName = (doc: ComicDoc, id?: string) => (id ? doc.cast.find((c) => c.id === id)?.name : undefined);

/** ≤ 12 short pairs from lines already translated for the same speakers (cross-chunk consistency). */
export function priorChoices(doc: ComicDoc, lang: string, speakerIds: Set<string>, exclude: Set<string>): string[] {
  const edition = i18nOf(doc).editions[lang];
  if (!edition) return [];
  const out: string[] = [];
  for (const { line } of linesInOrder(doc)) {
    if (out.length >= 12) break;
    if (exclude.has(line.id) || !line.speakerId || !speakerIds.has(line.speakerId)) continue;
    const t = edition.lines[line.id];
    if (!t || t.sourceHash !== lineSourceHash(line) || t.issue?.severity === 'major') continue;
    out.push(`${speakerName(doc, line.speakerId) || 'someone'}: "${clip(line.text, 80)}" → "${clip(t.text, 120)}"`);
  }
  return out;
}

/** Translator user message: BRIEF, CAST, GLOSSARY, PRIOR CHOICES, STORY, LINES (§8.5). */
export function translatorUserMessage(doc: ComicDoc, lang: string, args: { pages: { page: Page; lineIds: Set<string> }[]; extras?: TranslatorItem[]; previous?: Record<string, string> }): string {
  const parts: string[] = [];
  const b = doc.brief || ({} as ComicDoc['brief']);
  parts.push(
    `BRIEF\n${JSON.stringify({ title: clip(b.title, 120), logline: clip(b.logline || '', 300), tone: clip(b.tone || '', 80), audience: clip(b.audience || '', 60), genre: clip(b.genre || '', 60) })}`
  );
  const glossary = i18nOf(doc).glossary;
  const castLines = doc.cast.slice(0, 40).map((c) => {
    const term = glossary.find((g) => g.refId === c.id);
    const form = term ? glossaryForm(term, lang) : undefined;
    return JSON.stringify({
      id: c.id,
      name: c.name,
      ...(form ? { glossaryForm: form } : {}),
      ...(c.kind && c.kind !== 'person' ? { kind: c.kind } : {}),
      ...(c.personality ? { personality: clip(c.personality, 160) } : {}),
      ...(c.voice ? { voice: clip(c.voice, 160) } : {}),
      ...(c.look?.age ? { age: clip(c.look.age, 30) } : {}),
      ...(c.look?.gender ? { gender: clip(c.look.gender, 30) } : {})
    });
  });
  if (castLines.length) parts.push(`CAST\n${castLines.join('\n')}`);
  const terms = glossary.slice(0, 120).map((g) => {
    const form = glossaryForm(g, lang);
    return `${g.term} → ${form || '(not set yet)'} [${g.policy}${g.kind !== 'term' ? `, ${g.kind}` : ''}]${g.note ? ` ${clip(g.note, 80)}` : ''}`;
  });
  if (terms.length) parts.push(`GLOSSARY\n${terms.join('\n')}`);
  const speakers = new Set<string>();
  const requested = new Set<string>();
  for (const { page, lineIds } of args.pages) for (const panel of page.panels) for (const l of panel.lines) if (lineIds.has(l.id)) { requested.add(l.id); if (l.speakerId) speakers.add(l.speakerId); }
  const prior = priorChoices(doc, lang, speakers, requested);
  if (prior.length) parts.push(`PRIOR CHOICES\n${prior.join('\n')}`);
  const story = [...doc.pages].sort((a, b2) => a.n - b2.n).map((p) => `P${p.n}: ${words(p.summary, 60)}`);
  parts.push(`STORY\n${story.join('\n')}`);
  const lineBlocks: string[] = [];
  for (const { page, lineIds } of args.pages) {
    const block: string[] = [`PAGE ${page.n} — ${words(page.summary, 60)}`];
    for (const panel of [...page.panels].sort((a, b2) => a.n - b2.n)) {
      const lines = panel.lines.filter((l) => lineIds.has(l.id));
      if (!lines.length) continue;
      block.push(`Panel ${panel.n} (context only): ${clip(panel.action, 160)}`);
      for (const l of lines) {
        const item: Record<string, unknown> = {
          id: l.id,
          kind: l.kind,
          ...(speakerName(doc, l.speakerId) ? { speaker: speakerName(doc, l.speakerId) } : {}),
          text: normalizeSource(l.text),
          maxChars: translationBudget(doc, page, l, lang)
        };
        const prev = args.previous?.[l.id];
        if (prev) item.previous = prev;
        block.push(JSON.stringify(item));
      }
    }
    lineBlocks.push(block.join('\n'));
  }
  if (args.extras?.length) {
    lineBlocks.push(`COVER AND TITLE\n${args.extras.map((e) => JSON.stringify({ id: e.id, kind: e.kind, text: e.text, maxChars: e.maxChars })).join('\n')}`);
  }
  parts.push(`LINES\n${lineBlocks.join('\n\n')}`);
  return parts.join('\n\n');
}

const str = { type: 'string' } as const;
const strict = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

/** Translator output (strict). */
export const TRANSLATION_SCHEMA = strict({
  lines: { type: 'array', items: strict({ id: str, text: str, fits: { type: 'boolean' } }) },
  glossary: { type: 'array', items: strict({ term: str, form: str }) },
  notes: str
});

/** The repair round: only the problem lines, same schema. */
export function repairMessage(problems: string[]): string {
  return (
    `Some lines can't be used yet:\n${problems.slice(0, 30).map((p) => `- ${p}`).join('\n')}\n` +
    'Fix ONLY these lines and reply with the same JSON schema (lines = just the fixed ids; glossary and notes may be empty).'
  );
}

// ── Linguist (§8.7) ──────────────────────────────────────────────────────────

export interface ReviewItem {
  id: string;
  kind: string;
  speaker?: string;
  source: string;
  text: string;
}

export function linguistSystemPrompt(doc: ComicDoc, lang: string): string {
  const target = languageSpec(lang);
  const source = languageSpec(doc.format.language);
  const t = target?.english || lang;
  const s = source?.english || doc.format.language;
  const kids = isKidsAudience(doc) ? ' The readers are children: anything rude, crude or scarier than the source is a major issue.' : '';
  return `You are a native ${t} editor reviewing a comic translated from ${s}. For EVERY line:
- gloss: a short, literal back-meaning of the FINAL ${t} text (your suggestion when you give one), written in ${s}, so an author who cannot read ${t} sees what it really says.
- verdict "ok" when it is correct, natural spoken ${t} and fits the character; otherwise "fix".
- severity "major" for: wrong or missing meaning, wrong speaker gender agreement or honorific, unsafe or rude wording for the audience, or the wrong script. "minor" for: unnatural phrasing, a better word, typography. "none" when the verdict is ok.
- issue: one short sentence in ${s} (empty when ok). suggestion: the corrected ${t} line (empty when ok, or when you can't do better).
Never rewrite a line that is fine. Keep names exactly as in the glossary.${kids}
JSON only, matching the schema; every id exactly once.`;
}

export function linguistUserMessage(doc: ComicDoc, lang: string, items: ReviewItem[]): string {
  const glossary = i18nOf(doc)
    .glossary.slice(0, 80)
    .map((g) => {
      const form = glossaryForm(g, lang);
      return form ? `${g.term} → ${form}` : '';
    })
    .filter(Boolean);
  return [
    `COMIC\n${JSON.stringify({ title: clip(doc.brief?.title || '', 120), audience: clip(doc.brief?.audience || '', 60), tone: clip(doc.brief?.tone || '', 80) })}`,
    glossary.length ? `GLOSSARY\n${glossary.join('\n')}` : '',
    `LINES\n${items.map((i) => JSON.stringify({ id: i.id, kind: i.kind, ...(i.speaker ? { speaker: i.speaker } : {}), source: i.source, translation: i.text })).join('\n')}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const REVIEW_SCHEMA = strict({
  lines: {
    type: 'array',
    items: strict({ id: str, gloss: str, verdict: { type: 'string', enum: ['ok', 'fix'] }, severity: { type: 'string', enum: ['none', 'minor', 'major'] }, issue: str, suggestion: str })
  }
});

export type ReviewVerdict = { id: string; gloss: string; verdict: 'ok' | 'fix'; severity: 'none' | 'minor' | 'major'; issue: string; suggestion: string };

/** The previous translation of a stale line ("small source edits produce small target edits"). */
export const previousText = (t?: TextTranslation): string | undefined => (t && t.text ? t.text : undefined);
