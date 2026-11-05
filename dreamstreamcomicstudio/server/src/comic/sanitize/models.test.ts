import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { StudioError } from '../types.js';
import { OP_SANITIZERS } from './index.js';
import { MODELS_SANITIZERS, assertSettingsPatchAllowed, lockedSettingsMessage, modelName } from './models.js';

const unlocked = (): ComicDoc => createEmptyDoc('proj-1', 'Lake');
const locked = (modelId = 'nano-banana-2.1'): ComicDoc => ({ ...unlocked(), imageModel: { modelId, lockedAt: 1, origin: 'first_render' } });
/** Drawn before the lock existed: a generated page on Nano Banana Pro, nothing persisted (deriveLock). */
const legacy = (): ComicDoc => {
  const doc = unlocked();
  doc.cover = { ...doc.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'u/a/p/b/c.webp', source: 'generated', model: 'nano-banana-pro', at: 5 } } };
  return doc;
};

describe('settings patches on a locked comic (models.md §3.4 item 5)', () => {
  it('accepts imageModelOverride before the lock', () => {
    expect(() => assertSettingsPatchAllowed(unlocked(), { imageModelOverride: 'nano-banana-pro' })).not.toThrow();
  });

  it('refuses a change after the lock with 409 MODEL_LOCKED and the exact copy', () => {
    let err: unknown;
    try {
      assertSettingsPatchAllowed(locked(), { imageModelOverride: 'nano-banana-pro' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ code: 'MODEL_LOCKED', status: 409, userMessage: 'This comic is locked to Nano Banana 2.1. Use Change model (consistency can be affected).' });
  });

  it("a legacy comic's derived lock counts, clearing counts, an echo of the current value and a tier change do not", () => {
    expect(() => assertSettingsPatchAllowed(legacy(), { imageModelOverride: 'nano-banana-2.1' })).toThrow(lockedSettingsMessage('nano-banana-pro'));
    const withOverride = { ...locked(), settings: { ...locked().settings, imageModelOverride: 'nano-banana-2.1' } };
    expect(() => assertSettingsPatchAllowed(withOverride, { imageModelOverride: undefined })).toThrow(/locked/);
    expect(() => assertSettingsPatchAllowed(withOverride, { imageModelOverride: 'nano-banana-2.1' })).not.toThrow();
    expect(() => assertSettingsPatchAllowed(locked(), { quality: 'pro' })).not.toThrow();
  });

  it('names a model the registry no longer lists by its id (never re-pointed to another name)', () => {
    expect(modelName('ghost-model')).toBe('ghost-model');
    expect(lockedSettingsMessage('ghost-model')).toBe('This comic is locked to ghost-model. Use Change model (consistency can be affected).');
  });

  it('registers no feature op: the lock op is server-only and settings is a core op', () => {
    expect(MODELS_SANITIZERS).toEqual([]);
    expect(OP_SANITIZERS.image_model).toBeUndefined();
  });
});
