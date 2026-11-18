// @vitest-environment node
// The register-interest vocabulary, its cleaning and the one stored shape both paths write.
import { describe, expect, it } from 'vitest';
import {
  INTEREST_FEATURES,
  INTEREST_STUDIOS,
  INTEREST_THANKS,
  cleanBlock,
  cleanLine,
  interestMetadata,
  knownFeatures,
  knownStudios
} from './interest';

describe('the questions', () => {
  it('offers the Comic Studio abilities and near plans, and the studios the form already offered', () => {
    expect(INTEREST_FEATURES.map((f) => f.id)).toEqual(['chat', 'translations', 'series', 'library', 'print']);
    expect(INTEREST_STUDIOS.map((s) => s.id)).toEqual(['chat_studio', 'code_studio', 'stream_studio', 'dashboards']);
  });

  it('keeps known ids once, in order; an older tab may still send comic_studio', () => {
    expect(knownFeatures(['print', 'chat', 'print', 'nope', 3, null])).toEqual(['print', 'chat']);
    expect(knownStudios(['comic_studio', 'dashboards', 'comic_studio', 'make_studio'])).toEqual(['comic_studio', 'dashboards']);
  });

  it('the thank-you promises no email and says nothing about accounts or invites', () => {
    for (const text of Object.values(INTEREST_THANKS)) expect(text).not.toMatch(/email|inbox|account|invite|access|already/i);
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
