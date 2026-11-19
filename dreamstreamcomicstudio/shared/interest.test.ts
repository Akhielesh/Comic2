// @vitest-environment node
// The register-interest vocabulary, its cleaning and the one stored shape both paths write.
import { describe, expect, it } from 'vitest';
import {
  INTEREST_FEATURES,
  INTEREST_FEATURES_QUESTION,
  INTEREST_STUDIOS,
  INTEREST_THANKS,
  UPDATES_CARD,
  cleanBlock,
  cleanLine,
  interestMetadata,
  interestThanks,
  knownFeatures,
  knownStudios
} from './interest';

describe('the questions', () => {
  it('offers the Comic Studio abilities and near plans, and only studios that exist', () => {
    expect(INTEREST_FEATURES.map((f) => f.id)).toEqual(['chat', 'translations', 'series', 'library', 'print']);
    expect(INTEREST_STUDIOS.map((s) => s.id)).toEqual(['chat_studio', 'stream_studio', 'dashboards']);
    // Code Studio was retired (docs/decisions/0005-retire-code-studio.md): never asked about.
    expect(INTEREST_STUDIOS.map((s) => s.label)).not.toContain('Code Studio');
  });

  it('asks about wishes as well as use, since some abilities are not built yet', () => {
    expect(INTEREST_FEATURES_QUESTION).toBe('What would you use, or like to see?');
  });

  it('keeps known ids once, in order; an older tab may still send comic_studio or code_studio', () => {
    expect(knownFeatures(['print', 'chat', 'print', 'nope', 3, null])).toEqual(['print', 'chat']);
    expect(knownStudios(['comic_studio', 'dashboards', 'comic_studio', 'make_studio'])).toEqual(['comic_studio', 'dashboards']);
    expect(knownStudios(['code_studio', 'chat_studio'])).toEqual(['code_studio', 'chat_studio']);
  });

  it('the thank-you promises no email and says nothing about accounts or invites', () => {
    for (const text of Object.values(INTEREST_THANKS)) expect(text).not.toMatch(/email|inbox|account|invite|access|already/i);
  });

  it('the thank-you mentions answers only when some were given (by what was sent, never by the address)', () => {
    expect(interestThanks('access', {})).toBe('Thank you, you are on the list.');
    expect(interestThanks('access', { features: [] })).not.toMatch(/answers/);
    expect(interestThanks('access', { comment: 'Hi' })).toMatch(/Your answers help shape what we build next\.$/);
    expect(interestThanks('access', { studios: ['dashboards'] })).toMatch(/answers/);
    expect(interestThanks('updates', { comment: 'Hi' })).toBe('Thank you, you are on the list.');
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
  it('stores nothing extra for the email alone', () => {
    expect(interestMetadata(undefined, {})).toEqual({});
    expect(interestMetadata('auth', {})).toEqual({ source: 'auth' });
  });

  it('stores every answer under one versioned key', () => {
    expect(
      interestMetadata('auth', { firstName: 'Asha', features: ['chat'], featureOther: 'Voice', studios: ['dashboards'], comment: 'Hi' })
    ).toEqual({
      source: 'auth',
      answers: { v: 1, features: ['chat'], other: 'Voice', studios: ['dashboards'], comment: 'Hi', firstName: 'Asha' }
    });
    expect(interestMetadata(undefined, { features: [], studios: [] })).toEqual({});
  });
});

describe('the main site\'s list card (kind "updates")', () => {
  it('promises no email, update or invite while none are sent, and says so', () => {
    const all = Object.values(UPDATES_CARD).join(' ');
    expect(all).not.toMatch(/keep me posted|stay updated|no spam|invite|launch notes|early access|heads-up|we will email|we'll email/i);
    expect(UPDATES_CARD.body).toMatch(/not sending any emails yet/);
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
