import { describe, it, expect } from 'vitest';
import { annotateModel } from './catalogAnnotations.js';
import type { CatalogModel } from './providers/types.js';

const base = (over: Partial<CatalogModel>): CatalogModel => ({
  id: 'x/y',
  name: 'Y',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: ['response_format'],
  pricing: { promptPerToken: 0.000002, completionPerToken: 0.000002, imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: true,
  ...over
});

describe('annotateModel', () => {
  it('flags text->image-only models for weak character consistency', () => {
    const a = annotateModel(
      base({
        supportsImageOutput: true,
        supportsImageInput: false,
        outputModalities: ['image'],
        pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.04, requestFlat: 0 }
      })
    );
    expect(a.roles).toContain('panel-art');
    expect(a.drawbacks.join(' ')).toMatch(/reference images/i);
  });

  it('marks reference-capable image models as consistency-friendly', () => {
    const a = annotateModel(
      base({
        supportsImageOutput: true,
        supportsImageInput: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['image'],
        pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.02, requestFlat: 0 }
      })
    );
    expect(a.possibilities.join(' ')).toMatch(/consistency/i);
    expect(a.costBand).toBe('medium');
  });

  it('warns when a text model lacks JSON mode', () => {
    const a = annotateModel(base({ supportsJsonOutput: false, supportedParameters: [] }));
    expect(a.drawbacks.join(' ')).toMatch(/structured-output/i);
  });

  it('bands free models and notes rate limits', () => {
    const a = annotateModel(
      base({ isFree: true, pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 } })
    );
    expect(a.costBand).toBe('free');
    expect(a.drawbacks.join(' ')).toMatch(/rate limit/i);
  });

  it('applies the editorial override for Nano Banana', () => {
    const a = annotateModel(
      base({
        id: 'google/gemini-2.5-flash-image',
        supportsImageOutput: true,
        supportsImageInput: true,
        outputModalities: ['image'],
        inputModalities: ['text', 'image']
      })
    );
    expect(a.editorialNote).toMatch(/Nano Banana/);
  });
});
