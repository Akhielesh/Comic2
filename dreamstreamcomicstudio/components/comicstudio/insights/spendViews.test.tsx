// One spend summary everywhere (models.md §5.1 M1-INSIGHTS-UI): the header's Spending sheet (ComicStudio
// SpendBreakdown), the board's Story tab (StoryTab SpendBreakdown) and the cost card list the same kinds in the
// same order — Translate included — through the shared SpendByKindList.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { quoteRenderPages, summarizeBook } from '../../../shared/comic/plan';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { SpendBreakdown as HeaderSpend, SPEND_KIND_LABELS } from '../ComicStudio';
import { SpendBreakdown as StorySpend } from '../board/StoryTab';
import { costFormatFor } from '../board/costFormat';
import { SPEND_KIND_LABEL } from '../board/boardModel';
import { costFormat } from '../conversation/cost';
import { resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';
import { CostInsights } from './CostInsights';

afterEach(() => resetUsageStatus());

const doc = () =>
  makeLakeComic((d) => {
    d.spend.byKind.translate = 0.02;
    d.spend.totalUsd += 0.02;
    d.spend.failed = { count: 2, usd: 0 };
  });

const kindsIn = (list: HTMLElement) => within(list).getAllByRole('listitem').map((li) => li.firstElementChild!.textContent);

describe('the shared spend summary', () => {
  it('the header sheet, the Story tab and the cost card list the same kinds in the same order, Translate included', () => {
    showDollarPrices();
    const d = doc();
    const header = render(<HeaderSpend doc={d} cost={costFormat(DOLLAR_CONTEXT)} />);
    const story = render(<StorySpend doc={d} cost={costFormatFor(DOLLAR_CONTEXT)} />);
    const book = summarizeBook(d, { byok: true, rating: 'PG-13' });
    const quote = quoteRenderPages(d, { byok: true, tier: d.settings.quality });
    const cardView = render(<CostInsights doc={d} book={book} quote={quote} byok pro={false} cost={costFormat(DOLLAR_CONTEXT)} coverLine="Drawn" runClientAction={() => {}} />);
    const expected = ['Pages', 'Cover', 'Character sheets', 'Quality checks', 'Director', 'Translations'];
    expect(kindsIn(within(header.container).getByRole('list', { name: 'Spend by kind' }))).toEqual(expected);
    expect(kindsIn(within(story.container).getByRole('list', { name: 'Spend by kind' }))).toEqual(expected);
    expect(kindsIn(within(cardView.container).getByRole('list', { name: 'Where it went' }))).toEqual(expected);
    // …and the failed attempts, which the header sheet and the Story tab now say too.
    expect(header.container).toHaveTextContent('Failed attempts: 2 · nothing charged');
    expect(story.container).toHaveTextContent('Failed attempts: 2 · nothing charged');
  });

  it('one vocabulary of kind names', () => {
    expect(SPEND_KIND_LABELS).toBe(SPEND_KIND_LABEL);
    expect(SPEND_KIND_LABELS.translate).toBe('Translations');
  });
});
