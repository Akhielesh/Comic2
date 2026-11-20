// @vitest-environment node
// The alert copy (notify SPEC §5.4): fixed phrases around the person's own title and counts, for every kind and the
// summary. No price, no "$", no usage share, no model text, for any user (the governed rule holds by construction).
import { describe, expect, it } from 'vitest';
import { PRICE_TEXT } from '../../tests/config/priceDetect';
import { ALERT_KINDS, type AlertDraft, type AlertKind } from './types';
import { ALERT_TITLE_MAX, alertCopy, alertShort, clipTitle, summaryCopy } from './copy';

const comic = (kind: AlertKind, extra: Partial<AlertDraft> = {}): AlertDraft => ({
  kind,
  key: `k:${kind}`,
  target: { app: kind.startsWith('chat_') ? 'chat' : 'comic', id: 'p1' },
  title: kind.startsWith('chat_') ? 'Weekend plans' : 'Spice Market',
  ...extra
});

/** Words a governed person must never meet in an alert. */
const MONEY_WORDS = /\$|¢|\busage\b|\bcredits?\b|\bcost\b|\bprice\b|\bspend\b|\bspent\b|\bcharged?\b|\bdollars?\b|\bcents?\b/i;

describe('alertCopy', () => {
  it('renders every kind with a title and a message', () => {
    for (const kind of ALERT_KINDS) {
      const copy = alertCopy(comic(kind, { count: 3, failedCount: 1, languages: ['es', 'fr'], imageCount: 4 }));
      expect(copy.title.length, kind).toBeGreaterThan(0);
      expect(copy.message.length, kind).toBeGreaterThan(0);
    }
  });

  it('uses the fixed phrases of the table', () => {
    expect(alertCopy(comic('reply'))).toEqual({ title: 'The Director replied', message: 'Spice Market' });
    expect(alertCopy(comic('question'))).toEqual({ title: 'The Director has a question', message: 'Spice Market' });
    expect(alertCopy(comic('plan'))).toEqual({ title: 'Your page plan is ready for your OK', message: 'Spice Market' });
    expect(alertCopy(comic('approval', { imageCount: 6 }))).toEqual({
      title: 'Waiting for your OK',
      message: 'Spice Market: ready to draw 6 pictures when you say so'
    });
    expect(alertCopy(comic('approval', { imageCount: 1 })).message).toBe('Spice Market: ready to draw 1 picture when you say so');
    expect(alertCopy(comic('approval')).message).toBe('Spice Market: ready to draw when you say so');
    expect(alertCopy(comic('style'))).toEqual({ title: 'Looks are ready to pick from', message: 'Spice Market' });
    expect(alertCopy(comic('drawn', { count: 6 }))).toEqual({ title: 'Pages are ready', message: 'Spice Market: 6 drawn' });
    expect(alertCopy(comic('drawn', { count: 2, pictures: true }))).toEqual({ title: 'Pictures are ready', message: 'Spice Market: 2 drawn' });
    expect(alertCopy(comic('drawn_issues', { count: 5, failedCount: 1 }))).toEqual({
      title: 'Some pictures need a look',
      message: 'Spice Market: 5 drawn, 1 needs a look'
    });
    expect(alertCopy(comic('drawn_issues', { count: 0, failedCount: 2 })).message).toBe('Spice Market: 0 drawn, 2 need a look');
    expect(alertCopy(comic('translated', { languages: ['es'] }))).toEqual({ title: 'Translation ready', message: 'Spice Market: Spanish' });
    expect(alertCopy(comic('translated', { languages: ['es', 'fr', 'de', 'ja', 'ko'] })).message).toBe('Spice Market: Spanish, French, German +2');
    expect(alertCopy(comic('translate_issues', { languages: ['fr'] }))).toEqual({ title: 'A translation needs a look', message: 'Spice Market: French' });
    expect(alertCopy(comic('published'))).toEqual({ title: 'Your comic is live', message: 'Spice Market' });
    expect(alertCopy(comic('publish_failed'))).toEqual({ title: "Couldn't publish", message: 'Spice Market' });
    expect(alertCopy(comic('failed'))).toEqual({ title: 'Something stopped', message: 'Spice Market. Open it to see what happened.' });
    expect(alertCopy(comic('chat_reply'))).toEqual({ title: 'Answer ready', message: 'Weekend plans' });
    expect(alertCopy(comic('chat_question'))).toEqual({ title: 'Chat has a question for you', message: 'Weekend plans' });
    expect(alertCopy(comic('chat_confirm'))).toEqual({ title: 'Waiting for you to confirm', message: 'Weekend plans' });
    expect(alertCopy(comic('chat_failed'))).toEqual({ title: "Chat couldn't finish", message: 'Weekend plans' });
  });

  it('an unknown language tag reads as itself, never as nothing', () => {
    expect(alertCopy(comic('translated', { languages: ['xx-YY'] })).message).toBe('Spice Market: xx-YY');
    expect(alertCopy(comic('translated', { languages: [] })).message).toBe('Spice Market');
  });

  it('no output matches the price or governed-share patterns, and none says usage, credit or cost', () => {
    const outputs: string[] = [];
    for (const kind of ALERT_KINDS) {
      for (const extra of [{}, { count: 0 }, { count: 12, failedCount: 3, pictures: true }, { imageCount: 9, languages: ['es', 'te', 'hi', 'ar'] }]) {
        const c = alertCopy(comic(kind, extra));
        outputs.push(c.title, c.message, alertShort(comic(kind, extra)));
      }
    }
    const summary = summaryCopy(ALERT_KINDS.map((k) => comic(k, { count: 2 })));
    outputs.push(summary.title, summary.message);
    for (const text of outputs) {
      expect(PRICE_TEXT.test(text), text).toBe(false);
      expect(MONEY_WORDS.test(text), text).toBe(false);
    }
  });
});

describe('clipTitle', () => {
  it('clips the person’s title at 48 characters with an ellipsis, on whole characters', () => {
    const long = 'The Extraordinary and Slightly Unbelievable Adventures of Captain Paprika';
    const clipped = clipTitle(long, 'comic');
    expect(Array.from(clipped)).toHaveLength(ALERT_TITLE_MAX);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipTitle('x'.repeat(48), 'comic')).toBe('x'.repeat(48));
    // Emoji are never cut in half.
    const emoji = '🦊'.repeat(60);
    expect(Array.from(clipTitle(emoji, 'comic'))).toHaveLength(ALERT_TITLE_MAX);
    expect(clipTitle(emoji, 'comic')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('untitled and blank titles read "Your comic" / "Your chat"; whitespace folds to one space', () => {
    expect(clipTitle('', 'comic')).toBe('Your comic');
    expect(clipTitle('   ', 'chat')).toBe('Your chat');
    expect(clipTitle(undefined, 'comic')).toBe('Your comic');
    expect(clipTitle('Untitled comic', 'comic')).toBe('Your comic');
    expect(clipTitle('New chat', 'chat')).toBe('Your chat');
    expect(clipTitle('  Spice\n\tMarket  ', 'comic')).toBe('Spice Market');
    expect(alertCopy({ kind: 'reply', key: 'k', target: { app: 'comic', id: 'p' } }).message).toBe('Your comic');
    expect(alertCopy({ kind: 'chat_reply', key: 'k', target: { app: 'chat', id: 'c' }, title: '' }).message).toBe('Your chat');
  });
});

describe('summaryCopy', () => {
  it('"{n} updates", naming up to two titles with their short phrase, most urgent first', () => {
    const s = summaryCopy([comic('reply', { title: 'Spice Market' }), comic('question', { title: 'Night Shift' }), comic('chat_reply', { title: 'Recipes' })]);
    expect(s.title).toBe('3 updates');
    expect(s.message).toBe('Night Shift: has a question. Recipes: answer ready. And 1 more.');
    const two = summaryCopy([comic('drawn', { count: 6 }), comic('chat_reply', { title: 'Recipes' })]);
    expect(two).toEqual({ title: '2 updates', message: 'Recipes: answer ready. Spice Market: pages ready.' });
  });
});
