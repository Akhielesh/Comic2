import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../../../../shared/comic/doc.js';
import { StudioError } from '../types.js';
import { ACTION_HANDLERS, actionHandlerFor } from './index.js';
import { changeImageModelAction, MODELS_ACTIONS, NOT_BUILT_MESSAGE } from './models.js';

describe('models actions (M0 seam)', () => {
  it('registers change_image_model as a non-spend feature action', () => {
    expect(MODELS_ACTIONS.map((h) => h.type)).toEqual(['change_image_model']);
    expect(ACTION_HANDLERS.change_image_model).toBe(changeImageModelAction);
    expect(actionHandlerFor('change_image_model')?.spend).toBe(false);
  });

  it('refuses with a calm 501 and switches nothing until M1-LOCK-SERVER lands', async () => {
    const doc = createEmptyDoc('proj-1');
    const before = JSON.stringify(doc);
    const ctx = { session: { doc, commit: () => { throw new Error('must not commit'); } } } as never;
    const action = { type: 'change_image_model', modelId: 'openai/gpt-image-1', redraw: 'none', quotedUsd: 0, ack: true } as never;
    const err = await changeImageModelAction.run(ctx, action, { confirmed: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).code).toBe('NOT_AVAILABLE');
    expect((err as StudioError).status).toBe(501);
    expect((err as StudioError).userMessage).toBe(NOT_BUILT_MESSAGE);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
