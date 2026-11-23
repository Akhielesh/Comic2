// @vitest-environment node
// The register-interest questions, their cleaning, the consent flag and the one stored shape both paths write.
import { describe, expect, it } from 'vitest';
import {
  INTEREST_HEARD,
  INTEREST_HEARD_QUESTION,
  INTEREST_MAKES,
  INTEREST_MAKES_QUESTION,
  INTEREST_THANKS,
  INTEREST_UPDATES,
  UPDATES_CARD,
  answersForKind,
  cleanBlock,
  cleanLine,
  interestMetadata,
  interestThanks,
  knownHeard,
  knownMakes
} from './interest';

describe('the questions', () => {
  it('asks what they would like to make, with a few quick picks', () => {
    expect(INTEREST_MAKES_QUESTION).toBe('What would you like to make?');
    expect(INTEREST_MAKES.map((m) => m.label)).toEqual([
      'A short story',
      'A comic for kids',
      'A webcomic series',
      'A pitch or storyboard',
      'Something for work'
    ]);
  });

  it('asks how they heard about us, as one choice', () => {
    expect(INTEREST_HEARD_QUESTION).toBe('How did you hear about us?');
    expect(INTEREST_HEARD.map((h) => h.label)).toEqual(['LinkedIn', 'A friend', 'Search', 'Social media', 'Other']);
  });

  it('asks nothing about other studios, and no vague "something else"', async () => {
    const mod = (await import('./interest')) as Record<string, unknown>;
    for (const gone of ['INTEREST_STUDIOS', 'INTEREST_FEATURES', 'INTEREST_FEATURES_QUESTION', 'knownStudios', 'knownFeatures']) {
      expect(mod[gone], gone).toBeUndefined();
    }
    const asked = [INTEREST_MAKES_QUESTION, INTEREST_HEARD_QUESTION, ...INTEREST_MAKES.map((m) => m.label), ...INTEREST_HEARD.map((h) => h.label)];
    expect(asked.join(' ')).not.toMatch(/Chat Studio|Stream Studio|Dashboards|Code Studio|other studios|something else/i);
  });

  it('the keep-me-updated box names what it is for and describes the optional updates', () => {
    expect(INTEREST_UPDATES.label).toBe('Keep me updated about Comic Studio news and new DreamStream studios.');
    expect(INTEREST_UPDATES.hint).toMatch(/future releases/);
  });

  it('keeps known ids once, in order', () => {
    expect(knownMakes(['work', 'kids', 'work', 'nope', 3, null])).toEqual(['work', 'kids']);
    expect(knownHeard('friend')).toBe('friend');
    expect(knownHeard('billboard')).toBeUndefined();
    expect(knownHeard(42)).toBeUndefined();
  });

  it('the thank-you promises no email and says nothing about accounts or invites', () => {
    for (const text of Object.values(INTEREST_THANKS)) expect(text).not.toMatch(/email|inbox|account|invite|access|already/i);
  });

  it('the thank-you mentions answers only when some were given (by what was sent, never by the address)', () => {
    expect(interestThanks('access', {})).toBe('Thank you, you are on the list.');
    expect(interestThanks('access', { makes: [], keepUpdated: false })).toBe('Thank you, you are on the list.');
    expect(interestThanks('access', { comment: 'Hi' })).toMatch(/Your answers help shape what we build next\.$/);
    expect(interestThanks('access', { heardFrom: 'friend' })).toMatch(/answers/);
    expect(interestThanks('access', { makes: ['kids'] })).toMatch(/answers/);
    expect(interestThanks('updates', { comment: 'Hi' })).toBe('Thank you, you are on the list.');
  });

  it('a ticked box confirms only the saved preference', () => {
    const ticked = interestThanks('access', { keepUpdated: true });
    expect(ticked).toBe(`Thank you, you are on the list. ${INTEREST_THANKS.keptUpdated}`);
    expect(INTEREST_THANKS.keptUpdated).toMatch(/preference for updates is saved/i);
    expect(interestThanks('access', { keepUpdated: true, comment: 'Hi' })).toBe(
      `${INTEREST_THANKS.accessWithAnswers} ${INTEREST_THANKS.keptUpdated}`
    );
    // Unticked never mentions updates; the list card never does either.
    expect(interestThanks('access', { keepUpdated: false, comment: 'Hi' })).not.toMatch(/updates/);
    expect(interestThanks('updates', { keepUpdated: true })).toBe('Thank you, you are on the list.');
  });

  it('register interest always carries the box as true or false; the list card never carries it', () => {
    expect(answersForKind('access', {})).toEqual({ keepUpdated: false });
    expect(answersForKind('access', { keepUpdated: 'yes' as never })).toEqual({ keepUpdated: false });
    expect(answersForKind('access', { keepUpdated: true, comment: 'Hi' })).toEqual({ keepUpdated: true, comment: 'Hi' });
    expect(answersForKind('updates', { keepUpdated: true, comment: 'Hi' })).toEqual({ comment: 'Hi' });
  });
});

describe('cleaning', () => {
  it('a line: controls, bidi overrides and the BOM become spaces, runs collapse, ends trim', () => {
    expect(cleanLine('  A\u0000s\u0007h\u202Ea\uFEFF\n b  ')).toBe('A s h a b');
    expect(cleanLine('\u2066\u2069')).toBe('');
    // Joiners that scripts and emoji need stay.
    expect(cleanLine('क्\u200Dष 👩\u200D🎨')).toBe('क्\u200Dष 👩\u200D🎨');
  });

  it('a note: line breaks kept (CRLF folded), at most one blank line, tabs as spaces, other controls dropped', () => {
    expect(cleanBlock('One\r\nTwo\rThree\u001b\n\n\n\nFour\tfive\u2028 ')).toBe('One\nTwo\nThree\n\nFour five');
  });

  it('invisible format characters and bidi marks go; tag characters (hidden text) are removed outright', () => {
    // Zero-width space, a tag-character "A", a right-to-left mark.
    expect(cleanLine('a\u200Bb\u{E0041}\u200Fc')).toBe('a b c');
    expect(cleanLine('\u061C\u200E\u2060\u2061\u2064\u206A\u206F\uFFF9\uFFFB')).toBe('');
    // A hidden instruction spelled in tag characters leaves nothing behind.
    const hidden = [...'ignore this'].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join('');
    expect(cleanLine(`Hello${hidden}`)).toBe('Hello');
    expect(cleanBlock(`Line one\u200B\nLine two\u{E0020}\u{E007F}`)).toBe('Line one\nLine two');
    // The joiners scripts and emoji need still stay, in both.
    expect(cleanBlock('क्\u200Dष\nक्\u200Cष')).toBe('क्\u200Dष\nक्\u200Cष');
  });
});

describe('interestMetadata', () => {
  const AT = '2026-11-19T10:00:00.000Z';

  it('stores nothing extra for the email alone on the list card', () => {
    expect(interestMetadata(undefined, {}, AT)).toEqual({});
    expect(interestMetadata('auth', {}, AT)).toEqual({ source: 'auth' });
  });

  it('stores every answer under one versioned key', () => {
    expect(
      interestMetadata('auth', { firstName: 'Asha', makes: ['kids', 'pitch'], heardFrom: 'friend', comment: 'Hi' }, AT)
    ).toEqual({
      source: 'auth',
      answers: { v: 2, makes: ['kids', 'pitch'], heardFrom: 'friend', comment: 'Hi', firstName: 'Asha' }
    });
    expect(interestMetadata(undefined, { makes: [] }, AT)).toEqual({});
  });

  it('records the keep-me-updated choice as an explicit consent flag with the time and the words shown', () => {
    expect(interestMetadata('landing', { keepUpdated: true }, AT)).toEqual({
      source: 'landing',
      consent: { updates: true, at: AT, wording: INTEREST_UPDATES.label }
    });
    // Unticked is recorded as false, never left out, so no one reads a missing flag as a yes.
    expect(interestMetadata('landing', { keepUpdated: false }, AT)).toEqual({
      source: 'landing',
      consent: { updates: false, at: AT, wording: INTEREST_UPDATES.label }
    });
    // The box's choice is not an answer: it never adds an `answers` key on its own.
    expect(interestMetadata(undefined, { keepUpdated: true }, AT)).not.toHaveProperty('answers');
  });

  it('only a real true is consent', () => {
    expect((interestMetadata(undefined, { keepUpdated: 'true' as never }, AT).consent as { updates: boolean }).updates).toBe(false);
    expect((interestMetadata(undefined, { keepUpdated: 1 as never }, AT).consent as { updates: boolean }).updates).toBe(false);
  });
});

describe('the main site\'s list card (kind "updates")', () => {
  it('describes joining the list independently of delivery settings', () => {
    const all = Object.values(UPDATES_CARD).join(' ');
    expect(all).not.toMatch(/keep me posted|stay updated|no spam|invite|launch notes|early access|heads-up|we will email|we'll email/i);
    expect(UPDATES_CARD.body).toMatch(/join the Stream Studio interest list/);
  });

  it('is what the main front page shows (no older promise left in it)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const home = readFileSync(path.resolve(__dirname, '..', 'components', 'HomePage.tsx'), 'utf8');
    const card = home.slice(home.indexOf('id="stay-updated"'), home.indexOf('{/* Footer */}'));
    for (const key of ['eyebrow', 'title', 'body', 'button']) expect(card).toContain(`UPDATES_CARD.${key}`);
    expect(card).not.toMatch(/Keep me posted|No spam|early access invites|launch notes/);
  });
});
