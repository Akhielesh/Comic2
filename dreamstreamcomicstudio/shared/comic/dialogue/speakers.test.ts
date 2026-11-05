// B-RESOLVE speakers.ts (agent-editor plan §3 B2): a speaker resolves only on ONE candidate.
import { describe, expect, it } from 'vitest';
import { castList, matchSpeaker, noSuchSpeaker, normalizeSpeakerName } from './speakers';
import { apply, dialogueDoc } from './__fixtures__/dialogueDoc';

describe('matchSpeaker', () => {
  const doc = dialogueDoc();

  it('a first name finds the full name ("Mira" → "Mira Patel"), in any case', () => {
    expect(matchSpeaker(doc, 'Mira')).toEqual({ status: 'one', characterId: 'c_mira' });
    expect(matchSpeaker(doc, 'mira')).toEqual({ status: 'one', characterId: 'c_mira' });
    expect(matchSpeaker(doc, "Mira's")).toEqual({ status: 'one', characterId: 'c_mira' });
    expect(matchSpeaker(doc, 'MIRA PATEL')).toEqual({ status: 'one', characterId: 'c_mira' });
  });

  it('exact id first, then exact name', () => {
    expect(matchSpeaker(doc, 'c_leo')).toEqual({ status: 'one', characterId: 'c_leo' });
    expect(matchSpeaker(doc, 'Leo')).toEqual({ status: 'one', characterId: 'c_leo' });
  });

  it('"the robot" → the cast member whose kind is robot', () => {
    expect(matchSpeaker(doc, 'the robot')).toEqual({ status: 'one', characterId: 'c_bolt' });
    expect(matchSpeaker(doc, 'the droid')).toEqual({ status: 'one', characterId: 'c_bolt' });
    expect(matchSpeaker(doc, "the robot's")).toEqual({ status: 'one', characterId: 'c_bolt' });
  });

  it('a role word finds the cast member with that role ("her mom")', () => {
    expect(matchSpeaker(doc, 'her mom')).toEqual({ status: 'one', characterId: 'c_asha' });
    expect(matchSpeaker(doc, 'the mother')).toEqual({ status: 'one', characterId: 'c_asha' });
  });

  it('a unique 3+ letter prefix resolves; a shorter one does not', () => {
    expect(matchSpeaker(doc, 'Mir')).toEqual({ status: 'one', characterId: 'c_mira' });
    expect(matchSpeaker(doc, 'Mi')).toEqual({ status: 'none' });
  });

  it('two Miras → the candidates, never a guess', () => {
    const two = apply(doc, [{ op: 'character', id: 'c_mira2', patch: { name: 'Mira', tier: 'extra', look: { summary: 'Another Mira' } } }]);
    // An exact "Mira" exists now, but "Mira Patel" is still another Mira: the exact name wins only when it is unique.
    expect(matchSpeaker(two, 'Mira')).toEqual({ status: 'one', characterId: 'c_mira2' });
    const twins = apply(doc, [{ op: 'character', id: 'c_mira2', patch: { name: 'Mira Shah', tier: 'extra', look: { summary: 'Another Mira' } } }]);
    expect(matchSpeaker(twins, 'Mira')).toEqual({ status: 'many', characterIds: ['c_mira', 'c_mira2'] });
    // A shared last name is ambiguous too.
    expect(matchSpeaker(doc, 'Patel')).toEqual({ status: 'many', characterIds: ['c_mira', 'c_asha'] });
    // Two robots: "the robot" asks.
    const robots = apply(doc, [{ op: 'character', id: 'c_bot2', patch: { name: 'Zap', tier: 'extra', kind: 'robot', look: { summary: 'A drone' } } }]);
    expect(matchSpeaker(robots, 'the robot')).toEqual({ status: 'many', characterIds: ['c_bolt', 'c_bot2'] });
  });

  it('a pronoun means only the speaker in focus, never a name that starts with it', () => {
    const herbert = apply(doc, [{ op: 'character', id: 'c_herb', patch: { name: 'Herbert', tier: 'extra', look: { summary: 'A janitor' } } }]);
    expect(matchSpeaker(herbert, 'her')).toEqual({ status: 'none' });
    expect(matchSpeaker(herbert, 'her', { pronounOf: 'c_mira' })).toEqual({ status: 'one', characterId: 'c_mira' });
    expect(matchSpeaker(herbert, 'Her')).toEqual({ status: 'none' });
    expect(matchSpeaker(herbert, 'Herb')).toEqual({ status: 'one', characterId: 'c_herb' });
  });

  it('nobody → none, with an honest sentence naming the cast', () => {
    expect(matchSpeaker(doc, 'Zelda')).toEqual({ status: 'none' });
    expect(matchSpeaker(doc, '')).toEqual({ status: 'none' });
    expect(noSuchSpeaker(doc, 'Zelda')).toBe("There's no character called “Zelda”. The cast is Mira Patel, Leo, Bolt and Asha Patel.");
    expect(castList(doc, ['c_mira', 'c_leo'])).toBe('Mira Patel and Leo');
  });

  it('normalizes names as typed', () => {
    expect(normalizeSpeakerName('  The Robot’s ')).toBe('robot');
    expect(normalizeSpeakerName('her Mom')).toBe('mom');
  });
});
