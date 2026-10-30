// Test helpers for the translation pipeline (fakes only — no network, $0). Owner: P1-I18N.
//
// `fakeTranslator` answers every requested id (from the LINES section, or the repair message) with
// text in the target script; `fakeLinguist` approves every line with an English gloss. Both are
// ScriptStep functions for orchestrator.fakes.ts scriptedLlm.

import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page } from '../../../../shared/comic/doc.js';
import type { LlmRequest, LlmResult } from '../types.js';

/** Sample words per script (all letters in that script, so the script check passes). */
const WORDS: Record<string, string[]> = {
  te: ['చంద్రుడు', 'నేస్తం', 'చూడు', 'ఆకాశం', 'కలిసి', 'రాత్రి', 'ఎక్కడ', 'వచ్చాడు'],
  hi: ['चाँद', 'दोस्त', 'देखो', 'आसमान', 'साथ', 'रात', 'कहाँ', 'आया'],
  ta: ['நிலா', 'நண்பா', 'பார்', 'வானம்', 'சேர்ந்து', 'இரவு', 'எங்கே', 'வந்தான்'],
  ja: ['月', 'ともだち', 'みて', 'そら', 'いっしょ', 'よる', 'どこ', 'きた'],
  es: ['luna', 'amigo', 'mira', 'cielo', 'juntos', 'noche', 'dónde', 'llegó']
};

const contentOf = (m: LlmRequest['messages'][number] | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : (m.content || []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** Ids requested in a translator call (first call: the LINES objects; repair call: "line X …"). */
export function requestedIds(req: LlmRequest): string[] {
  const last = contentOf(req.messages[req.messages.length - 1]);
  if (/can't be used yet/.test(last)) return [...last.matchAll(/line (\S+) /g)].map((m) => m[1]);
  const lines = last.slice(Math.max(0, last.indexOf('\nLINES\n')));
  return [...lines.matchAll(/^\{"id":"([^"]+)"/gm)].map((m) => m[1]);
}

/** The LINES objects of a request (id → parsed object). */
export function requestedItems(req: LlmRequest): Record<string, Record<string, unknown>> {
  const user = contentOf(req.messages.find((m, i) => m.role === 'user' && i === 1) || req.messages[req.messages.length - 1]);
  const last = user.slice(Math.max(0, user.indexOf('\nLINES\n')));
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of last.matchAll(/^(\{"id":.*\})$/gm)) {
    try {
      const o = JSON.parse(m[1]) as Record<string, unknown>;
      if (typeof o.id === 'string') out[o.id] = o;
    } catch {
      /* not a line object */
    }
  }
  return out;
}

const targetOf = (req: LlmRequest): string => {
  const sys = contentOf(req.messages[0]);
  if (/into Telugu/.test(sys)) return 'te';
  if (/into Hindi/.test(sys)) return 'hi';
  if (/into Tamil/.test(sys)) return 'ta';
  if (/into Japanese/.test(sys)) return 'ja';
  return 'es';
};

export const fakeText = (lang: string, id: string): string => {
  const words = WORDS[lang] || WORDS.es;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${words[h % words.length]} ${words[(h >>> 3) % words.length]}!`;
};

export interface FakeTranslatorOptions {
  /** Override the text for an id (e.g. Latin text to fail the script check). */
  text?: (id: string, lang: string, attempt: number) => string | undefined;
  /** Ids to leave out of the answer. */
  omit?: (id: string, attempt: number) => boolean;
  glossary?: { term: string; form: string }[];
}

/** A translator ScriptStep that answers every requested id. `attempt` counts calls on this fake. */
export function fakeTranslator(opts: FakeTranslatorOptions = {}): { step: (req: LlmRequest) => Partial<LlmResult>; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    step: (req) => {
      calls.push(req);
      const attempt = calls.length;
      const lang = targetOf(req);
      const lines = requestedIds(req)
        .filter((id) => !opts.omit?.(id, attempt))
        .map((id) => ({ id, text: opts.text?.(id, lang, attempt) ?? fakeText(lang, id), fits: true }));
      return { json: { lines, glossary: opts.glossary || [], notes: '' }, completionTokens: 40 * lines.length };
    }
  };
}

/** A linguist ScriptStep: ok + an English gloss for every line, or a custom verdict per id. */
export function fakeLinguist(verdict?: (id: string) => Partial<{ verdict: 'ok' | 'fix'; severity: 'none' | 'minor' | 'major'; issue: string; suggestion: string; gloss: string }> | undefined) {
  return (req: LlmRequest): Partial<LlmResult> => {
    const last = contentOf(req.messages[req.messages.length - 1]);
    const items = [...last.matchAll(/^(\{"id":.*\})$/gm)].map((m) => JSON.parse(m[1]) as { id: string; source: string });
    return {
      json: {
        lines: items.map((i) => ({ id: i.id, gloss: `Means: ${i.source}`, verdict: 'ok', severity: 'none', issue: '', suggestion: '', ...(verdict?.(i.id) || {}) }))
      }
    };
  };
}

/** Repeat a ScriptStep n times (scriptedLlm consumes one entry per call). */
export const times = <T>(n: number, step: T): T[] => Array.from({ length: n }, () => step);

const ln = (id: string, text: string, patch: Partial<Line> = {}): Line => ({ id, kind: 'speech', speakerId: 'c_milo', text, ...patch });

/**
 * A synthetic 6-page kids comic (overlay lettering, nothing painted): 12 lines with a duplicate,
 * a punctuation-only line and an SFX, plus a title and a logline.
 */
export function sixPageKidsDoc(id = 'i18n_six'): ComicDoc {
  const doc = createEmptyDoc(id, 'Milo and the Moon', 1_792_670_000_000);
  doc.brief = { ...doc.brief, logline: 'A boy and his frog chase the moon across the night sky.', audience: 'kids 4–8', tone: 'gentle' };
  doc.cast = [
    { id: 'c_milo', name: 'Milo', tier: 'lead', look: { summary: 'a curious boy in striped pajamas', age: '6' }, personality: 'curious', voice: 'excited, short sentences', refs: [], sheet: emptyRender() },
    { id: 'c_frog', name: 'Frog', tier: 'support', kind: 'animal', look: { summary: 'a round green frog' }, personality: 'grumpy but kind', refs: [], sheet: emptyRender() }
  ];
  const pages: Line[][] = [
    [ln('l1', 'Where did the moon go?'), ln('l2', 'Ribbit!', { speakerId: 'c_frog' })],
    [ln('l3', 'Look, up there!'), ln('l4', '...', { kind: 'caption', speakerId: undefined })],
    [ln('l5', 'Ribbit!', { speakerId: 'c_frog' }), ln('l6', 'SPLASH', { kind: 'sfx', speakerId: undefined })],
    [ln('l7', 'Hold on tight, Frog!'), ln('l8', 'I am holding, I am holding.', { speakerId: 'c_frog' })],
    [ln('l9', 'We found it together.'), ln('l10', 'The moon smiled at them.', { kind: 'caption', speakerId: undefined })],
    [ln('l11', 'Goodnight, moon.'), ln('l12', 'Goodnight, Milo.', { speakerId: 'c_frog' })]
  ];
  doc.pages = pages.map((lines, i): Page => ({
    id: `pg_${i + 1}`,
    n: i + 1,
    summary: `Milo and Frog, beat ${i + 1}.`,
    layout: 'Row 1: one wide panel. Row 2: two equal panels.',
    panels: [{ id: `pn_${i + 1}`, n: 1, size: 'wide', shot: 'medium', action: `Milo and Frog under the stars (${i + 1}).`, castIds: ['c_milo', 'c_frog'], lines }],
    render: emptyRender(),
    balloons: []
  }));
  doc.planStatus = 'approved';
  return doc;
}
