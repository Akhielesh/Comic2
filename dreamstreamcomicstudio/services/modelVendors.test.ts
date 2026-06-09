import { describe, it, expect } from 'vitest';
import { getModelVendor, getModelVendorId, availableVendors, vendorSlug } from './modelVendors';

describe('modelVendors', () => {
  it('derives the vendor from the model-id org slug', () => {
    expect(getModelVendorId({ id: 'anthropic/claude-sonnet-4' })).toBe('anthropic');
    expect(getModelVendorId({ id: 'openai/gpt-4o-mini' })).toBe('openai');
    expect(getModelVendorId({ id: 'google/gemini-2.5-flash' })).toBe('google');
    expect(getModelVendorId({ id: 'deepseek/deepseek-chat-v3.1' })).toBe('deepseek');
    expect(getModelVendorId({ id: 'ideogram/ideogram-v2-turbo' })).toBe('ideogram');
  });

  it('maps alias slugs to the canonical vendor (z-ai -> zai, meta-llama -> meta)', () => {
    expect(getModelVendorId({ id: 'z-ai/glm-4.6' })).toBe('zai');
    expect(getModelVendorId({ id: 'meta-llama/llama-3.3-70b' })).toBe('meta');
    expect(getModelVendorId({ id: 'x-ai/grok-4' })).toBe('xai');
    expect(getModelVendorId({ id: 'black-forest-labs/flux-1.1-pro' })).toBe('black-forest-labs');
  });

  it('handles ids without a slash and unknown vendors', () => {
    expect(vendorSlug({ id: 'gpt-4o-mini' })).toBe('gpt-4o-mini');
    expect(getModelVendorId({ id: 'gpt-4o' })).toBe('openai'); // loose startsWith match
    expect(getModelVendor({ id: 'some-unknown-model' }).id).toBe('other');
  });

  it('counts available vendors most-common first', () => {
    const models = [
      { id: 'anthropic/claude-sonnet-4' },
      { id: 'anthropic/claude-haiku-4' },
      { id: 'openai/gpt-4o' },
    ];
    const vendors = availableVendors(models);
    expect(vendors[0].vendor.id).toBe('anthropic');
    expect(vendors[0].count).toBe(2);
    expect(vendors.find((v) => v.vendor.id === 'openai')?.count).toBe(1);
  });
});
