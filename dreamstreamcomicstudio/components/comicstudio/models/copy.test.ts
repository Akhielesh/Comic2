// Exact copy (models.md §3.6 A–F, §4.6): every string the picker, the confirms and the lock line show, snapshotted
// word for word. A wording change must be made here on purpose. Both confirms carry the owner's required words
// "consistency can be affected"; the disabled reasons and warnings agree with what shared modelFit writes.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { modelFit } from '../../../shared/comic/modelLock';
import { getImageModel } from '../../../shared/comic/models';
import * as copy from './copy';
import { lakeDoc } from './testing/fixtures';

const ALL = { pages: 5, sheets: 4, places: 0, cover: true };

describe('A. lock line', () => {
  it('locked / unlocked lines, links and the lock icon label', () => {
    expect(copy.lockedLine('Nano Banana 2.1')).toBe('Drawn with Nano Banana 2.1 · locked for this comic');
    expect(copy.unlockedLine('Nano Banana 2.1')).toBe('Will draw with Nano Banana 2.1 · locks when the first image is drawn');
    expect(copy.CHANGE_LINK).toBe('Change…');
    expect(copy.CHOOSE_LINK).toBe('Choose model…');
    expect(copy.LOCK_ICON_LABEL).toBe('Model locked so every page matches');
  });
});

describe('B. picker sheet', () => {
  it('title, subtitles, badges and row lines', () => {
    expect(copy.PICKER_TITLE).toBe('Image model');
    expect(copy.pickerSubtitleLocked('Nano Banana 2.1')).toBe('This comic is drawn with Nano Banana 2.1. Changing it can affect consistency.');
    expect(copy.PICKER_SUBTITLE_UNLOCKED).toBe('Pick before the first image. The model then stays the same for every page.');
    expect([copy.BADGE.default, copy.BADGE.experimental, copy.BADGE.current]).toEqual(['Default', 'Experimental', 'Current']);
    expect(copy.perPage('≈$0.05', '1K')).toBe('≈$0.05 per page at 1K');
    expect(copy.holdsCharacters(4)).toBe('Holds 4 characters per image');
    expect(copy.holdsCharacters(1)).toBe('Holds 1 character per image');
    expect(copy.providersLine(1, '97.7')).toBe('1 provider · 97.7% up (24 h)');
    expect(copy.providersLine(3, '99.1')).toBe('3 providers · 99.1% up (24 h)');
    expect(copy.leaderboardsLine([copy.lmarenaEdit(5), copy.aaEdit(4)])).toBe('Leaderboards: LMArena edit #5 · AA edit #4');
    expect(copy.COMPARE_ALL).toBe('Compare all models');
    // Pro table: priced resolutions, then the ones without a price with the §4.6 reason.
    expect(copy.pricesByRes(['1K ≈$0.06', '4K ≈$0.15'])).toBe('Per page: 1K ≈$0.06 · 4K ≈$0.15');
    expect(copy.pricesMissingAt(['2K'], copy.PRICE_UNPUBLISHED)).toBe("2K: Price per image isn't published · you'll see the real cost after the first image");
  });

  it('disabled reasons, the warning and the footer', () => {
    expect(copy.DISABLED.aspect('4:5')).toBe("Can't draw 4:5 pages");
    expect(copy.DISABLED.access).toBe('Needs a paid plan or your own key');
    expect(copy.DISABLED.unavailable).toBe('Not available in Comic Studio yet');
    expect(copy.PRICE_UNPUBLISHED_WARNING).toBe("Price per image isn't published, so you'll see the real cost after the first image");
    expect(
      copy.pickerFooter({
        prices: copy.pricesOpenRouter('5 min ago'),
        rankings: [copy.rankingLmarena('Oct 20, 2026'), copy.rankingAa('Oct 22, 2026', true)]
      })
    ).toBe('Prices: OpenRouter, 5 min ago · Rankings: LMArena (Oct 20, 2026), Artificial Analysis via OpenRouter (Oct 22, 2026)');
    // "via OpenRouter" only when the data really came through OpenRouter.
    expect(copy.rankingAa('Oct 22, 2026', false)).toBe('Artificial Analysis (Oct 22, 2026)');
  });

  it('agrees with the reasons shared modelFit writes (one wording on both sides)', () => {
    const doc = lakeDoc({ page3Cast: 5 });
    const gpt = modelFit(getImageModel('gpt-image-2.5')!, doc, { ...DEFAULT_CAPS, modelOverride: true });
    expect(gpt.find((f) => f.code === 'aspect')?.text).toBe(copy.DISABLED.aspect('4:5'));
    expect(gpt.find((f) => f.code === 'hidden')?.text).toBe(copy.DISABLED.unavailable);
    const pro = modelFit(getImageModel('nano-banana-pro')!, doc, DEFAULT_CAPS);
    expect(pro.find((f) => f.code === 'access')?.text).toBe(copy.DISABLED.access);
    const nb = modelFit(getImageModel('nano-banana-2.1')!, doc, DEFAULT_CAPS);
    expect(nb.find((f) => f.code === 'characters')?.text).toBe(copy.WARN.characters('Nano Banana 2.1', 4, 3, 5));
  });
});

describe('C. confirm after the lock', () => {
  it('title, lead (with the required words), what is drawn, the three choices', () => {
    expect(copy.confirmTitleLocked('Nano Banana Pro')).toBe('Switch this comic to Nano Banana Pro?');
    expect(copy.confirmLeadText('Nano Banana 2.1', ALL)).toBe(
      'Your pages, character sheets and cover were drawn with Nano Banana 2.1. A different model draws faces, colors and line work its own way, so character consistency can be affected.'
    );
    expect(copy.confirmLead('Nano Banana 2.1', ALL).emphasis).toBe('character consistency can be affected');
    // Only what was drawn is named.
    expect(copy.confirmLeadText('Nano Banana 2.1', { pages: 0, sheets: 2, places: 0, cover: false })).toMatch(/^Your character sheets were drawn with/);
    expect(copy.alreadyDrawn('Nano Banana 2.1', ALL)).toBe('Already drawn with Nano Banana 2.1: 5 pages · 4 character sheets · cover');
    expect(copy.alreadyDrawn('Nano Banana 2.1', { pages: 1, sheets: 0, places: 0, cover: false })).toBe('Already drawn with Nano Banana 2.1: 1 page');
    expect(copy.SCOPE_GROUP_LABEL).toBe('What should happen to the drawn images?');
    expect(copy.SCOPE_KEEP.label).toBe('Keep them as they are');
    expect(copy.SCOPE_KEEP.sub('Nano Banana Pro')).toBe('New pages and redraws use Nano Banana Pro. The book may look mixed.');
    expect(copy.SCOPE_KEEP.price).toBe('Free now');
    expect(copy.SCOPE_PAGES_COVER.label).toBe('Redraw the pages and cover');
    expect(copy.SCOPE_PAGES_COVER.sub(5, true, true, 'Nano Banana Pro')).toBe('5 pages + cover on Nano Banana Pro. Character sheets stay.');
    expect(copy.SCOPE_ALL.label).toBe('Redraw everything');
    expect(copy.SCOPE_ALL.sub(ALL)).toBe('Pages, cover and 4 character sheets.');
  });

  it('facts, warnings, buttons and fine print', () => {
    expect(copy.newModelFacts('Nano Banana Pro', '≈$0.18', '1K', 5, '3 providers · 99.1% up (24 h)')).toBe(
      'Nano Banana Pro: ≈$0.18 per page at 1K · holds up to 5 characters per image · 3 providers · 99.1% up (24 h)'
    );
    expect(copy.currentModelFacts('Nano Banana 2.1', '≈$0.05', '1K')).toBe('Nano Banana 2.1: ≈$0.05 per page at 1K');
    // No price: the §4.6 words for why — no number and no "$".
    expect(copy.currentModelFacts('X', null, '2K')).toBe("X: Price per image isn't published · you'll see the real cost after the first image");
    expect(copy.currentModelFacts('X', null, '2K', copy.NO_OPENROUTER_PRICE)).toBe("X: OpenRouter doesn't list a price for this model");
    expect(copy.newModelFacts('Seedream 5 Pro', null, '2K', 4, copy.NO_UPTIME)).toBe(
      "Seedream 5 Pro: Price per image isn't published · you'll see the real cost after the first image · holds up to 4 characters per image · No uptime data right now"
    );
    expect(copy.WARN.characters('Nano Banana 2.1', 4, 3, 5)).toBe('Nano Banana 2.1 holds up to 4 characters per image; page 3 has 5.');
    expect(copy.WARN.resolution('GPT Image 2.5', '2K', { w: 1024, h: 1536, w0: 1696, h0: 2528 })).toBe(
      'GPT Image 2.5 has no 2K option here. Pages come back 1024×1536 (yours are 1696×2528).'
    );
    expect(copy.WARN.experimental).toBe('Experimental in Comic Studio.');
    expect(copy.WARN.estimate('GPT Image 2.5')).toBe("This redraw total is an estimate: GPT Image 2.5's per-image price isn't published.");
    expect(copy.WARN.noBasis).toBe("We can't price this redraw yet. The first image will show the real cost.");
    expect(copy.WARN.overBudget('≈$0.42')).toBe('This is over your budget by ≈$0.42.');
    expect(copy.keepButton('Nano Banana 2.1')).toBe('Keep Nano Banana 2.1');
    expect(copy.switchButton('Nano Banana Pro')).toBe('Switch to Nano Banana Pro');
    expect(copy.switchRedrawButton('≈$1.07')).toBe('Switch and redraw · ≈$1.07');
    expect(copy.switchRedrawButton(null)).toBe('Switch and redraw');
    expect(copy.confirmFinePrint(copy.basisLine(['OpenRouter, 5 min ago']), true)).toBe('Prices: OpenRouter, 5 min ago. Paid by your own key. You can switch back the same way.');
    expect(copy.confirmFinePrint(copy.basisLine(['OpenRouter, 5 min ago']), false)).toBe('Prices: OpenRouter, 5 min ago. You can switch back the same way.');
  });

  it('what the dialog says when the switch does not complete (not §3.6 copy; claims no outcome it cannot know)', () => {
    expect(copy.SWITCH_STOPPED).toBe(
      'The switch was stopped before it finished, so it may not have gone through. Check which model this comic shows before trying again.'
    );
    expect(copy.SWITCH_FAILED).toBe("The switch didn't go through. Nothing was changed.");
    expect(copy.SWITCH_IN_FLIGHT).toBe('That is already being sent — give it a moment.');
  });
});

describe('D. confirm before the lock', () => {
  it('title, body (with the required words) and buttons', () => {
    expect(copy.confirmTitleUnlocked('Nano Banana Pro')).toBe('Draw this comic with Nano Banana Pro?');
    expect(copy.confirmBodyUnlocked('Nano Banana Pro')).toBe(
      'Every image in a comic uses one model so characters stay consistent. Nano Banana Pro will be locked for this comic when the first image is drawn. If you change it later, character consistency can be affected.'
    );
    expect(copy.useButton('Nano Banana Pro')).toBe('Use Nano Banana Pro');
  });

  it('C and D both say "consistency can be affected"', () => {
    expect(copy.confirmLeadText('A', ALL)).toContain('consistency can be affected');
    expect(copy.confirmBodyUnlocked('B')).toContain('consistency can be affected');
  });
});

describe('E. tier change after the lock', () => {
  it('title, body and buttons', () => {
    expect(copy.tierConfirmTitle('2K')).toBe('Draw new pages at 2K?');
    expect(copy.tierConfirmBody('Nano Banana 2.1', 5, '1K')).toBe(
      'Same model (Nano Banana 2.1), so characters stay consistent. The 5 pages already drawn stay at 1K unless you redraw them.'
    );
    expect(copy.tierConfirmBody('Nano Banana 2.1', 1, '1K')).toBe(
      'Same model (Nano Banana 2.1), so characters stay consistent. The 1 page already drawn stays at 1K unless you redraw it.'
    );
    expect(copy.tierConfirmBody('Nano Banana 2.1', 0, '1K')).toBe('Same model (Nano Banana 2.1), so characters stay consistent.');
    expect(copy.TIER_CANCEL).toBe('Cancel');
    // QualityPanel lines after the lock (not §3.6 copy).
    expect(copy.sameModelTierLine('2K')).toBe('Same model, 2K pages.');
    expect(copy.STYLE_OPTIONS_LOCKED).toBe('Style options use a quick 1K draft on the same model.');
    expect(copy.STYLE_OPTIONS_UNLOCKED).toBe('Style options always use a quick 1K draft.');
    expect(copy.tierUseButton('Standard')).toBe('Use Standard');
  });
});

describe('F. notice after a switch', () => {
  it('text and chips', () => {
    expect(copy.switchedNotice('Nano Banana Pro', 'Nano Banana 2.1', 5, true)).toBe(
      'Switched to Nano Banana Pro. 5 pages and the cover were drawn with Nano Banana 2.1 and stay as they are.'
    );
    // One image reads in the singular (a single page, or the cover alone).
    expect(copy.switchedNotice('Nano Banana Pro', 'Nano Banana 2.1', 1, false)).toBe(
      'Switched to Nano Banana Pro. 1 page was drawn with Nano Banana 2.1 and stays as it is.'
    );
    expect(copy.switchedNotice('Nano Banana Pro', 'Nano Banana 2.1', 0, true)).toBe(
      'Switched to Nano Banana Pro. The cover was drawn with Nano Banana 2.1 and stays as it is.'
    );
    expect(copy.switchedNotice('Nano Banana Pro', 'Nano Banana 2.1', 2, false)).toBe(
      'Switched to Nano Banana Pro. 2 pages were drawn with Nano Banana 2.1 and stay as they are.'
    );
    expect(copy.switchedNotice('Nano Banana Pro', 'Nano Banana 2.1', 1, true)).toBe(
      'Switched to Nano Banana Pro. 1 page and the cover were drawn with Nano Banana 2.1 and stay as they are.'
    );
    expect(copy.switchedNotice('Nano Banana Pro', 'Nano Banana 2.1', 0, false)).toBe('Switched to Nano Banana Pro.');
    expect(copy.switchedRedrawingNotice('Nano Banana Pro', 5, true, '≈$1.07')).toBe('Switched to Nano Banana Pro. Redrawing 5 pages and the cover (≈$1.07)…');
    expect(copy.redrawThemChip('≈$1.07')).toBe('Redraw them · ≈$1.07');
    expect(copy.switchBackChip('Nano Banana 2.1')).toBe('Switch back to Nano Banana 2.1');
  });
});

describe('§4.6 missing data', () => {
  it('exact copy for every unavailable state', () => {
    expect(copy.PRICE_UNPUBLISHED).toBe("Price per image isn't published · you'll see the real cost after the first image");
    expect(copy.NO_OPENROUTER_PRICE).toBe("OpenRouter doesn't list a price for this model");
    expect(copy.asOfCouldntRefresh('16:52')).toBe("as of 16:52 · couldn't refresh");
    expect(copy.fromPriceList('2026-10-22')).toBe('from our price list, 2026-10-22');
    expect(copy.NO_UPTIME).toBe('No uptime data right now');
    expect(copy.NOT_RANKED).toBe('Not ranked on public leaderboards yet');
    expect(copy.NOT_ENOUGH_DATA).toBe('Not enough data yet');
  });

  it('times and dates read from the clock passed in', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(copy.ago(now - 10_000, now)).toBe('just now');
    expect(copy.ago(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
    expect(copy.ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(copy.ago(undefined, now)).toBe('time unknown');
    expect(copy.dateLabel('2026-10-20')).toBe('Oct 20, 2026');
    expect(copy.uptimeText(97.72)).toBe('97.7');
    expect(copy.uptimeText(100)).toBe('100');
  });
});
