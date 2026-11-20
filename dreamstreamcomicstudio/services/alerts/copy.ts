// The alert copy (notify SPEC §5.4): fixed phrases around the person's own comic or chat title and plain counts. No
// model-written text ever reaches an alert, so no price, no "$" and no usage share can either, for any user (a governed
// person never meets money here; copy.test.ts runs every kind through the price patterns). The action is always Open.

import { languageSpec } from '../../shared/comic/languages';
import { isFailureKind, isNeedsKind, type AlertApp, type AlertDraft } from './types';

/** Titles are clipped to this many characters (an ellipsis included). */
export const ALERT_TITLE_MAX = 48;

/** The names a fresh comic or chat starts with: they read as the generic "Your comic" / "Your chat". */
const UNTITLED = new Set(['untitled comic', 'untitled', 'new chat', 'new comic']);

/** The person's own title, folded to one line and clipped on whole characters; "Your comic" / "Your chat" when untitled. */
export function clipTitle(title: string | null | undefined, app: AlertApp): string {
  const folded = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!folded || UNTITLED.has(folded.toLowerCase())) return app === 'chat' ? 'Your chat' : 'Your comic';
  const chars = Array.from(folded);
  return chars.length <= ALERT_TITLE_MAX ? folded : `${chars.slice(0, ALERT_TITLE_MAX - 1).join('').trimEnd()}…`;
}

const count = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const pictures = (n: number): string => `${n} picture${n === 1 ? '' : 's'}`;
const languageName = (tag: string): string => languageSpec(tag)?.english ?? tag;
/** Up to three names, then "+N". */
const languageList = (tags: readonly string[] | undefined): string => {
  const names = (tags ?? []).filter((t) => typeof t === 'string' && t).map(languageName);
  if (!names.length) return '';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
};
const withDetail = (title: string, detail: string): string => (detail ? `${title}: ${detail}` : title);

export interface AlertCopy {
  title: string;
  message: string;
}

/** The toast's title and message for one alert. */
export function alertCopy(draft: AlertDraft): AlertCopy {
  const name = clipTitle(draft.title, draft.target.app);
  switch (draft.kind) {
    case 'reply':
      return { title: 'The Director replied', message: name };
    case 'question':
      return { title: 'The Director has a question', message: name };
    case 'plan':
      return { title: 'Your page plan is ready for your OK', message: name };
    case 'approval': {
      const n = count(draft.imageCount);
      return { title: 'Waiting for your OK', message: `${name}: ready to draw ${n ? `${pictures(n)} ` : ''}when you say so` };
    }
    case 'style':
      return { title: 'Looks are ready to pick from', message: name };
    case 'drawn':
      return { title: draft.pictures ? 'Pictures are ready' : 'Pages are ready', message: `${name}: ${count(draft.count)} drawn` };
    case 'drawn_issues': {
      const m = count(draft.failedCount);
      return { title: 'Some pictures need a look', message: `${name}: ${count(draft.count)} drawn, ${m} need${m === 1 ? 's' : ''} a look` };
    }
    case 'translated':
      return { title: 'Translation ready', message: withDetail(name, languageList(draft.languages)) };
    case 'translate_issues':
      return { title: 'A translation needs a look', message: withDetail(name, draft.languages?.length ? languageName(draft.languages[0]) : '') };
    case 'published':
      return { title: 'Your comic is live', message: name };
    case 'publish_failed':
      return { title: "Couldn't publish", message: name };
    case 'failed':
      return { title: 'Something stopped', message: `${name}. Open it to see what happened.` };
    case 'chat_reply':
      return { title: 'Answer ready', message: name };
    case 'chat_question':
      return { title: 'Chat has a question for you', message: name };
    case 'chat_confirm':
      return { title: 'Waiting for you to confirm', message: name };
    case 'chat_failed':
      return { title: "Chat couldn't finish", message: name };
    default:
      return { title: 'Something changed', message: name };
  }
}

/** The short phrase a summary uses after a title ("Spice Market: pages ready"). */
export function alertShort(draft: AlertDraft): string {
  switch (draft.kind) {
    case 'reply':
      return 'replied';
    case 'question':
    case 'chat_question':
      return 'has a question';
    case 'plan':
      return 'plan ready for your OK';
    case 'approval':
      return 'waiting for your OK';
    case 'style':
      return 'looks to pick';
    case 'drawn':
      return draft.pictures ? 'pictures ready' : 'pages ready';
    case 'drawn_issues':
      return 'some pictures need a look';
    case 'translated':
      return 'translation ready';
    case 'translate_issues':
      return 'a translation needs a look';
    case 'published':
      return 'live';
    case 'publish_failed':
      return "couldn't publish";
    case 'failed':
      return 'something stopped';
    case 'chat_reply':
      return 'answer ready';
    case 'chat_confirm':
      return 'waiting for you to confirm';
    case 'chat_failed':
      return "couldn't finish";
    default:
      return 'updated';
  }
}

/** Needs-you and failures first, then the newest (drafts are oldest first). */
export function byUrgency(drafts: readonly AlertDraft[]): AlertDraft[] {
  const urgent = (d: AlertDraft) => (isNeedsKind(d.kind) || isFailureKind(d.kind) ? 1 : 0);
  return drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => urgent(b.d) - urgent(a.d) || b.i - a.i)
    .map((x) => x.d);
}

/** "{n} updates", naming up to two titles with their short phrase, most urgent first. `total` counts alerts no longer kept. */
export function summaryCopy(drafts: readonly AlertDraft[], total = drafts.length): AlertCopy {
  const ranked = byUrgency(drafts);
  const named = ranked.slice(0, 2).map((d) => `${clipTitle(d.title, d.target.app)}: ${alertShort(d)}.`);
  const more = Math.max(0, total - named.length);
  return { title: `${total} updates`, message: [...named, ...(more ? [`And ${more} more.`] : [])].join(' ') };
}
