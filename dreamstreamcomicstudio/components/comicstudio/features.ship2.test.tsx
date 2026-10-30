// K2b (pro plan §10 Wave 3 client stubs): the pro editor's feature folders join the registry BEFORE Comic History, which
// stays the last, lowest-precedence module (H0's rule). The K2b stubs register nothing, so they are left out entirely;
// here the editor stub is mocked to register one admin section, the way its package (C7) will, to pin the order.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./editor/index', () => ({
  feature: { adminSections: [{ id: 'editor-probe', label: 'Editor probe', Component: () => null }] }
}));

import { featureModules, registeredAdminSections } from './features';
import { feature as editorFeature } from './editor/index';
import { feature as historyFeature } from './history/index';
import { feature as confidenceFeature } from './confidence/index';
import { feature as consistencyFeature } from './consistency/index';
import { feature as saveFeature } from './save/index';
import { feature as guideFeature } from './guide/index';

describe('Ship 2 client modules in the feature registry', () => {
  it('a Ship 2 module that registers something sits before Comic History, which stays last', () => {
    const mods = featureModules();
    expect(mods[mods.length - 1]).toBe(historyFeature);
    expect(mods[mods.length - 2]).toBe(editorFeature);
    expect(registeredAdminSections().map((s) => s.id)).toContain('editor-probe');
  });

  it('the stubs that register nothing are left out (the registries are exactly what they were)', () => {
    const mods = featureModules();
    for (const stub of [confidenceFeature, consistencyFeature, saveFeature, guideFeature]) {
      expect(stub).toEqual({});
      expect(mods).not.toContain(stub);
    }
  });
});
