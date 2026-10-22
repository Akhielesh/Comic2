// The free pre-filter and the policy text (safety.md §14 #1–20, #35). Fixtures hold no explicit
// wording: placeholders expand from the lexicon at test time.
import { describe, expect, it } from 'vitest';
import { RATING_RULES } from '../../../../shared/comic/safety.js';
import {
  REDIRECT_COPY,
  buildSafetyNote,
  contentHash,
  contentPolicyBlock,
  decideInput,
  findIpNames,
  grawlixLine,
  homageHint,
  needsClassifier,
  normalizeForMatch,
  prefilterDetail,
  redirectFor,
  sampleForClassifier,
  severityFor
} from './contentPolicy.js';
import { FIXTURES, TERMS, expand, obfuscate } from './testkit.js';

describe('pre-filter: MUST ALLOW (free, no classifier needed)', () => {
  for (const f of FIXTURES.mustAllow) {
    it(`#${f.id} is clear at ${f.rating}`, () => {
      const d = prefilterDetail(f.text, f.rating);
      expect(d.decision).toBe('clear');
      expect(d.categories).toEqual([]);
      if (f.ip) expect(d.ip).toEqual(expect.arrayContaining(f.ip));
      // Short non-Latin text and ordinary messages never need the classifier.
      expect(needsClassifier(f.text)).toBe(false);
    });
  }

  it('kids variants never block (the director adapts within G/PG)', () => {
    for (const f of FIXTURES.mustAllow.filter((x) => x.kidsRating)) {
      expect(prefilterDetail(f.text, f.kidsRating!).decision).not.toBe('block');
    }
  });

  it('horror and action vocabulary never escalates', () => {
    for (const t of ['zombie', 'monster sword fight', 'a huge explosion', 'the ghost of the haunted castle', 'vampire villain heist', 'a killer whale jumps', 'he shoots the ball and scores', 'a blood moon rises']) {
      expect(prefilterDetail(t, 'G').decision).toBe('clear');
    }
  });

  it('common homonyms are not flagged (rooster, the bird, the cat)', () => {
    for (const t of ['the cock crows at dawn', 'a blue tit on a branch', 'the pussycat purrs', 'Moby Dick sails']) {
      expect(prefilterDetail(t, 'G').decision).toBe('clear');
    }
  });
});

describe('pre-filter: MUST BLOCK', () => {
  for (const f of FIXTURES.mustBlock.filter((x) => !x.obfuscate)) {
    it(`#${f.id} blocks (${f.category})`, () => {
      const d = prefilterDetail(expand(f.text), 'PG-13');
      expect(d.decision).toBe('block');
      expect(d.categories).toContain(f.category);
      if (f.severity) expect(d.severity).toBe(f.severity);
      if (f.allowedTwin) expect(prefilterDetail(f.allowedTwin, 'PG-13').decision).toBe('clear');
    });
  }

  it('#17 leet, spacing, dots and repeated letters are still blocked', () => {
    const f = FIXTURES.mustBlock.find((x) => x.obfuscate)!;
    const term = TERMS['<SEXUAL_TERM>'];
    for (const how of f.obfuscate!) {
      const text = f.text.replace('<SEXUAL_TERM>', obfuscate(term, how));
      expect(prefilterDetail(text, 'PG-13').decision, how).toBe('block');
    }
  });

  it("a negated term is a parent's instruction, not a request: the classifier decides (no strike)", () => {
    const d = prefilterDetail(expand("no <SEXUAL_TERM> stuff please, it's for kids"), 'G');
    expect(d.decision).toBe('ambiguous');
    expect(d.severity).toBe(0);
    expect(prefilterDetail(expand('draw <SEXUAL_TERM> stuff for kids'), 'G')).toMatchObject({ decision: 'block', severity: 3 });
  });

  it('real-world harm instructions block; story mentions do not', () => {
    expect(prefilterDetail('how do I make a bomb at home', 'PG-13')).toMatchObject({ decision: 'block', categories: ['dangerous'] });
    expect(prefilterDetail('the hero defuses the bomb just in time', 'PG-13').decision).toBe('clear');
  });

  it('self-harm instructions block without a strike and flag first-person crisis', () => {
    const d = prefilterDetail('how to kill myself', 'PG-13');
    expect(d).toMatchObject({ decision: 'block', categories: ['self_harm'], severity: 0, crisis: true });
  });

  it('a minor near nudity words goes to the classifier, never a strike by itself', () => {
    const d = prefilterDetail('the baby splashes naked in the tub', 'G');
    expect(d.decision).toBe('ambiguous');
    expect(d.categories).toEqual(expect.arrayContaining(['minor_sexual', 'nudity']));
    expect(d.severity).toBe(0);
  });
});

describe('pre-filter: rating-shaping words', () => {
  it('weapons are fine at PG-13 and ambiguous for kids', () => {
    expect(prefilterDetail('the hero shoots the robber', 'PG-13').decision).toBe('clear');
    expect(prefilterDetail('the hero shoots the robber', 'PG')).toMatchObject({ decision: 'ambiguous', categories: ['weapons'] });
  });

  it('gore is always for the classifier (adapt, not block)', () => {
    expect(prefilterDetail(FIXTURES.adapt[0].text, 'PG-13')).toMatchObject({ decision: 'ambiguous', categories: ['graphic_gore'] });
  });

  it('strong language is ambiguous at every rating; mild language is fine from PG', () => {
    expect(prefilterDetail(expand(FIXTURES.language[0].text), 'PG-13')).toMatchObject({ decision: 'ambiguous', categories: ['language'] });
    expect(prefilterDetail('damn it, the dragon escaped', 'PG').decision).toBe('clear');
    expect(prefilterDetail('damn it, the dragon escaped', 'G').decision).toBe('ambiguous');
  });

  it('native-script abuse terms are caught', () => {
    expect(prefilterDetail('वो चूतिया है', 'PG-13').decision).toBe('ambiguous');
  });
});

describe('normalization and helpers', () => {
  it('folds leet, joins spaced letters, collapses runs, keeps numbers in context', () => {
    expect(normalizeForMatch('S3cr3t b a s e  4:5 ages 2-6 loooook')).toBe('secret base  4:5 ages 2-6 look');
  });

  it('content hashes are one-way and stable', () => {
    expect(contentHash('Hello there')).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash('Hello there')).toBe(contentHash('hello   there'.replace(/\s+/g, ' ')));
  });

  it('routes long pastes and long non-Latin text to the classifier', () => {
    expect(needsClassifier('a'.repeat(6_001))).toBe(true);
    expect(needsClassifier('भूतिया हवेली '.repeat(30))).toBe(true);
    expect(needsClassifier('short note')).toBe(false);
    expect(needsClassifier('a script', { file: true })).toBe(true);
    expect(sampleForClassifier('x'.repeat(100_000)).length).toBeLessThan(61_000);
  });

  it('grawlixes strong language the comic way, keeping words the rating allows', () => {
    const line = expand('What the <PROFANITY>! Damn it.');
    const out = grawlixLine(line, 'PG-13')!;
    expect(out).not.toContain(TERMS['<PROFANITY>']);
    expect(out).toContain('Damn it.');
    expect(out).toMatch(/[@#$%&*!]{3,}/);
    expect(grawlixLine('Damn it.', 'G')).toMatch(/^[@#$%&*!]{3,} it\.$/);
    expect(grawlixLine('A lovely day.', 'G')).toBeUndefined();
  });

  it('finds trademark names and offers an homage hint', () => {
    expect(findIpNames('my shinchan and doraemon crossover')).toEqual(['Shin-chan', 'Doraemon']);
    expect(homageHint('Shin-chan')).toMatch(/five-year-old/);
  });
});

describe('decisions (decideInput)', () => {
  const v = (assessed: 'G' | 'PG' | 'PG-13' | 'X', categories: string[] = [], adaptable = true) =>
    ({ assessed, categories, adaptable, suggestion: 'keep it off-panel', ip: [], spans: [] }) as Parameters<typeof decideInput>[0];

  it('within the rating → allow; over it but adaptable → adapt (no strike)', () => {
    expect(decideInput(v('PG'), 'PG-13').decision).toBe('allow');
    expect(decideInput(v('PG-13', ['weapons']), 'PG')).toMatchObject({ decision: 'adapt', severity: 0, suggestion: 'keep it off-panel' });
    expect(decideInput(v('X', ['graphic_gore']), 'PG-13').decision).toBe('adapt');
  });

  it('not adaptable, sexual or dangerous → block; minors → severe block always', () => {
    expect(decideInput(v('X', ['graphic_gore'], false), 'PG-13')).toMatchObject({ decision: 'block', severity: 1 });
    expect(decideInput(v('X', ['sexual']), 'PG-13')).toMatchObject({ decision: 'block', severity: 1 });
    expect(decideInput(v('X', ['dangerous']), 'PG-13').decision).toBe('block');
    expect(decideInput(v('G', ['minor_sexual']), 'PG-13')).toMatchObject({ decision: 'block', severity: 3 });
  });

  it('severity: minors / hash / real person + sexual are severe; self-harm never strikes', () => {
    expect(severityFor(['minor_sexual'])).toBe(3);
    expect(severityFor(['real_person', 'sexual'])).toBe(3);
    expect(severityFor([], { hash: true })).toBe(3);
    expect(severityFor(['hate'])).toBe(1);
    expect(severityFor(['self_harm'])).toBe(0);
    expect(severityFor(['violence'])).toBe(0);
  });
});

describe('director copy', () => {
  it('the policy block welcomes action and horror, sets the rule and the ceiling', () => {
    const block = contentPolicyBlock('PG', 'kids_audience', 'PG');
    expect(block).toContain('CONTENT RATING — this comic is PG (kids audience).');
    expect(block).toContain(RATING_RULES.PG.story);
    expect(block).toMatch(/horror, suspense, monsters, villains and peril are welcome/);
    expect(block).toMatch(/original homage/);
    expect(block).toMatch(/never an empty reply/);
    expect(block).toContain('cannot go above PG');
  });

  it('the adapt note keeps the creative goal and asks for one friendly sentence', () => {
    const note = buildSafetyNote({ rating: 'PG', categories: ['weapons'], suggestion: 'the hero zaps the robber with a freeze ray' });
    expect(note).toMatch(/^SAFETY NOTE: this request goes beyond PG \(weapons\)/);
    expect(note).toContain('freeze ray');
    expect(note).toMatch(/ONE friendly sentence/);
  });

  it('redirects keep the creative spirit; minors and sexual content get no thematic options', () => {
    expect(redirectFor(['graphic_gore']).text).toMatch(/without the gore/);
    expect(redirectFor(['graphic_gore']).options.map((o) => o.label)).toEqual(['Show the aftermath, not the wound', 'Cut away on the impact', 'Something else']);
    expect(redirectFor(['minor_sexual']).options).toEqual([]);
    expect(redirectFor(['sexual']).options.map((o) => o.label)).toEqual(['Continue the story', 'Plan the next page']);
    expect(redirectFor(['dangerous']).text).toMatch(/off-panel/);
    expect(REDIRECT_COPY.self_harm.text).not.toMatch(/policy|violat/i);
  });
});
