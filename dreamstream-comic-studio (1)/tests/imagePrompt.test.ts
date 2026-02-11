import { describe, it, expect } from 'vitest';
import { buildImagePrompt, ImagePromptOptions } from '../services/imagePrompt';

describe('buildImagePrompt', () => {
  it('should generate a style prompt', () => {
    const options: ImagePromptOptions = {
      stage: 'style',
      stylePrompt: 'Noir',
      projectTitle: 'My Project'
    };
    const result = buildImagePrompt(options);
    expect(result).toContain('Comic panel style preview.');
    expect(result).toContain('Style: Noir');
    expect(result).toContain('Project: My Project');
  });

  it('should generate a page grid prompt', () => {
    const options: ImagePromptOptions = {
      stage: 'page_grid',
      panels: [
        { index: 0, description: 'Panel 1 desc' },
        { index: 1, description: 'Panel 2 desc' }
      ]
    };
    const result = buildImagePrompt(options);
    expect(result).toContain('Comic page layout with a 2x2 grid');
    expect(result).toContain('Panel 1: Panel 1 desc');
    expect(result).toContain('Panel 2: Panel 2 desc');
  });
});
