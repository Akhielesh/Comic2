import { describe, it, expect } from 'vitest';
import { ARTIFACT_TYPES } from './artifacts/ChatArtifacts';
import { GALLERY_DEMO_TYPES } from './ComponentGallery';

// Enforces the project rule: every rich-output component the renderer can display
// MUST have a live demo in the ComponentGallery (Settings → Gallery tab). This is
// what guarantees a newly-added component/visual always shows up in the gallery —
// add a renderer without a gallery demo and this test fails.
describe('gallery covers every renderable artifact', () => {
  it('every artifact type the renderer supports has a gallery demo', () => {
    const missing = ARTIFACT_TYPES.filter((t) => !GALLERY_DEMO_TYPES.includes(t));
    expect(missing, `Add a demo to ComponentGallery for: ${missing.join(', ')}`).toEqual([]);
  });

  it('gallery demos only reference real, renderable artifact types', () => {
    const unknown = GALLERY_DEMO_TYPES.filter((t) => !ARTIFACT_TYPES.includes(t));
    expect(unknown, `Gallery references unknown artifact types: ${unknown.join(', ')}`).toEqual([]);
  });
});
