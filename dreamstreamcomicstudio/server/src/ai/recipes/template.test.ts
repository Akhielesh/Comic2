import { describe, it, expect } from 'vitest';
import { renderTemplate, referencedVariables } from './template.js';

describe('renderTemplate', () => {
  it('substitutes simple variables (whitespace-insensitive)', () => {
    expect(renderTemplate('Hello {{ name }}!', { name: 'Ada' })).toBe('Hello Ada!');
    expect(renderTemplate('Hello {{name}}!', { name: 'Ada' })).toBe('Hello Ada!');
  });

  it('renders missing variables as empty strings', () => {
    expect(renderTemplate('x={{ missing }}.', {})).toBe('x=.');
  });

  it('applies the default filter only when the value is empty', () => {
    expect(renderTemplate('{{ tone | default("hopeful") }}', {})).toBe('hopeful');
    expect(renderTemplate("{{ tone | default('hopeful') }}", { tone: 'noir' })).toBe('noir');
    // numeric 0 / false / "" are all "empty" → default kicks in
    expect(renderTemplate('{{ n | default("z") }}', { n: 0 })).toBe('z');
  });

  it('coerces booleans and numbers to strings', () => {
    expect(renderTemplate('{{ a }}/{{ b }}', { a: true, b: 3 })).toBe('true/3');
  });

  it('handles if/endif blocks', () => {
    const t = 'A{% if show %}-B{% endif %}-C';
    expect(renderTemplate(t, { show: true })).toBe('A-B-C');
    expect(renderTemplate(t, { show: false })).toBe('A-C');
  });

  it('handles if/else blocks', () => {
    const t = '{% if premium %}gold{% else %}free{% endif %}';
    expect(renderTemplate(t, { premium: true })).toBe('gold');
    expect(renderTemplate(t, { premium: false })).toBe('free');
  });

  it('does not emit variables inside a dropped branch', () => {
    const t = '{% if show %}secret={{ secret }}{% endif %}done';
    expect(renderTemplate(t, { show: false, secret: 'X' })).toBe('done');
  });

  it('handles nested conditionals', () => {
    const t = '{% if a %}A{% if b %}B{% endif %}{% endif %}';
    expect(renderTemplate(t, { a: true, b: true })).toBe('AB');
    expect(renderTemplate(t, { a: true, b: false })).toBe('A');
    expect(renderTemplate(t, { a: false, b: true })).toBe('');
  });

  it('returns empty for undefined templates', () => {
    expect(renderTemplate(undefined, {})).toBe('');
  });
});

describe('referencedVariables', () => {
  it('collects variable and conditional keys', () => {
    const vars = referencedVariables('{{ topic }} {% if deep %}{{ depth }}{% endif %}');
    expect(vars.sort()).toEqual(['deep', 'depth', 'topic']);
  });
});
