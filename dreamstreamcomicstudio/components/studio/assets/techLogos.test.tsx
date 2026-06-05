import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TemplateLogo } from './techLogos';

describe('TemplateLogo', () => {
  it('renders an svg for each known template, and falls back', () => {
    for (const template of ['react-ts', 'react', 'vanilla-ts', 'vanilla', 'static', 'unknown']) {
      const { container } = render(<TemplateLogo template={template} className="w-4 h-4" />);
      expect(container.querySelector('svg')).toBeTruthy();
    }
  });
});
