import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel } from '../../types';
import type { PanelThumbnail } from '../../services/classicArtworkComparison';
import { ClassicPanelComparison } from './ClassicPanelComparison';

const scan = vi.hoisted(() => vi.fn());
vi.mock('../../services/classicArtworkComparison', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/classicArtworkComparison')>(), scanPanelWindow: scan
}));
vi.mock('../../services/db', () => ({ getImageUrl: vi.fn() }));

const panels = Array.from({ length: 5 }, (_, i): ComicPanel => ({
  id: String(i), sceneId:1, dialogue:'', description:`Artwork ${i + 1}`, imageIdHistory:[], ...(i === 3 ? {} : {imageId:`image${i}`})
}));
const image = (pattern: number[]): PanelThumbnail => ({ url:'data:image/png;base64,AAA=', aspect:1, pixels:new Uint8ClampedArray(pattern.flatMap(v => [v,v,v,255])) });

beforeEach(() => {
  scan.mockReset();
  scan.mockImplementation(async (_panels, _resolve, _signal, onImage) => {
    [image([0,255]),image([2,251]),image([255,0]),null,image([0,255])].forEach((thumb,i) => onImage(i,thumb));
  });
});

describe('classic creator side-by-side review', () => {
  it('scans only on request and keeps missing panels in their actual reading order', async () => {
    render(<ClassicPanelComparison panels={panels}/>);
    expect(scan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Compare artwork'}));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 possible repeats'));
    const pair = within(screen.getByRole('group',{name:'Selected artwork comparison'}));
    expect(pair.getByRole('img',{name:'Artwork 1'})).toBeVisible();
    expect(pair.getByRole('img',{name:'Artwork 2'})).toBeVisible();
    fireEvent.change(screen.getByRole('combobox',{name:/Possible repeats/}), { target:{ value:'0' } });
    expect(pair.getByRole('img',{name:'Artwork 5'})).toBeVisible();
    fireEvent.change(screen.getByRole('combobox',{name:'Adjacent panels'}), { target:{ value:'3' } });
    expect(pair.getByText('No artwork saved.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('4 of 5 panels were readable.');
    const signal = scan.mock.calls[0][2] as AbortSignal;
    fireEvent.click(screen.getByRole('button',{name:'Close comparison'}));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps a project with fewer than two image sources in the existing review experience', () => {
    render(<ClassicPanelComparison panels={panels.slice(0,1)}/>);
    expect(screen.queryByRole('button',{name:'Compare artwork'})).toBeNull();
    expect(scan).not.toHaveBeenCalled();
  });
});
