// @vitest-environment node
// The director's tool schemas, as every function-calling provider receives them (B-TOOL review). Some validators refuse
// an OBJECT schema with no properties ("properties: should be non-empty for OBJECT type"), and where one is accepted a
// model fills declared keys most reliably, so a free-form object can arrive as {}. Every object in a core tool (and in
// offer_next, which takes a free seat every turn it can) declares its keys.

import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { buildDirectorTools, createDirectorTurn, offerNextTool } from './tools.js';

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
