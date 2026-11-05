// Software plates (title page, The End, back cover): deterministic, free, never overflowing.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { fitPlateText, MADE_WITH, plateLayout, PLATE_WIDTH } from './plates';
import { PlateView } from './PlateView';

const inside = (t: { lines: string[]; fontSize: number; lineGap: number; box: { x: number; y: number; w: number; h: number } }) =>
  t.lines.length * t.lineGap <= t.box.h + 0.5 && t.box.x >= 0 && t.box.x + t.box.w <= PLATE_WIDTH;

describe('plateLayout', () => {
  it('is deterministic and sized to the book page', () => {
    const doc = makeSampleDoc();
    doc.format = { ...doc.format, pageAspect: '4:5' };
    const a = plateLayout(doc, 'title');
    expect(plateLayout(doc, 'title')).toEqual(a);
    expect(a).toMatchObject({ width: 1000, height: 1250, kind: 'title' });
    expect(a.texts.map((t) => t.id)).toEqual(['title', 'subtitle']);
    expect(a.texts[0].lines.join(' ')).toBe('Rooftop Heist');
    expect(a.texts[1].lines.join(' ')).toBe('A cat burglar meets her match.');
    expect(a.alt).toBe('Title page: Rooftop Heist');
  });

  it('shrinks a long title to fit and ellipsizes only past the minimum size — never overflows', () => {
    const doc = makeSampleDoc();
    doc.cover = { ...doc.cover, title: 'The Extraordinarily Long and Winding Saga of the Rooftop Heist That Never Ended '.repeat(6) };
    const title = plateLayout(doc, 'title').texts[0];
    expect(title.fontSize).toBeLessThan(92);
    expect(inside(title)).toBe(true);
    expect(title.truncated).toBe(true);
    expect(title.lines[title.lines.length - 1].endsWith('…')).toBe(true);
    const short = fitPlateText({ id: 'x', text: 'Hi', box: { x: 0, y: 0, w: 500, h: 200 }, maxSize: 60, minSize: 20, lineHeight: 1.2, font: 'display', weight: 700, tone: 'ink', lang: 'en' })!;
    expect(short).toMatchObject({ lines: ['Hi'], fontSize: 60, truncated: false });
    expect(fitPlateText({ id: 'e', text: '   ', box: { x: 0, y: 0, w: 1, h: 1 }, maxSize: 1, minSize: 1, lineHeight: 1, font: 'body', weight: 400, tone: 'ink', lang: 'en' })).toBeNull();
  });

  it('The End lists the author’s credits (software never adds the owner’s name)', () => {
    const doc = makeSampleDoc({ book: { titlePage: false, endPage: true, backCover: 'none', firstPageRight: true, uniformTrim: true, credits: ['Story: Asha', 'Lettering: the studio'] } });
    const end = plateLayout(doc, 'end');
    expect(end.texts.map((t) => t.lines.join(' '))).toEqual(['The End', 'Story: Asha', 'Lettering: the studio', MADE_WITH]);
    expect(end.texts.every(inside)).toBe(true);
  });

  it('the back cover frames the drawn cover art and the blurb (logline by default); RTL text keeps its direction', () => {
    const doc = makeSampleDoc();
    expect(plateLayout(doc, 'back_cover').art).toBeUndefined();
    doc.cover = { ...doc.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/p/cover.webp', source: 'generated', at: 1, w: 800, h: 1200 } } };
    const back = plateLayout(doc, 'back_cover');
    expect(back.art).toMatchObject({ path: 'u/x/p/cover.webp' });
    expect(back.art!.x + back.art!.w).toBeLessThanOrEqual(PLATE_WIDTH);
    expect(back.texts.find((t) => t.id === 'blurb')?.lines.join(' ')).toBe('A cat burglar meets her match.');
    const blocked = { ...doc, cover: { ...doc.cover, render: { ...doc.cover.render, asset: { ...doc.cover.render.asset!, safety: { assessed: 'X', at: 1 } as never } } } };
    expect(plateLayout(blocked, 'back_cover').art).toBeUndefined();
    const ar = makeSampleDoc();
    ar.format = { ...ar.format, language: 'ar' };
    ar.brief = { ...ar.brief, logline: 'قصة قصيرة عن قطة' };
    expect(plateLayout(ar, 'back_cover').texts.find((t) => t.id === 'blurb')?.dir).toBe('rtl');
  });
});

describe('PlateView', () => {
  it('renders escaped text in an SVG with an accessible name', () => {
    const doc = makeSampleDoc();
    doc.brief = { ...doc.brief, title: '<img src=x onerror=alert(1)>' };
    const { container, getByRole } = render(<PlateView doc={doc} kind="title" />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('Title page: <img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('text')?.textContent).toContain('<img');
  });
});
