// The classic generator's finish (notify NF-4): it plays the alert core's Ready chime through the person's Alerts
// settings, and no longer makes an audio context of its own (the old beep made a new one on every finish and never
// closed it).
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ playChimeNow: vi.fn(async () => true) }));
vi.mock('../services/alerts/bus', () => bus);

import { ComicGenerator } from './ComicGenerator';
import type { ComicState } from '../types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  bus.playChimeNow.mockClear();
});

describe('ComicGenerator finish', () => {
  it('plays the Ready chime once, with no audio context of its own', () => {
    const made = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          made();
        }
      }
    );
    const onGenerationComplete = vi.fn();
    const state = {
      panels: [],
      generationStatus: { isActive: false, progress: 100, currentStepDescription: 'Complete' }
    } as unknown as ComicState;
    const view = render(<ComicGenerator state={state} onStart={vi.fn()} onCancel={vi.fn()} onGenerationComplete={onGenerationComplete} />);
    expect(onGenerationComplete).toHaveBeenCalledTimes(1);
    expect(bus.playChimeNow).toHaveBeenCalledTimes(1);
    expect(bus.playChimeNow).toHaveBeenCalledWith('ready');
    expect(made).not.toHaveBeenCalled();
    view.rerender(<ComicGenerator state={{ ...state }} onStart={vi.fn()} onCancel={vi.fn()} onGenerationComplete={onGenerationComplete} />);
    expect(bus.playChimeNow).toHaveBeenCalledTimes(1);
  });
});
