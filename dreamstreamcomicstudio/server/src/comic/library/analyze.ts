// Library image analysis (assets.md §4.3): ONE vision call per candidate, merged with the free
// sharp measurement. Software gates override the model: a wrong shape, a blank frame, stray
// lettering on a text-free asset, a misspelled cover title, a wrong panel count or the wrong
// theme cap the score no matter how much the model liked the picture.

import type { MessagePart } from '../../ai/providers/types.js';
import { completeStructured, type StructuredCheck } from '../writer.js';
import { normalizeLettering, textSimilarity } from '../vision.js';
import type { ImageMeasure } from '../imageMeasure.js';
import type { LlmClient } from '../types.js';
import { isTextFree, minScoreOf, type LibraryManifestEntry } from './manifest.js';

/** Edge seam (0..1) above which a texture tile visibly repeats. */
export const SEAM_THRESHOLD = 0.06;
/** Title similarity a cover needs. */
export const TITLE_SIMILARITY = 0.85;

export type LibraryIssueCode =
  | 'aspect'
  | 'blank'
  | 'text'
  | 'title'
  | 'panels'
  | 'theme'
  | 'seam'
  | 'brief'
  | 'style'
  | 'technical'
  | 'analysis';

/** Plain words for the admin grid ("lastIssue"). */
export const ISSUE_LABEL: Record<LibraryIssueCode, string> = {
  aspect: 'Wrong shape',
  blank: 'Blank or near-uniform image',
  text: 'Stray lettering or a signature',
  title: 'Cover title misspelled or missing',
  panels: 'Wrong panel count',
  theme: 'Too dark or too light for its theme',
  seam: 'Texture seams show when tiled',
  brief: "Doesn't show what was asked",
  style: "Doesn't match the style",
  technical: 'Drawing defects (hands, faces, artifacts)',
  analysis: "The automatic check couldn't read this image"
};

/** What the vision model reports (strict schema). */
export interface LibraryVisionReport {
  caption: string;
  altText: string;
  tags: string[];
  subjects: string[];
  textFound: string[];
  watermarkOrSignature: boolean;
  panelCount: number;
  briefMatch: number;
  styleMatch: number;
  technical: number;
  issues: string[];
  score: number;
}

const num01 = { type: 'number', minimum: 0, maximum: 1 } as const;
const strArr = { type: 'array', items: { type: 'string' } } as const;

export const LIBRARY_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['caption', 'altText', 'tags', 'subjects', 'textFound', 'watermarkOrSignature', 'panelCount', 'briefMatch', 'styleMatch', 'technical', 'issues', 'score'],
  properties: {
    caption: { type: 'string' },
    altText: { type: 'string' },
    tags: strArr,
    subjects: strArr,
    textFound: strArr,
    watermarkOrSignature: { type: 'boolean' },
    panelCount: { type: 'integer' },
    briefMatch: num01,
    styleMatch: num01,
    technical: num01,
    issues: strArr,
    score: num01
  }
};

const SYSTEM =
  'You are an art director auditing a library image for a comic app. Compare the image with its brief. Be strict and concrete. ' +
  'Report every legible glyph, letter, number, signature or watermark you can see in textFound (exactly as written). ' +
  'panelCount is the number of comic panels (0 for a single illustration). briefMatch: does it depict the brief\'s subjects and composition. ' +
  'styleMatch: does it match the named style traits. technical: anatomy, hands, faces, artifacts, muddy areas (1 = flawless). ' +
  'issues: short, concrete, fixable defects. altText: one plain sentence for a screen reader (no "image of"). Reply with JSON only.';

const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const clamp01 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const strList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v) ? v.map((x) => clip(x, len)).filter(Boolean).slice(0, max) : [];

/** Validate + normalize a model reply. Missing numbers are problems (sent back once for repair). */
export function checkVisionReport(json: unknown): StructuredCheck<LibraryVisionReport> {
  if (!json || typeof json !== 'object') return { problems: ['Reply with one JSON object.'] };
  const o = json as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of ['briefMatch', 'styleMatch', 'technical', 'score'] as const) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) problems.push(`${k} must be a number from 0 to 1.`);
  }
  if (problems.length === 4) return { problems };
  const value: LibraryVisionReport = {
    caption: clip(o.caption, 160),
    altText: clip(o.altText, 140),
    tags: strList(o.tags, 12, 32).map((t) => t.toLowerCase()),
    subjects: strList(o.subjects, 12, 80),
    textFound: strList(o.textFound, 24, 80),
    watermarkOrSignature: o.watermarkOrSignature === true,
    panelCount: typeof o.panelCount === 'number' && Number.isFinite(o.panelCount) ? Math.max(0, Math.min(24, Math.round(o.panelCount))) : 0,
    briefMatch: clamp01(o.briefMatch),
    styleMatch: clamp01(o.styleMatch),
    technical: clamp01(o.technical),
    issues: strList(o.issues, 8, 160),
    score: clamp01(o.score)
  };
  return { value, problems };
}

/** The brief the analyst compares against (prompt + expectation). */
export function analysisBrief(entry: LibraryManifestEntry, prompt: string): string {
  const expectation = entry.expectedText?.length
    ? `The ONLY text allowed is the title: ${entry.expectedText.map((t) => `'${t}'`).join(', ')}.`
    : 'The image must be completely text-free (no letters, numbers, signatures or watermarks).';
  const panels = entry.panels ? `It must be a comic page with exactly ${entry.panels} panels.` : entry.kind === 'texture_seed' ? 'It is a flat paper texture (no objects).' : 'It is a single illustration (panelCount 0).';
  const theme = entry.theme === 'dark' ? 'It must be a DARK image overall.' : entry.theme === 'light' ? 'It must be a LIGHT image overall.' : '';
  return [`BRIEF:\n${prompt.slice(0, 3000)}`, `EXPECTATION: ${expectation} ${panels} ${theme}`.trim()].join('\n\n');
}

export interface LibraryAnalysisResult {
  report?: LibraryVisionReport;
  /** The model reply couldn't be used (scored 0, routed to review with an honest issue). */
  fellBack: boolean;
  costUsd?: number;
  model: string;
}

/** One strict vision call. Never throws for unusable JSON (falls back); transport errors propagate. */
export async function analyzeLibraryAsset(
  llm: LlmClient,
  args: { entry: LibraryManifestEntry; prompt: string; dataUrl: string; signal?: AbortSignal }
): Promise<LibraryAnalysisResult> {
  const user: MessagePart[] = [
    { type: 'image_url', image_url: { url: args.dataUrl } },
    { type: 'text', text: analysisBrief(args.entry, args.prompt) }
  ];
  const out = await completeStructured<LibraryVisionReport | null>({
    llm,
    role: 'vision',
    system: SYSTEM,
    user,
    schemaName: 'library_analysis',
    schema: LIBRARY_ANALYSIS_SCHEMA,
    validate: checkVisionReport,
    failure: "The library image couldn't be analyzed.",
    fallback: () => null,
    temperature: 0.1,
    maxTokens: 900,
    signal: args.signal
  });
  return { report: out.value ?? undefined, fellBack: !!out.fellBack || !out.value, costUsd: out.costUsd, model: out.model };
}

/** Letters (any script) across the reported text. */
export const lettersIn = (textFound: string[]): number =>
  textFound.reduce((n, t) => n + (normalizeLettering(t).match(/\p{L}/gu) || []).length, 0);

/** Best similarity of an expected title against what was read (single items and the whole run). */
export const titleSimilarity = (expected: string[], found: string[]): number => {
  if (!expected.length) return 1;
  const norms = found.map(normalizeLettering).filter(Boolean);
  const all = norms.join(' ');
  return Math.min(
    ...expected.map((e) => {
      const want = normalizeLettering(e);
      if (!want) return 1;
      const candidates = [...norms, all];
      return Math.max(0, ...candidates.map((f) => (f.includes(want) ? 1 : textSimilarity(want, f))));
    })
  );
};

export interface MergedLibraryScore {
  score: number;
  codes: LibraryIssueCode[];
  /** Human notes: software checks first, then the model's own issues. */
  notes: string[];
  scores: { briefMatch: number; styleMatch: number; technical: number; model: number };
  minScore: number;
  passed: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Merge the free measurement with the model's report (assets.md §4.3 "software gates override the model"). */
export function mergeLibraryScore(entry: LibraryManifestEntry, measure: ImageMeasure, report: LibraryVisionReport | undefined): MergedLibraryScore {
  const codes: LibraryIssueCode[] = [];
  const notes: string[] = [];
  const add = (code: LibraryIssueCode, note: string) => {
    if (!codes.includes(code)) codes.push(code);
    notes.push(note);
  };
  const minScore = minScoreOf(entry);
  const r = report;
  let base = r ? Math.min(r.score, 0.4 * r.briefMatch + 0.35 * r.styleMatch + 0.25 * r.technical) : 0;
  if (!r) add('analysis', ISSUE_LABEL.analysis);

  if (!measure.aspectOk) {
    add('aspect', `Came back ${measure.w}×${measure.h}, expected ${entry.aspect}`);
    base = Math.min(base, 0.5);
  }
  if (measure.blank && entry.kind !== 'texture_seed') {
    add('blank', ISSUE_LABEL.blank);
    base = 0;
  }
  if (r) {
    if (isTextFree(entry) && (lettersIn(r.textFound) >= 3 || r.watermarkOrSignature)) {
      add('text', r.watermarkOrSignature ? 'A signature or watermark is visible' : `Stray text: ${r.textFound.slice(0, 3).join(' · ').slice(0, 80)}`);
      base = Math.min(base, 0.6);
    }
    if (entry.expectedText?.length) {
      const sim = titleSimilarity(entry.expectedText, r.textFound);
      if (sim < TITLE_SIMILARITY) {
        add('title', `Title reads “${r.textFound.slice(0, 2).join(' ').slice(0, 60) || 'nothing'}”, expected “${entry.expectedText.join(' ')}”`);
        base = Math.min(base, 0.6);
      }
    }
    if (entry.panels && r.panelCount !== entry.panels) {
      add('panels', `${r.panelCount} panels, expected ${entry.panels}`);
      base = Math.min(base, 0.65);
    }
    if (r.briefMatch < 0.6) add('brief', ISSUE_LABEL.brief);
    if (r.styleMatch < 0.6) add('style', ISSUE_LABEL.style);
    if (r.technical < 0.6) add('technical', ISSUE_LABEL.technical);
  }
  if ((entry.theme === 'dark' && measure.meanLuma > 0.35) || (entry.theme === 'light' && measure.meanLuma < 0.65)) {
    add('theme', `${entry.theme === 'dark' ? 'Too light' : 'Too dark'} for a ${entry.theme} theme (luminance ${measure.meanLuma.toFixed(2)})`);
    base = Math.min(base, 0.6);
  }
  if (entry.post === 'seamless_tile' && typeof measure.edgeSeamDelta === 'number' && measure.edgeSeamDelta > SEAM_THRESHOLD) {
    add('seam', `Edge seam ${measure.edgeSeamDelta.toFixed(3)}`);
  }
  if (r) for (const issue of r.issues) if (notes.length < 10) notes.push(issue);
  const score = round3(Math.max(0, Math.min(1, base)));
  return {
    score,
    codes,
    notes: notes.slice(0, 10),
    scores: { briefMatch: r?.briefMatch ?? 0, styleMatch: r?.styleMatch ?? 0, technical: r?.technical ?? 0, model: r?.score ?? 0 },
    minScore,
    passed: !!r && score >= minScore
  };
}
