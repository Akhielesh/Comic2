import { describe, it, expect } from 'vitest';
import { ARTIFACT_TYPES } from './artifacts/ChatArtifacts';
import { ARTIFACT_TOOLS, MODEL_AUTHORED, EXAMPLE_PROMPT } from './widgetStudioMeta';
import { TOOL_CATALOG } from '../../toolCatalog';

// The Widget Studio (Gallery view) maps every artifact/visual to the tool(s)/API(s)
// that can feed it. These tests keep that mapping honest as widgets are added:
//   - every renderable widget has a data source (or is explicitly model-authored),
//   - every mapped tool is a real catalogue tool (so the Studio shows its provider/
//     auth/rate-limit/spec instead of a blank),
//   - the map never references a type the renderer can't display.

describe('widget studio metadata coverage', () => {
  it('every renderable artifact type has a data source or is model-authored', () => {
    const missing = ARTIFACT_TYPES.filter((t) => !(ARTIFACT_TOOLS[t]?.length) && !MODEL_AUTHORED.has(t));
    expect(missing, `Add an ARTIFACT_TOOLS mapping (or MODEL_AUTHORED) for: ${missing.join(', ')}`).toEqual([]);
  });

  it('every mapped tool resolves to a real catalogue tool', () => {
    const names = new Set(TOOL_CATALOG.map((t) => t.name));
    const unknown = [...new Set(Object.values(ARTIFACT_TOOLS).flat())].filter((tool) => !names.has(tool));
    expect(unknown, `ARTIFACT_TOOLS references tools missing from TOOL_CATALOG: ${unknown.join(', ')}`).toEqual([]);
  });

  it('ARTIFACT_TOOLS only keys real, renderable artifact types', () => {
    const unknown = Object.keys(ARTIFACT_TOOLS).filter((t) => !ARTIFACT_TYPES.includes(t));
    expect(unknown, `ARTIFACT_TOOLS has keys that aren't artifact types: ${unknown.join(', ')}`).toEqual([]);
  });

  it('example prompts reference real artifact types', () => {
    const unknown = Object.keys(EXAMPLE_PROMPT).filter((t) => !ARTIFACT_TYPES.includes(t));
    expect(unknown, `EXAMPLE_PROMPT has keys that aren't artifact types: ${unknown.join(', ')}`).toEqual([]);
  });
});
