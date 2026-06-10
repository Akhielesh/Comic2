import { describe, it, expect } from 'vitest';
import { CHAT_SKILLS, SKILL_CATEGORIES, findSkill, isSlashQuery, slashQuery, filterSkills, parseSkillInput } from './chatSkills';

describe('chat skills', () => {
  it('exposes the curated commands (presets folded into aliases)', () => {
    for (const cmd of ['learn', 'trip', 'research', 'market', 'comic', 'script', 'audit', 'build']) {
      expect(findSkill(cmd), `missing /${cmd}`).toBeDefined();
    }
    // The old preset commands still resolve as aliases of the real features.
    expect(findSkill('deepresearch')?.command).toBe('research');
    expect(findSkill('stock')?.command).toBe('market');
    // every skill points at a recipe id, has a sane argName, and sits on a shelf
    const shelves = new Set(SKILL_CATEGORIES.map((c) => c.id));
    for (const s of CHAT_SKILLS) {
      expect(s.recipeId).toBeTruthy();
      expect(s.argName).toBeTruthy();
      expect(shelves.has(s.category), `unknown category for /${s.command}`).toBe(true);
    }
  });

  it('resolves aliases', () => {
    expect(findSkill('financial')?.command).toBe('market');
    expect(findSkill('deep')?.command).toBe('research');
    expect(findSkill('FINANCE')?.command).toBe('market'); // case-insensitive
    expect(findSkill('course')?.command).toBe('learn');
    expect(findSkill('travel')?.command).toBe('trip');
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

  it('reads depth cues from the research argument', () => {
    const deep = parseSkillInput('/research deep dive on quantum error correction');
    expect(deep?.skill.buildValues(deep!.arg)).toEqual({ topic: 'quantum error correction', depth: 'exhaustive' });
    const quick = parseSkillInput('/research quick look at fusion');
    expect(quick?.skill.buildValues(quick!.arg)).toEqual({ topic: 'fusion', depth: 'quick' });
  });

  it('parses the trip argument into destination and days', () => {
    const p = parseSkillInput('/trip Tokyo, 5 days');
    expect(p?.skill.recipeId).toBe('travel-planner');
    expect(p?.skill.buildValues(p!.arg)).toEqual({ destination: 'Tokyo', days: '5' });
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

  it('exposes the productivity skills (/goal, /code-review, /loop)', () => {
    for (const cmd of ['goal', 'code-review', 'loop']) {
      expect(findSkill(cmd), `missing /${cmd}`).toBeDefined();
    }
    expect(findSkill('goal')?.recipeId).toBe('goal-coach');
    expect(findSkill('cr')?.command).toBe('code-review');
    expect(findSkill('monitor')?.command).toBe('loop');
  });

  it('supports hyphenated commands end to end (/deep-research, /code-review)', () => {
    expect(isSlashQuery('/deep-res')).toBe(true);
    expect(isSlashQuery('/code-review src/app.ts')).toBe(false); // space → no longer a query
    expect(findSkill('deep-research')?.command).toBe('research');
    const p = parseSkillInput('/deep-research solid-state batteries');
    expect(p?.skill.recipeId).toBe('deep-research-brief');
    const cr = parseSkillInput('/code-review https://github.com/acme/app/pull/12');
    expect(cr?.skill.recipeId).toBe('code-review');
    expect(cr?.skill.buildValues(cr!.arg)).toEqual({ target: 'https://github.com/acme/app/pull/12' });
  });

  it('parses the loop interval prefix and clamps it to the monitor bounds', () => {
    const loop = findSkill('loop')!;
    expect(loop.buildValues('5m NVDA stock')).toEqual({ request: 'NVDA stock', interval_sec: 300 });
    expect(loop.buildValues('30s bitcoin')).toEqual({ request: 'bitcoin', interval_sec: 30 });
    expect(loop.buildValues('2h weather in Tokyo')).toEqual({ request: 'weather in Tokyo', interval_sec: 3600 }); // clamped to 1h
    expect(loop.buildValues('5s btc')).toEqual({ request: 'btc', interval_sec: 30 }); // clamped to 30s floor
    // No interval prefix → 5-minute default, full text kept as the request.
    expect(loop.buildValues('gold price')).toEqual({ request: 'gold price', interval_sec: 300 });
  });
});
