// Test helpers for the safety module (tests only). Owner: P1-SAFETY.
// Fixture placeholders are expanded from the lexicon so no explicit word lives in a fixture or a
// test file; installSafetyFakes() swaps every dependency for an in-memory fake.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBSCENITY_RULES, type ObscenityRule } from './lexicon.js';
import { configureSafety, resetSafety } from './deps.js';
import { fakeSafetyLlm, fakeSafetyStore, type FakeSafetyLlm, type FakeSafetyStore } from './fakes.js';
import type { AssetStore, StudioSessionApi } from '../types.js';
import type { AuditInput } from '../../observability/auditLog.js';

const pick = (pred: (r: ObscenityRule) => boolean): string => {
  const hit = Object.entries(OBSCENITY_RULES).find(([, r]) => r && pred(r));
  if (!hit) throw new Error('lexicon has no term for this placeholder');
  return hit[0];
};

export const TERMS: Record<string, string> = {
  '<SEXUAL_TERM>': pick((r) => r.category === 'sexual' && r.tier === 'block'),
  '<SLUR>': pick((r) => r.category === 'hate' && r.tier === 'block'),
  '<PROFANITY>': pick((r) => r.category === 'language' && r.tier === 'ambiguous' && !r.clearAt),
  '<MINOR_TERM>': 'schoolgirl'
};

export const expand = (text: string): string => text.replace(/<[A-Z_]+>/g, (m) => TERMS[m] ?? m);

const LEET: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
export const obfuscate = (word: string, how: string): string => {
  if (how === 'leet') return word.replace(/[aeiost]/g, (c) => LEET[c] || c);
  if (how === 'spaced') return word.split('').join(' ');
  if (how === 'dotted') return word.split('').join('.');
  if (how === 'repeated') return word.replace(/(.)$/, '$1$1$1$1');
  return word;
};

const fixtures: unknown = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/safety/inputs.json'), 'utf8'));

export const FIXTURES = fixtures as {
  mustAllow: { id: number; text: string; rating: 'G' | 'PG' | 'PG-13'; clear?: boolean; ip?: string[]; kidsRating?: 'G' | 'PG'; audience?: string }[];
  mustBlock: { id: number; text: string; category: string; severity?: number; dialogue?: boolean; obfuscate?: string[]; allowedTwin?: string }[];
  adapt: { id: number; text: string; rating: 'G' | 'PG' | 'PG-13'; audience?: string; classifier: Record<string, unknown> }[];
  language: { text: string; rating: 'G' | 'PG' | 'PG-13' }[];
};

export interface SafetyFakes {
  store: FakeSafetyStore;
  llm: FakeSafetyLlm;
  audits: AuditInput[];
  clock: { now: number };
  sessions: Map<string, StudioSessionApi>;
}

/** Swap every safety dependency for an in-memory fake (call resetSafety() in afterEach). */
export function installSafetyFakes(opts: { llm?: FakeSafetyLlm | null; assets?: AssetStore; now?: number; classifier?: boolean } = {}): SafetyFakes {
  const clock = { now: opts.now ?? Date.UTC(2026, 9, 22, 12, 0, 0) };
  const store = fakeSafetyStore({ now: () => clock.now });
  const llm = opts.llm === null ? fakeSafetyLlm() : opts.llm || fakeSafetyLlm();
  const audits: AuditInput[] = [];
  const sessions = new Map<string, StudioSessionApi>();
  configureSafety({
    store,
    platformLlm: () => (opts.llm === null ? null : llm),
    ...(opts.assets ? { assets: async () => opts.assets as AssetStore } : {}),
    liveSession: async (projectId) => sessions.get(projectId) ?? null,
    audit: async (a) => {
      audits.push(a);
    },
    now: () => clock.now,
    enabled: () => true,
    classifierOn: () => opts.classifier !== false
  });
  return { store, llm, audits, clock, sessions };
}

export { resetSafety };
