// @vitest-environment node
// The director's tool schemas, as every function-calling provider receives them (B-TOOL review). Some validators refuse
// an OBJECT schema with no properties ("properties: should be non-empty for OBJECT type"), and where one is accepted a
// model fills declared keys most reliably, so a free-form object can arrive as {}. Every object in a core tool (and in
// offer_next, which takes a free seat every turn it can) declares its keys.

import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { buildDirectorTools, createDirectorTurn, offerNextTool } from './tools.js';
import { letteringToolGroup } from './tools/lettering.js';

vi.spyOn(console, 'info').mockImplementation(() => undefined);

/** The JSON paths of every `type: 'object'` schema without a non-empty `properties`. */
function propertyLessObjects(schema: unknown, path: string, out: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as { type?: unknown; properties?: Record<string, unknown>; items?: unknown };
  if (s.type === 'object' && (!s.properties || typeof s.properties !== 'object' || !Object.keys(s.properties).length)) out.push(path);
  for (const [key, value] of Object.entries(s.properties ?? {})) propertyLessObjects(value, `${path}.${key}`, out);
  if (s.items) propertyLessObjects(s.items, `${path}[]`, out);
  return out;
}

describe('director tool schemas', () => {
  it('every object in a core tool (and offer_next) declares its keys: no type:object with missing or empty properties', () => {
    for (const doc of [plannedDoc(), createEmptyDoc('proj-1')]) {
      const ctx = testContext(newSession(doc));
      const turn = createDirectorTurn({ userText: 'x' });
      const tools = [...buildDirectorTools(ctx, turn), offerNextTool(ctx, turn)];
      expect(tools.length).toBeGreaterThan(20);
      const bad = tools.flatMap((t) => propertyLessObjects(t.spec.function.parameters, t.spec.function.name));
      expect(bad).toEqual([]);
    }
  });

  it('the walker finds what it guards against (a nested free-form object, in an array too)', () => {
    expect(propertyLessObjects({ type: 'object', properties: { a: { type: 'object' }, b: { type: 'array', items: { type: 'object', properties: {} } } } }, 't')).toEqual(['t.a', 't.b[]']);
  });

  it('the shapes the review named are typed: look, the line targets, place, style, an option picture', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const params = new Map(buildDirectorTools(ctx, createDirectorTurn({ userText: 'x' })).map((t) => [t.spec.function.name, t.spec.function.parameters as { properties: Record<string, { properties?: Record<string, unknown>; items?: { properties?: Record<string, { properties?: Record<string, unknown> }> } }> }]));
    expect(Object.keys(params.get('upsert_character')!.properties.look.properties!)).toEqual(
      expect.arrayContaining(['summary', 'age', 'hair', 'outfit', 'palette', 'species', 'markings'])
    );
    for (const tool of ['set_line', 'edit_panel_text']) expect(Object.keys(params.get(tool)!.properties.target.properties!).sort()).toEqual(['line_ids', 'selected', 'speaker', 'text_contains']);
    expect(Object.keys(params.get('dialogue_edit')!.properties.place.properties!)).toHaveLength(8);
    expect(Object.keys(params.get('dialogue_edit')!.properties.style.properties!)).toContain('font');
    expect(Object.keys(params.get('ask_user')!.properties.options.items!.properties!.visual.properties!).sort()).toEqual(['cell', 'kind', 'lineId', 'page', 'panel']);
  });
});

/**
 * D13 (S2b integration): the static half of the Gemini acceptance check (the paid admin turn stays the owner's call).
 * Gemini function declarations take an OpenAPI-style subset: one `type` per node (string, number, integer, boolean,
 * array, object), `enum` on strings only, `items` on arrays, non-empty `properties` with `required` naming declared
 * keys on objects, plus description, nullable, format and the numeric / length bounds. Anything else ($ref, oneOf, anyOf,
 * allOf, const, additionalProperties, a type list, default, examples) can fail the whole request, which would break every
 * director turn. Returns one line per offence, `path: why`.
 */
const GEMINI_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'title']);
const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
function outsideGeminiSubset(schema: unknown, path: string, out: string[] = []): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    out.push(`${path}: not a schema object`);
    return out;
  }
  const s = schema as Record<string, unknown> & { properties?: Record<string, unknown>; enum?: unknown; required?: unknown };
  for (const key of Object.keys(s)) if (!GEMINI_KEYS.has(key)) out.push(`${path}: ${key}`);
  if (typeof s.type !== 'string' || !GEMINI_TYPES.has(s.type)) out.push(`${path}: type ${JSON.stringify(s.type)}`);
  if (s.enum !== undefined) {
    if (s.type !== 'string') out.push(`${path}: enum on ${String(s.type)}`);
    if (!Array.isArray(s.enum) || !s.enum.length || s.enum.some((v) => typeof v !== 'string')) out.push(`${path}: enum values`);
    else if (new Set(s.enum).size !== s.enum.length) out.push(`${path}: duplicate enum values`);
  }
  if (s.type === 'array') {
    if (s.items === undefined) out.push(`${path}: array without items`);
    else outsideGeminiSubset(s.items, `${path}[]`, out);
  } else if (s.items !== undefined) out.push(`${path}: items on ${String(s.type)}`);
  if (s.type === 'object') {
    const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
    if (!Object.keys(props).length) out.push(`${path}: object without properties`);
    for (const [key, value] of Object.entries(props)) outsideGeminiSubset(value, `${path}.${key}`, out);
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string' || !(r in props)))) out.push(`${path}: required names an undeclared key`);
  } else if (s.properties !== undefined || s.required !== undefined) out.push(`${path}: properties on ${String(s.type)}`);
  return out;
}

describe('B-TOOL schemas inside the Gemini function-declaration subset (D13, static)', () => {
  it('every core tool, offer_next and the lettering group: nothing outside the subset, valid names', () => {
    for (const doc of [plannedDoc(), createEmptyDoc('proj-1')]) {
      const ctx = testContext(newSession(doc));
      const turn = createDirectorTurn({ userText: 'x' });
      const tools = [...buildDirectorTools(ctx, turn), offerNextTool(ctx, turn), ...letteringToolGroup.tools(ctx, turn)];
      const names = tools.map((t) => t.spec.function.name);
      expect(names).toEqual(expect.arrayContaining(['dialogue_edit', 'ask_user', 'upsert_character', 'offer_next', 'set_lettering_style']));
      expect(names.filter((n) => !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(n))).toEqual([]);
      expect(tools.flatMap((t) => outsideGeminiSubset(t.spec.function.parameters, t.spec.function.name))).toEqual([]);
    }
  });

  it('the subset walker flags what it guards against', () => {
    const bad = {
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: ['string', 'null'] },
        b: { type: 'number', enum: [1, 2] },
        c: { oneOf: [{ type: 'string' }] },
        d: { type: 'array' },
        e: { type: 'string', const: 'x' },
        f: { $ref: '#/defs/x' }
      },
      required: ['a', 'zz']
    };
    expect(outsideGeminiSubset(bad, 't')).toEqual([
      't: additionalProperties',
      't.a: type ["string","null"]',
      't.b: enum on number',
      't.b: enum values',
      't.c: oneOf',
      't.c: type undefined',
      't.d: array without items',
      't.e: const',
      't.f: $ref',
      't.f: type undefined',
      't: required names an undeclared key'
    ]);
  });
});
