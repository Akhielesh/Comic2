import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type ComicDoc } from './doc';
import {
  ALWAYS_RULE,
  HARD_BLOCK,
  RATING_RULES,
  ZERO_TOLERANCE,
  audienceCeiling,
  canServeToOwner,
  canServeToPublic,
  defaultRating,
  effectiveRating,
  isKidsAudience,
  isLittleKidsAudience,
  minRating,
  publishableText,
  ratingRank,
  saferRating,
  safetyStatusOf,
  softenAction
} from './safety';
import { applyOps } from './ops';

const docWith = (audience?: string, kind: ComicDoc['format']['kind'] = 'comic', rating?: 'G' | 'PG' | 'PG-13'): ComicDoc => {
  const d = createEmptyDoc('s', 'S', 1);
  d.brief = { ...d.brief, audience };
  d.format = { ...d.format, kind };
  if (rating) d.settings = { ...d.settings, rating };
  return d;
};

describe('effectiveRating (BINDING: min(choice ?? default, audience, account))', () => {
  it.each([
    // audience, kind, chosen, account, expected rating, reason
    ['kids 2–6', 'comic', undefined, 'PG-13', 'G', 'default'],
    ['kids 2–6', 'comic', 'PG-13', 'PG-13', 'G', 'little_kids'],
    ['kids', 'comic', 'PG-13', 'PG-13', 'PG', 'kids_audience'],
    ['ages 8-12', 'comic', undefined, 'PG-13', 'PG', 'default'],
    ['toddlers', 'comic', 'PG', 'PG-13', 'G', 'little_kids'],
    [undefined, 'storybook', undefined, 'PG-13', 'PG', 'default'],
    ['Teens and up', 'comic', undefined, 'PG-13', 'PG-13', 'default'],
    ['Teens and up', 'comic', undefined, 'PG', 'PG', 'account_age'],
    ['adults', 'comic', 'PG', 'PG-13', 'PG', 'chosen'],
    ['family, all ages', 'comic', undefined, 'PG-13', 'PG', 'default'],
    ['बच्चों के लिए', 'comic', undefined, 'PG-13', 'PG', 'default'],
    ['పిల్లల కోసం', 'comic', 'PG-13', 'PG-13', 'PG', 'kids_audience']
  ] as const)('%s / %s / chose %s / account %s → %s (%s)', (audience, kind, chosen, account, rating, reason) => {
    expect(effectiveRating(docWith(audience, kind, chosen), account)).toEqual({ rating, reason });
  });

  it('little kids and kids detection', () => {
    expect(isLittleKidsAudience(docWith('kids 2–6'))).toBe(true);
    expect(isLittleKidsAudience(docWith('ages 3-5'))).toBe(true);
    expect(isLittleKidsAudience(docWith('kids 8-12'))).toBe(false);
    expect(isLittleKidsAudience(docWith('preschool'))).toBe(true);
    expect(isKidsAudience(docWith('kids 8-12'))).toBe(true);
    expect(isKidsAudience(docWith('ages 13+'))).toBe(false);
    expect(isKidsAudience(docWith('young adults'))).toBe(false);
    const viaNotes = docWith(undefined);
    viaNotes.brief.notes = ['for my 5 year old'];
    expect(isLittleKidsAudience(viaNotes)).toBe(true);
    expect(audienceCeiling(docWith('teens'))).toBe('PG-13');
    expect(defaultRating(docWith('kids'))).toBe('PG');
  });
});

describe('safetyStatusOf truth table', () => {
  it.each([
    [undefined, 'PG', 'unchecked'],
    [{ at: 1 }, 'PG', 'unchecked'],
    [{ pending: true, at: 1 }, 'PG', 'pending'],
    [{ assessed: 'G', at: 1 }, 'G', 'pass'],
    [{ assessed: 'PG', at: 1 }, 'G', 'over_rating'],
    [{ assessed: 'PG-13', at: 1 }, 'PG-13', 'pass'],
    [{ assessed: 'X', at: 1 }, 'PG-13', 'blocked'],
    [{ assessed: 'G', quarantined: true, at: 1 }, 'PG-13', 'blocked'],
    [{ pending: true, quarantined: true, at: 1 }, 'PG', 'blocked']
  ] as const)('%j at %s → %s', (verdict, rating, status) => {
    expect(safetyStatusOf(verdict as never, rating)).toBe(status);
  });

  it('serving rules', () => {
    expect(canServeToOwner({ safety: { assessed: 'PG-13', at: 1 } })).toBe(true);
    expect(canServeToOwner({ safety: { pending: true, at: 1 } })).toBe(true);
    expect(canServeToOwner({ safety: { assessed: 'X', at: 1 } })).toBe(false);
    expect(canServeToOwner(undefined)).toBe(true);
    expect(canServeToPublic({ safety: { assessed: 'PG', at: 1 } }, 'PG')).toBe(true);
    expect(canServeToPublic({ safety: { assessed: 'PG', at: 1 } }, 'G')).toBe(false);
    expect(canServeToPublic({}, 'PG-13')).toBe(false); // unchecked never goes public
  });
});

describe('rating helpers and copy', () => {
  it('ranks, mins and safer takes', () => {
    expect(ratingRank('X')).toBe(3);
    expect(minRating('PG-13', 'G', undefined)).toBe('G');
    expect(minRating()).toBe('PG-13');
    expect(saferRating('PG-13')).toBe('PG');
    expect(saferRating('G')).toBe('G');
    expect(HARD_BLOCK.has('minor_sexual') && ZERO_TOLERANCE.has('minor_sexual')).toBe(true);
    expect(HARD_BLOCK.has('ip_parody')).toBe(false);
  });

  it('rating rules carry the §2.2 text', () => {
    expect(RATING_RULES.G.story).toMatch(/cleverness, kindness or teamwork/);
    expect(RATING_RULES.PG.art).toMatch(/Bloodless impacts/);
    expect(RATING_RULES['PG-13'].art).toMatch(/no dismemberment/);
    expect(ALWAYS_RULE).toMatch(/never anything involving minors/);
  });

  it('softenAction is deterministic', () => {
    expect(softenAction('He stabs the bloody guard.')).toBe('He lunges at the guard.');
    expect(softenAction('The knight decapitates the troll; a corpse lies nearby.')).toBe('The knight defeats the troll; a fallen figure lies nearby.');
    expect(softenAction('A naked mole rat.')).toBe('A in plain clothes mole rat.');
  });

  it('publishableText lists every publishable word in a stable order, plus chosen translations', () => {
    let doc = createEmptyDoc('p', 'Ducks', 1);
    doc = applyOps(doc, [
      { op: 'brief', patch: { logline: 'Ducks play.' } },
      { op: 'character', id: 'c1', patch: { name: 'Duckling' } },
      { op: 'page_insert', id: 'pg', after: 0 },
      { op: 'pages', pages: [{ id: 'pg', n: 1, summary: '', layout: '', render: { status: 'none', history: [] }, balloons: [], panels: [{ id: 'pn', n: 1, size: 'medium', shot: 'medium', action: '', castIds: [], lines: [{ id: 'l1', kind: 'speech', text: 'Quack!' }] }] }] },
      { op: 'edition', lang: 'hi', patch: {} },
      { op: 'translation', lang: 'hi', lineId: 'l1', patch: { text: 'क्वैक!', status: 'reviewed', sourceHash: 'h', at: 1 } }
    ]);
    expect(publishableText(doc)).toBe('Ducks\nDucks play.\nDuckling\nQuack!');
    expect(publishableText(doc, ['hi'])).toBe('Ducks\nDucks play.\nDuckling\nQuack!\nक्वैक!');
  });
});
