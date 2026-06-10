import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelProviderIcon, PROVIDER_ICONS, ProviderIcon, SourceIcon } from './ProviderIcon';
import { VENDOR_META } from '../../services/modelVendors';

describe('ProviderIcon', () => {
  it('renders a real SVG mark for every major vendor', () => {
    for (const id of ['anthropic', 'openai', 'google', 'deepseek', 'meta', 'mistral', 'qwen', 'nvidia', 'xai', 'microsoft']) {
      const { container, unmount } = render(<ProviderIcon vendorId={id} />);
      expect(container.querySelector('svg'), `expected an svg mark for ${id}`).toBeTruthy();
      unmount();
    }
  });

  it('every catalog vendor renders something (mark or monogram) without crashing', () => {
    for (const vendor of VENDOR_META) {
      const { container, unmount } = render(<ProviderIcon vendorId={vendor.id} />);
      expect(container.firstChild, `expected output for ${vendor.id}`).toBeTruthy();
      unmount();
    }
  });

  it('unknown vendors fall back to a monogram chip', () => {
    const { container } = render(<ProviderIcon vendorId="totally-unknown" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('O'); // "Other"
  });

  it('derives the vendor from a model id', () => {
    const { container } = render(<ModelProviderIcon model={{ id: 'anthropic/claude-sonnet-4.5' }} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders source gateway icons', () => {
    const or = render(<SourceIcon source="openrouter" />);
    expect(or.container.querySelector('svg')).toBeTruthy();
    const nv = render(<SourceIcon source="nvidia" />);
    expect(nv.container.querySelector('svg')).toBeTruthy();
  });

  it('keeps the icon map limited to canonical vendor ids', () => {
    const ids = new Set(VENDOR_META.map((v) => v.id));
    for (const key of Object.keys(PROVIDER_ICONS)) {
      expect(ids.has(key), `${key} is not a canonical vendor id`).toBe(true);
    }
  });
});
