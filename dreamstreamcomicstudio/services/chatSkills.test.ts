import { describe, it, expect } from 'vitest';
import { CHAT_SKILLS, findSkill, isSlashQuery, slashQuery, filterSkills, parseSkillInput } from './chatSkills';

describe('chat skills', () => {
  it('exposes the user-requested commands', () => {
    for (const cmd of ['research', 'deepresearch', 'market', 'stock', 'science']) {
      expect(findSkill(cmd), `missing /${cmd}`).toBeDefined();
    }
    // every skill points at a recipe id and has a sane argName
    for (const s of CHAT_SKILLS) {
      expect(s.recipeId).toBeTruthy();
      expect(s.argName).toBeTruthy();
    }
  });

  it('resolves aliases', () => {
    expect(findSkill('financial')?.command).toBe('market');
    expect(findSkill('deep')?.command).toBe('deepresearch');
    expect(findSkill('FINANCE')?.command).toBe('market'); // case-insensitive
  });

  it('detects a slash query only before a space', () => {
    expect(isSlashQuery('/res')).toBe(true);
    expect(isSlashQuery('/research fusion')).toBe(false);
    expect(isSlashQuery('hello')).toBe(false);
    expect(slashQuery('/Res')).toBe('res');
  });

  it('filters skills by prefix and label', () => {
    const res = filterSkills('res');
    expect(res.some((s) => s.command === 'research')).toBe(true);
    expect(filterSkills('').length).toBe(CHAT_SKILLS.length);
  });

  it('parses /command + argument into the recipe values', () => {
    const p = parseSkillInput('/research solid-state batteries');
    expect(p?.skill.recipeId).toBe('deep-research-brief');
    expect(p?.arg).toBe('solid-state batteries');
    expect(p?.skill.buildValues(p!.arg)).toEqual({ topic: 'solid-state batteries', depth: 'standard' });
  });

  it('deepresearch maps to exhaustive depth', () => {
    const p = parseSkillInput('/deepresearch quantum error correction');
    expect(p?.skill.buildValues(p!.arg)).toEqual({ topic: 'quantum error correction', depth: 'exhaustive' });
  });

  it('returns null for unknown commands (so they send as plain text)', () => {
    expect(parseSkillInput('/notareal thing')).toBeNull();
    expect(parseSkillInput('just a message')).toBeNull();
  });

  it('allows no-argument skills like /market', () => {
    const p = parseSkillInput('/market');
    expect(p?.skill.command).toBe('market');
    expect(p?.arg).toBe('');
    expect(p?.skill.argRequired).toBe(false);
  });
});
